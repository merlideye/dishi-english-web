import { countRatingResults } from "./scheduler.js";

export function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateLabel(dayKey) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(year, month - 1, day));
}

export function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.round(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;

  if (!minutes) {
    return `${remainder} 秒`;
  }

  if (!remainder) {
    return `${minutes} 分钟`;
  }

  return `${minutes} 分 ${remainder} 秒`;
}

export function formatTimer(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ];
  if (hours) {
    parts.unshift(String(hours).padStart(2, "0"));
  }
  return parts.join(":");
}

function average(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function buildWeakWords(wordAttempts, wordsById) {
  const byWord = new Map();

  for (const attempt of wordAttempts) {
    if (!byWord.has(attempt.itemId)) {
      byWord.set(attempt.itemId, []);
    }
    byWord.get(attempt.itemId).push(attempt);
  }

  return [...byWord.entries()]
    .map(([wordId, attempts]) => {
      const latest = attempts[attempts.length - 1];
      const missCount = attempts.filter((attempt) => attempt.rating !== "known").length;
      return {
        id: wordId,
        word:
          latest.wordSnapshot?.word ||
          wordsById.get(wordId)?.word ||
          wordId,
        meaning:
          latest.wordSnapshot?.meaning ||
          wordsById.get(wordId)?.meaning ||
          "",
        attempts: attempts.length,
        missCount,
        latestRating: latest.rating,
      };
    })
    .filter((item) => item.missCount > 0)
    .sort((left, right) => {
      if (right.missCount !== left.missCount) {
        return right.missCount - left.missCount;
      }
      return right.attempts - left.attempts;
    })
    .slice(0, 8);
}

export function buildReport({
  dayKey,
  attempts,
  sessions,
  wordStates,
  words,
  readingPack,
}) {
  const dayAttempts = attempts.filter((attempt) => attempt.day === dayKey);
  const daySessions = sessions.filter((session) => session.day === dayKey);
  const wordAttempts = dayAttempts.filter((attempt) => attempt.itemType === "word");
  const readingAttempts = dayAttempts.filter((attempt) => attempt.itemType === "reading");
  const ratingCounts = countRatingResults(wordAttempts);
  const activeSeconds = daySessions.reduce(
    (total, session) => total + (session.activeSeconds || 0),
    0,
  );
  const averageResponseMs = average(
    wordAttempts
      .map((attempt) => attempt.responseMs)
      .filter((value) => Number.isFinite(value)),
  );
  const wordsById = new Map(words.map((word) => [word.id, word]));
  const weakWords = buildWeakWords(wordAttempts, wordsById);
  const readingResults = readingAttempts.map((attempt) => ({
    title:
      attempt.readingSnapshot?.title ||
      readingPack.items.find((reading) => reading.id === attempt.itemId)?.title ||
      attempt.itemId,
    correct: attempt.correctCount || 0,
    total: attempt.questionCount || 0,
    skipped: attempt.skipped || false,
  }));
  const totalReadingQuestions = readingResults.reduce(
    (total, result) => total + result.total,
    0,
  );
  const correctReadingQuestions = readingResults.reduce(
    (total, result) => total + result.correct,
    0,
  );
  const dueCount = wordStates.filter((state) => state.dueAt <= Date.now()).length;
  const unknownShare = wordAttempts.length
    ? ratingCounts.unknown / wordAttempts.length
    : 0;

  const recommendations = [];
  if (!daySessions.length) {
    recommendations.push("今天还没有开始学习。下次打开时从恢复或正常模式开始即可。");
  } else {
    recommendations.push(`今天有效学习 ${formatDuration(activeSeconds)}。`);
  }
  if (unknownShare > 0.5 && wordAttempts.length >= 8) {
    recommendations.push("本次“不认识”占比较高，下次减少新词，优先复习旧词。");
  }
  if (averageResponseMs && averageResponseMs > 8000) {
    recommendations.push("单词平均反应时间偏长，优先练习词义回忆，而不是继续堆新词。");
  }
  if (totalReadingQuestions && correctReadingQuestions / totalReadingQuestions < 0.6) {
    recommendations.push("阅读正确率低于 60%，下一篇应缩短长度并先处理句子结构。");
  }
  if (dueCount > 45) {
    recommendations.push("到期复习较多，未来几次可以只复习、不添加新词。");
  }
  if (!readingAttempts.length && daySessions.length) {
    recommendations.push("今天没有完成阅读；这不算欠账，下次任务会自动再安排较短阅读。");
  }

  return {
    dayKey,
    sessionCount: daySessions.length,
    activeSeconds,
    wordAttemptCount: wordAttempts.length,
    newWordCount: wordAttempts.filter((attempt) => attempt.mode === "new").length,
    reviewCount: wordAttempts.filter((attempt) => attempt.mode === "review").length,
    ratingCounts,
    averageResponseMs,
    readingResults,
    readingAccuracy: totalReadingQuestions
      ? correctReadingQuestions / totalReadingQuestions
      : null,
    dueCount,
    weakWords,
    recommendations,
  };
}

export function buildCheckpointPayload({
  days = 7,
  accountName = "",
  attempts,
  sessions,
  wordStates,
  words,
  readingPack,
  wordPack,
  readingPackMeta,
  manifest,
  now = new Date(),
}) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days + 1);
  cutoff.setHours(0, 0, 0, 0);
  const recentSessions = sessions.filter(
    (session) => new Date(session.startedAt) >= cutoff,
  );
  const recentAttempts = attempts.filter(
    (attempt) => new Date(attempt.timestamp) >= cutoff,
  );
  const dayKeys = [];

  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    dayKeys.push(localDayKey(date));
  }

  const dailyReports = dayKeys
    .reverse()
    .map((dayKey) =>
      buildReport({
        dayKey,
        attempts: recentAttempts,
        sessions: recentSessions,
        wordStates,
        words,
        readingPack,
      }),
    );

  return {
    app: "danshi-english",
    reportType: "learning-checkpoint",
    accountName: accountName || "未命名账号",
    generatedAt: new Date().toISOString(),
    windowDays: days,
    content: {
      wordPack: {
        id: wordPack.id,
        version: wordPack.version,
        itemCount: wordPack.items.length,
      },
      readingPack: {
        id: readingPack.id,
        version: readingPack.version,
        itemCount: readingPack.items.length,
      },
      manifestUpdatedAt: manifest.updatedAt,
    },
    summary: {
      sessionCount: recentSessions.length,
      activeSeconds: recentSessions.reduce(
        (total, session) => total + (session.activeSeconds || 0),
        0,
      ),
      attemptCount: recentAttempts.length,
      wordStateCount: wordStates.length,
      dueCount: wordStates.filter((state) => state.dueAt <= now.getTime()).length,
    },
    dailyReports,
    raw: {
      sessions: recentSessions,
      attempts: recentAttempts,
      wordStates,
    },
    readingPackMeta,
  };
}

export function checkpointToMarkdown(payload) {
  const lines = [
    "# 滴水英语学习检查包",
    "",
    `账号：${payload.accountName || "未命名账号"}`,
    `生成时间：${payload.generatedAt}`,
    `统计窗口：${payload.windowDays} 天`,
    `词包：${payload.content.wordPack.id} @ ${payload.content.wordPack.version}`,
    `阅读包：${payload.content.readingPack.id} @ ${payload.content.readingPack.version}`,
    "",
    "## 汇总",
    "",
    `- 完成会话：${payload.summary.sessionCount}`,
    `- 有效学习时间：${formatDuration(payload.summary.activeSeconds)}`,
    `- 答题记录：${payload.summary.attemptCount}`,
    `- 已建立复习状态的单词：${payload.summary.wordStateCount}`,
    `- 当前到期词：${payload.summary.dueCount}`,
    "",
    "## 每日记录",
    "",
  ];

  for (const report of payload.dailyReports) {
    lines.push(`### ${report.dayKey}`);
    lines.push("");
    lines.push(`- 会话：${report.sessionCount}`);
    lines.push(`- 有效学习：${formatDuration(report.activeSeconds)}`);
    lines.push(`- 单词答题：${report.wordAttemptCount}`);
    lines.push(
      `- 评价：不认识 ${report.ratingCounts.unknown}，模糊 ${report.ratingCounts.fuzzy}，认识 ${report.ratingCounts.known}`,
    );
    if (report.readingAccuracy !== null) {
      lines.push(`- 阅读正确率：${Math.round(report.readingAccuracy * 100)}%`);
    }
    if (report.weakWords.length) {
      lines.push(
        `- 薄弱词：${report.weakWords.map((item) => item.word).join(", ")}`,
      );
    }
    lines.push("");
  }

  const readingAttempts = payload.raw.attempts.filter(
    (attempt) => attempt.itemType === "reading",
  );
  if (readingAttempts.length) {
    lines.push("## 阅读原文与作答");
    lines.push("");
    for (const attempt of readingAttempts) {
      const reading = attempt.readingSnapshot;
      if (!reading) {
        lines.push(`### ${attempt.itemId}`);
        lines.push("");
        lines.push("旧版记录没有保存阅读原文快照。");
        lines.push("");
        continue;
      }

      lines.push(`### ${attempt.day} · ${reading.title}`);
      lines.push("");
      lines.push(`- 来源：${reading.sourceUrl || "未记录"}`);
      lines.push(`- 许可证：${reading.license || "未记录"}`);
      lines.push(
        `- 结果：${attempt.skipped ? "跳过" : `${attempt.correctCount}/${attempt.questionCount}`}`,
      );
      if (reading.analysis?.mainIdea) {
        lines.push(`- 主旨：${reading.analysis.mainIdea}`);
      }
      if (attempt.memo?.text) {
        lines.push(`- 阅读备忘录：${attempt.memo.text.replaceAll("\n", " ")}`);
      }
      lines.push("");
      lines.push("原文：");
      lines.push("");
      lines.push(reading.text);
      lines.push("");
      for (const question of reading.questions || []) {
        const selected = attempt.answers?.[question.id];
        lines.push(`- ${question.prompt}`);
        lines.push(
          `  - 你的答案：${attempt.skipped ? "未作答" : question.options[selected] ?? "未选择"}`,
        );
        lines.push(`  - 正确答案：${question.options[question.answerIndex]}`);
        lines.push(`  - 解析：${question.explanation}`);
      }
      if (reading.translationNotes?.length) {
        lines.push("");
        lines.push("译文关键点：");
        for (const note of reading.translationNotes) {
          lines.push(`- ${note.source}：${note.target}`);
        }
      }
      lines.push("");
    }
  }

  lines.push("## 说明");
  lines.push("");
  lines.push(
    "此文件由本地学习记录生成，可能包含当时保存的阅读原文、题目和解析。它不包含管理员密码或 API Key；分享前请确认文章以及个人记录的隐私和许可条件。",
  );
  return lines.join("\n");
}

