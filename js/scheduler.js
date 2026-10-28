export const DAY_MS = 24 * 60 * 60 * 1000;
export const RATINGS = Object.freeze({
  unknown: "unknown",
  fuzzy: "fuzzy",
  known: "known",
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createWordState(wordId, now = Date.now()) {
  return {
    id: wordId,
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    unknownCount: 0,
    fuzzyCount: 0,
    knownCount: 0,
    attemptCount: 0,
    difficultyScore: 5,
    difficultyLevel: 5,
    consecutiveMisses: 0,
    hardFlag: false,
    lastRating: null,
    recognitionStreak: 0,
    promotedToSpelling: false,
    promotedAt: null,
    spellingStreak: 0,
    firstSeenAt: now,
    lastReviewedAt: null,
    dueAt: now,
  };
}

function normalizeDifficultyScore(state) {
  if (Number.isFinite(state.difficultyScore)) {
    return state.difficultyScore;
  }
  const estimated =
    5 +
    (state.unknownCount || 0) * 2 +
    (state.fuzzyCount || 0) -
    (state.knownCount || 0) * 0.75;
  return clamp(estimated, 1, 10);
}

export function difficultyLevelOf(state) {
  if (!state) {
    return 5;
  }
  if (Number.isFinite(state.difficultyLevel)) {
    return clamp(Math.round(state.difficultyLevel), 1, 10);
  }
  return clamp(Math.round(normalizeDifficultyScore(state)), 1, 10);
}

export function applyRating(
  previousState,
  rating,
  now = Date.now(),
  responseMs = null,
  options = {},
) {
  if (!Object.values(RATINGS).includes(rating)) {
    throw new Error(`未知的单词评价：${rating}`);
  }

  const mode = options.mode === "spell" ? "spell" : "recognize";
  const promotable = options.promotable !== false;
  const state = {
    ...createWordState(previousState?.id || "", now),
    ...previousState,
  };
  state.difficultyScore = normalizeDifficultyScore(state);
  state.consecutiveMisses = state.consecutiveMisses || 0;
  state.attemptCount = (state.attemptCount || 0) + 1;
  state.lastReviewedAt = now;
  state.lastRating = rating;

  if (rating === RATINGS.unknown) {
    state.unknownCount += 1;
    state.lapses += 1;
    state.reps = 0;
    state.consecutiveMisses += 1;
    state.difficultyScore = clamp(state.difficultyScore + 2.5, 1, 10.9);
    state.ease = clamp(state.ease - 0.2, 1.3, 3.2);
    state.intervalDays = 0.25;
    state.dueAt = now + 6 * 60 * 60 * 1000;
  } else if (rating === RATINGS.fuzzy) {
    state.reps += 1;
    state.fuzzyCount += 1;
    state.consecutiveMisses += 1;
    state.difficultyScore = clamp(state.difficultyScore + 1.25, 1, 10.9);
    state.ease = clamp(state.ease - 0.05, 1.3, 3.2);
    state.intervalDays = state.reps <= 1
      ? 1
      : Math.max(1, Math.round(Math.max(1, state.intervalDays) * 1.4));
  } else {
    state.reps += 1;
    state.knownCount += 1;
    state.consecutiveMisses = 0;
    state.difficultyScore = clamp(
      state.difficultyScore -
        (Number.isFinite(responseMs) && responseMs < 5000 ? 1.5 : 1),
      1,
      10.9,
    );
    state.ease = clamp(state.ease + 0.04, 1.3, 3.2);

    if (state.reps === 1) {
      state.intervalDays = 1;
    } else if (state.reps === 2) {
      state.intervalDays = 3;
    } else {
      state.intervalDays = Math.round(
        Math.max(1, state.intervalDays) * state.ease,
      );
    }
  }

  if (mode === "recognize") {
    if (rating === RATINGS.known) {
      state.recognitionStreak = (state.recognitionStreak || 0) + 1;
      if (
        promotable &&
        state.recognitionStreak >= 3 &&
        !state.promotedToSpelling
      ) {
        state.promotedToSpelling = true;
        state.promotedAt = now;
      }
    } else {
      state.recognitionStreak = 0;
    }
  } else if (rating === RATINGS.known) {
    state.spellingStreak = (state.spellingStreak || 0) + 1;
  } else {
    state.spellingStreak = 0;
  }

  state.difficultyLevel = clamp(Math.ceil(state.difficultyScore), 1, 10);
  state.hardFlag = state.consecutiveMisses >= 3;

  if (rating === RATINGS.unknown && state.difficultyLevel < 4) {
    state.intervalDays = 0.25;
  } else if (state.difficultyLevel >= 6) {
    state.intervalDays = 1;
  } else if (state.difficultyLevel >= 4) {
    state.intervalDays = Math.min(Math.max(1, state.intervalDays), 2);
  }
  state.dueAt = now + state.intervalDays * DAY_MS;
  if (
    mode === "recognize" &&
    rating === RATINGS.known &&
    state.promotedToSpelling
  ) {
    state.intervalDays = 1;
    state.dueAt = now + DAY_MS;
  }
  return state;
}

export function isDue(wordState, now = Date.now()) {
  return !wordState || wordState.dueAt <= now;
}

export function reviewWeight(wordState, now = Date.now()) {
  const base =
    wordState.lastRating === RATINGS.unknown
      ? 100
      : wordState.lastRating === RATINGS.fuzzy
        ? 60
        : wordState.lastRating === RATINGS.known
          ? 20
          : 40;
  const overdueDays = Math.max(
    0,
    (now - (wordState.dueAt || now)) / DAY_MS,
  );
  return (
    base +
    Math.min(7, overdueDays) * 4 +
    (difficultyLevelOf(wordState) - 5) * 2 +
    (wordState.hardFlag ? 10 : 0)
  );
}

function sortReviewWords(wordStates, now) {
  return [...wordStates]
    .filter((state) => isDue(state, now))
    .sort((left, right) => {
      const weightDifference =
        reviewWeight(right, now) - reviewWeight(left, now);
      if (weightDifference !== 0) {
        return weightDifference;
      }
      return (left.dueAt || 0) - (right.dueAt || 0);
    });
}

function sortNewWords(words, knownIds) {
  return words
    .filter((word) => !knownIds.has(word.id))
    .sort((left, right) => {
      const leftSequence = left.sequence || Number.MAX_SAFE_INTEGER;
      const rightSequence = right.sequence || Number.MAX_SAFE_INTEGER;
      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      const leftRank = left.frequencyRank || Number.MAX_SAFE_INTEGER;
      const rightRank = right.frequencyRank || Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    });
}

export function wordBank(word) {
  const skills =
    Array.isArray(word?.skills) && word.skills.length
      ? word.skills
      : ["reading"];
  const reads = skills.includes("reading");
  const writes = skills.includes("writing");
  if (reads && writes) {
    return "shared";
  }
  if (writes) {
    return "spelling";
  }
  return "reading";
}

export function cardModeFor(word, wordState) {
  const bank = wordBank(word);
  if (bank === "spelling") {
    return wordState?.attemptCount ? "spell" : "recognize";
  }
  if (bank === "shared" && wordState?.promotedToSpelling) {
    return "spell";
  }
  return "recognize";
}

function interleaveReviewAndNew(reviews, newWords) {
  const result = [];
  let reviewIndex = 0;
  let newIndex = 0;
  while (reviewIndex < reviews.length || newIndex < newWords.length) {
    for (let index = 0; index < 2 && reviewIndex < reviews.length; index += 1) {
      result.push(reviews[reviewIndex]);
      reviewIndex += 1;
    }
    if (newIndex < newWords.length) {
      result.push(newWords[newIndex]);
      newIndex += 1;
    }
  }
  return result;
}

export function buildPlan({
  state = "normal",
  wordStates = [],
  words = [],
  sessionsSinceReading = 2,
  completedReadingCount = 0,
  daysSinceLastSession = 0,
  now = Date.now(),
}) {
  let effectiveState = state;
  if (state !== "tired" && daysSinceLastSession >= 5) {
    effectiveState = "recovery";
  }

  const counts = {
    energized: { newWords: 8, reviews: 28, minutes: 30 },
    normal: { newWords: 6, reviews: 24, minutes: 25 },
    tired: { newWords: 0, reviews: 12, minutes: 15 },
    recovery: { newWords: 0, reviews: 10, minutes: 15 },
  }[effectiveState] || { newWords: 6, reviews: 24, minutes: 25 };

  const readingEligible =
    effectiveState !== "tired" &&
    effectiveState !== "recovery" &&
    (completedReadingCount === 0 || sessionsSinceReading >= 2);

  const newLimit = readingEligible
    ? effectiveState === "energized" ? 5 : 3
    : counts.newWords;
  const reviewLimit = readingEligible
    ? effectiveState === "energized" ? 20 : 16
    : counts.reviews;

  const wordsById = new Map(words.map((word) => [word.id, word]));
  const knownIds = new Set(wordStates.map((wordState) => wordState.id));
  const dueReviews = sortReviewWords(wordStates, now);

  const recognizeReviews = [];
  const spellingReviews = [];
  for (const wordState of dueReviews) {
    if (recognizeReviews.length + spellingReviews.length >= reviewLimit) {
      break;
    }
    const word = wordsById.get(wordState.id);
    const cardMode = cardModeFor(word, wordState);
    const bank = wordBank(word);
    const task = {
      id: wordState.id,
      mode: "review",
      cardMode,
      bank,
    };
    if (cardMode === "spell") {
      spellingReviews.push(task);
    } else {
      recognizeReviews.push(task);
    }
  }

  const newWords = sortNewWords(words, knownIds)
    .slice(0, newLimit)
    .map((word) => ({
      id: word.id,
      mode: "new",
      cardMode: cardModeFor(word, null),
      bank: wordBank(word),
    }));

  spellingReviews.sort((left, right) => {
    const leftPriority = left.bank === "spelling" ? 2 : 1;
    const rightPriority = right.bank === "spelling" ? 2 : 1;
    return rightPriority - leftPriority;
  });

  const tasks = [
    ...interleaveReviewAndNew(recognizeReviews, newWords),
    ...spellingReviews,
  ];

  const readingNeeded = readingEligible && tasks.length < 34;
  let readingReason;
  if (readingNeeded) {
    readingReason = "本次加入一篇短阅读。";
  } else if (
    effectiveState === "tired" ||
    effectiveState === "recovery"
  ) {
    readingReason = "本次以轻量词汇复习为主，不增加阅读。";
  } else if (completedReadingCount > 0 && sessionsSinceReading < 2) {
    readingReason = "最近已完成阅读，本次优先巩固词汇。";
  } else {
    readingReason = "本次优先巩固词汇，下一次任务再安排阅读。";
  }

  let reason;
  if (effectiveState === "recovery") {
    reason = "检测到一段时间没有学习，本次自动切换为恢复任务。";
  } else if (effectiveState === "tired") {
    reason = "本次只安排少量复习，不增加新词。";
  } else if (readingNeeded) {
    reason = "复习量适中，本次加入一篇短阅读。";
  } else if (dueReviews.length >= 12) {
    reason = "到期复习较多，本次优先巩固词汇。";
  } else {
    reason = readingReason;
  }

  return {
    state: effectiveState,
    requestedState: state,
    targetMinutes: readingNeeded ? 25 : counts.minutes,
    tasks,
    readingIncluded: readingNeeded,
    readingReason,
    reason,
  };
}

export function countRatingResults(attempts) {
  return attempts.reduce(
    (counts, attempt) => {
      if (attempt.itemType !== "word") {
        return counts;
      }
      if (attempt.rating in counts) {
        counts[attempt.rating] += 1;
      }
      return counts;
    },
    { unknown: 0, fuzzy: 0, known: 0 },
  );
}

export function chooseReading(readings, previousReadingIds = [], level) {
  const unseen = readings.filter((reading) => !previousReadingIds.includes(reading.id));
  const pool = unseen.length ? unseen : readings;

  if (level) {
    const sameLevel = pool.filter((reading) => reading.level === level);
    if (sameLevel.length) {
      return sameLevel[0];
    }
  }

  return pool[0] || null;
}

export function buildInitialQueue(tasks) {
  return tasks.map((task) => ({
    cardKey: `${task.id}:1`,
    wordId: task.id,
    mode: task.mode,
    cardMode: task.cardMode || "recognize",
    bank: task.bank || "reading",
    source: task.source || null,
    attemptNumber: 1,
    missCount: 0,
    taught: false,
  }));
}

export function advanceLearningQueue(
  queue,
  currentItem,
  rating,
  maxAttempts = Number.POSITIVE_INFINITY,
) {
  if (!Object.values(RATINGS).includes(rating)) {
    throw new Error(`未知的单词评价：${rating}`);
  }

  const remaining = queue.filter(
    (item) => item.cardKey !== currentItem.cardKey,
  );

  if (rating === RATINGS.known) {
    return {
      queue: remaining,
      requeued: false,
      deferred: false,
      nextAttemptNumber: null,
    };
  }

  if (currentItem.attemptNumber >= maxAttempts) {
    return {
      queue: remaining,
      requeued: false,
      deferred: true,
      nextAttemptNumber: null,
    };
  }

  const nextItem = {
    ...currentItem,
    cardKey: `${currentItem.wordId}:${currentItem.attemptNumber + 1}`,
    attemptNumber: currentItem.attemptNumber + 1,
    missCount: (currentItem.missCount || 0) + 1,
    taught: false,
  };
  const cardsBeforeRetry = rating === RATINGS.unknown ? 2 : 4;
  const insertionIndex = Math.min(cardsBeforeRetry, remaining.length);
  remaining.splice(insertionIndex, 0, nextItem);

  return {
    queue: remaining,
    requeued: true,
    deferred: false,
    nextAttemptNumber: nextItem.attemptNumber,
  };
}

export function normalizeRecallAnswer(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replaceAll("’", "'");
}

