import {
  STORES,
  deleteRecord,
  exportDatabaseBackup,
  getAll,
  importDatabaseBackup,
  putRecord,
  saveWordTurn,
  openDatabase,
  setDatabaseAccount,
} from "./js/db.js";
import {
  accountInitial,
  changeAdminPassword,
  clearActiveAccount,
  createAccount,
  getActiveAccount,
  isAdminConfigured,
  listAccounts,
  saveAdminPassword,
  selectAccount,
  setupFirstAccount,
  verifyAdminPassword,
} from "./js/accounts.js";
import {
  DAY_MS,
  RATINGS,
  advanceLearningQueue,
  applyRating,
  buildInitialQueue,
  buildPlan,
  chooseReading,
  createWordState,
  difficultyLevelOf,
  normalizeRecallAnswer,
} from "./js/scheduler.js";
import {
  buildCheckpointPayload,
  buildReport,
  checkpointToMarkdown,
  formatDateLabel,
  formatDuration,
  formatTimer,
  localDayKey,
} from "./js/report.js";

const TIMER_KEY = "danshi-english-timer-v1";
const ENERGY_KEY = "preferredEnergyState";
const LAST_FEEDBACK_KEY = "lastFeedbackAt";
const CUSTOM_WORD_PACK_KEY = "customWordPackV1";
const CUSTOM_READING_PACK_KEY = "customReadingPackV1";
const ENERGY_LABELS = {
  normal: "正常",
  energized: "状态好",
  tired: "比较累",
  recovery: "中断后恢复",
};
const RATING_LABELS = {
  unknown: "不认识",
  fuzzy: "模糊",
  known: "认识",
};
const ADMIN_UNLOCK_MS = 30 * 60 * 1000;

const app = document.querySelector("#app");
const toastElement = document.querySelector("#toast");

const content = {
  manifest: null,
  words: null,
  readings: null,
  wordsById: new Map(),
  readingsById: new Map(),
};

const data = {
  attempts: [],
  sessions: [],
  wordStates: [],
  settings: [],
};

const ui = {
  page: "today",
  reportDay: localDayKey(),
  preferredState: "normal",
  activeSession: null,
  batchMeaningsVisible: false,
  timer: null,
  currentTaskId: null,
  cardShownAt: null,
  pendingGrade: null,
  readingStartedAt: null,
  readingFeedback: null,
  currentAccount: null,
  accountGateMessage: "",
  accountSetupMode: "select",
  adminUnlockedUntil: 0,
};

let timerInterval;
let lastPersistedTimerAt = 0;
let memoSaveTimer;

function timerStorageKey() {
  return `${TIMER_KEY}:${ui.currentAccount?.id || "legacy"}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function multiline(value) {
  return escapeHtml(value)
    .replaceAll("\\n", "\n")
    .replaceAll("\n", "<br>");
}

function makeId(prefix) {
  if (crypto.randomUUID) {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function formatTimeAgo(timestamp) {
  if (!timestamp) {
    return "尚未反馈";
  }
  const elapsed = Math.max(0, Date.now() - new Date(timestamp).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) {
    return "刚刚反馈";
  }
  if (minutes < 60) {
    return `上次反馈 ${minutes} 分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `上次反馈 ${hours} 小时前`;
  }
  const days = Math.floor(hours / 24);
  return `上次反馈 ${days} 天前`;
}

function lastFeedbackSetting() {
  return data.settings.find((setting) => setting.key === LAST_FEEDBACK_KEY);
}

function showToast(message, duration = 2600) {
  toastElement.textContent = message;
  toastElement.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    toastElement.classList.remove("visible");
  }, duration);
}

function downloadFile(filename, contentValue, type) {
  const blob = new Blob([contentValue], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function loadContent() {
  const manifestResponse = await fetch(`content/manifest.json?t=${Date.now()}`, {
    cache: "no-store",
  });
  if (!manifestResponse.ok) {
    throw new Error("无法读取内容包索引。");
  }
  const manifest = await manifestResponse.json();

  const [wordResponse, readingResponse] = await Promise.all([
    fetch(`content/${manifest.wordPack}?t=${Date.now()}`, { cache: "no-store" }),
    fetch(`content/${manifest.readingPack}?t=${Date.now()}`, { cache: "no-store" }),
  ]);

  if (!wordResponse.ok || !readingResponse.ok) {
    throw new Error("无法读取单词包或阅读包。");
  }

  const [serverWordPack, serverReadingPack] = await Promise.all([
    wordResponse.json(),
    readingResponse.json(),
  ]);

  if (
    !Array.isArray(serverWordPack.items) ||
    !Array.isArray(serverReadingPack.items)
  ) {
    throw new Error("内容包结构不正确。");
  }

  const wordOverride = data.settings.find(
    (setting) => setting.key === CUSTOM_WORD_PACK_KEY,
  )?.value;
  const readingOverride = data.settings.find(
    (setting) => setting.key === CUSTOM_READING_PACK_KEY,
  )?.value;
  const wordPack =
    wordOverride && Array.isArray(wordOverride.items)
      ? wordOverride
      : serverWordPack;
  const readingPack =
    readingOverride && Array.isArray(readingOverride.items)
      ? readingOverride
      : serverReadingPack;

  content.manifest = manifest;
  content.words = wordPack;
  content.readings = readingPack;
  content.wordsById = new Map(wordPack.items.map((word) => [word.id, word]));
  content.readingsById = new Map(
    readingPack.items.map((reading) => [reading.id, reading]),
  );

  const legacyPaths = Array.isArray(manifest.legacyWordPacks)
    ? manifest.legacyWordPacks
    : [];
  const legacyPacks = await Promise.all(
    legacyPaths.map(async (packPath) => {
      const response = await fetch(`content/${packPath}?t=${Date.now()}`, {
        cache: "no-store",
      });
      return response.ok ? response.json() : null;
    }),
  );
  for (const legacyPack of legacyPacks) {
    if (!Array.isArray(legacyPack?.items)) {
      continue;
    }
    for (const word of legacyPack.items) {
      if (!content.wordsById.has(word.id)) {
        content.wordsById.set(word.id, word);
      }
    }
  }
}

async function refreshData() {
  const [attempts, sessions, wordStates, settings] = await Promise.all([
    getAll(STORES.attempts),
    getAll(STORES.sessions),
    getAll(STORES.wordStates),
    getAll(STORES.settings),
  ]);

  attempts.sort((left, right) => left.timestamp - right.timestamp);
  sessions.sort((left, right) => left.startedAt - right.startedAt);
  data.attempts = attempts;
  data.sessions = sessions;
  data.wordStates = wordStates;
  data.settings = settings;

  const energySetting = settings.find((setting) => setting.key === ENERGY_KEY);
  if (energySetting?.value && ENERGY_LABELS[energySetting.value]) {
    ui.preferredState = energySetting.value;
  }
}

function latestActiveSession() {
  return [...data.sessions]
    .reverse()
    .find((session) => session.status === "active");
}

function sessionAttempts(sessionId) {
  return data.attempts.filter((attempt) => attempt.sessionId === sessionId);
}

function sessionQueue(session) {
  if (Array.isArray(session.queue)) {
    return session.queue;
  }
  session.queue = buildInitialQueue(session.plan?.tasks || []);
  session.deferredWordIds = session.deferredWordIds || [];
  return session.queue;
}

function readingAttemptForSession(sessionId) {
  return sessionAttempts(sessionId).find(
    (attempt) => attempt.itemType === "reading",
  );
}

function completedReadingCount() {
  return data.attempts.filter(
    (attempt) => attempt.itemType === "reading" && !attempt.skipped,
  ).length;
}

function sessionsSinceReading() {
  const latestReading = [...data.attempts]
    .reverse()
    .find((attempt) => attempt.itemType === "reading");
  if (!latestReading) {
    return 99;
  }
  return data.sessions.filter(
    (session) =>
      session.startedAt > latestReading.timestamp &&
      session.status === "completed",
  ).length;
}

function daysSinceLastSession() {
  const latest = [...data.sessions]
    .reverse()
    .find((session) => session.status === "completed");
  if (!latest) {
    return 0;
  }
  const endpoint = latest.endedAt || latest.startedAt;
  return Math.max(0, Math.floor((Date.now() - endpoint) / DAY_MS));
}

function learningWordStates() {
  return data.wordStates.filter((state) => content.wordsById.has(state.id));
}

function buildPreviewPlan(state = ui.preferredState) {
  return buildPlan({
    state,
    wordStates: learningWordStates(),
    words: content.words.items,
    sessionsSinceReading: sessionsSinceReading(),
    completedReadingCount: completedReadingCount(),
    daysSinceLastSession: daysSinceLastSession(),
  });
}

function readingChoiceForHome(plan) {
  if (!plan.readingIncluded) {
    return null;
  }
  const previousIds = data.attempts
    .filter((attempt) => attempt.itemType === "reading")
    .map((attempt) => attempt.itemId);
  return chooseReading(content.readings.items, previousIds, "foundation");
}

function homeMetrics() {
  const today = localDayKey();
  const todaySessions = data.sessions.filter(
    (session) => session.day === today && session.status === "completed",
  );
  const todaySeconds = todaySessions.reduce(
    (total, session) => total + (session.activeSeconds || 0),
    0,
  );
  const states = learningWordStates();
  const mastered = states.filter(
    (state) => (state.knownCount || 0) >= 2 && (state.intervalDays || 0) >= 3,
  ).length;
  const due = states.filter((state) => state.dueAt <= Date.now()).length;
  const readingAttempts = data.attempts.filter(
    (attempt) =>
      attempt.itemType === "reading" &&
      !attempt.skipped &&
      attempt.questionCount,
  );
  const totalQuestions = readingAttempts.reduce(
    (total, attempt) => total + attempt.questionCount,
    0,
  );
  const correctQuestions = readingAttempts.reduce(
    (total, attempt) => total + (attempt.correctCount || 0),
    0,
  );

  return {
    todaySeconds,
    todaySessionCount: todaySessions.length,
    touched: states.length,
    mastered,
    due,
    coverage: states.length / Math.max(1, content.words.items.length),
    retention: states.length
      ? states.reduce(
          (total, state) =>
            total +
            Math.min(1, Math.max(0, (state.intervalDays || 0) / 7)),
          0,
        ) / states.length
      : 0,
    readingAccuracy: totalQuestions ? correctQuestions / totalQuestions : null,
  };
}

function difficultyDistribution() {
  const states = learningWordStates();
  const counts = Array.from({ length: 10 }, () => 0);
  const tomorrowCounts = Array.from({ length: 10 }, () => 0);
  const tomorrowStart = new Date();
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = tomorrowStart.getTime() + DAY_MS - 1;

  for (const state of states) {
    const level = difficultyLevelOf(state);
    counts[level - 1] += 1;
    if (state.dueAt >= tomorrowStart.getTime() && state.dueAt <= tomorrowEnd) {
      tomorrowCounts[level - 1] += 1;
    }
  }

  return {
    counts,
    tomorrowCounts,
    hardCount: states.filter((state) => state.hardFlag).length,
    tomorrowTotal: tomorrowCounts.reduce((sum, count) => sum + count, 0),
  };
}

function recentWeakWords(limit = 6) {
  const cutoff = Date.now() - 30 * DAY_MS;
  const recent = data.attempts.filter(
    (attempt) =>
      attempt.itemType === "word" && attempt.timestamp >= cutoff,
  );
  const byWord = new Map();

  for (const attempt of recent) {
    if (!byWord.has(attempt.itemId)) {
      byWord.set(attempt.itemId, []);
    }
    byWord.get(attempt.itemId).push(attempt);
  }

  return [...byWord.entries()]
    .map(([wordId, attempts]) => ({
      id: wordId,
      word:
        attempts[attempts.length - 1].wordSnapshot?.word ||
        content.wordsById.get(wordId)?.word ||
        wordId,
      meaning:
        attempts[attempts.length - 1].wordSnapshot?.meaning ||
        content.wordsById.get(wordId)?.meaning ||
        "",
      misses: attempts.filter((attempt) => attempt.rating !== RATINGS.known).length,
      attempts: attempts.length,
      latestAt: attempts[attempts.length - 1].timestamp,
    }))
    .filter((item) => item.misses > 0)
    .sort((left, right) => {
      if (right.misses !== left.misses) {
        return right.misses - left.misses;
      }
      return right.latestAt - left.latestAt;
    })
    .slice(0, limit);
}

function timerElapsedMs() {
  if (!ui.timer) {
    return 0;
  }
  const runningPart = ui.timer.runningSince
    ? Date.now() - ui.timer.runningSince
    : 0;
  return ui.timer.accumulatedMs + runningPart;
}

function saveTimerState() {
  if (!ui.timer) {
    localStorage.removeItem(timerStorageKey());
    return;
  }
  ui.timer.accumulatedMs = timerElapsedMs();
  ui.timer.runningSince = ui.timer.runningSince ? Date.now() : null;
  ui.timer.savedAt = Date.now();
  localStorage.setItem(timerStorageKey(), JSON.stringify(ui.timer));
}

function restoreTimerState(sessionId) {
  try {
    const stored = JSON.parse(
      localStorage.getItem(timerStorageKey()) ||
        localStorage.getItem(TIMER_KEY) ||
        "null",
    );
    if (stored?.sessionId === sessionId) {
      ui.timer = {
        sessionId,
        accumulatedMs: Number(stored.accumulatedMs) || 0,
        runningSince: null,
        savedAt: stored.savedAt || Date.now(),
        recovered: Boolean(stored.runningSince),
      };
      return;
    }
  } catch {
    localStorage.removeItem(timerStorageKey());
    localStorage.removeItem(TIMER_KEY);
  }

  ui.timer = {
    sessionId,
    accumulatedMs: 0,
    runningSince: null,
    savedAt: Date.now(),
    recovered: false,
  };
}

function startTimer(sessionId) {
  ui.timer = {
    sessionId,
    accumulatedMs: 0,
    runningSince: Date.now(),
    savedAt: Date.now(),
    recovered: false,
  };
  saveTimerState();
  updateTimerDisplay();
}

function pauseTimer() {
  if (!ui.timer?.runningSince) {
    return;
  }
  ui.timer.accumulatedMs = timerElapsedMs();
  ui.timer.runningSince = null;
  ui.timer.savedAt = Date.now();
  saveTimerState();
  render();
}

function resumeTimer() {
  if (!ui.timer || ui.timer.runningSince) {
    return;
  }
  ui.timer.runningSince = Date.now();
  ui.timer.savedAt = Date.now();
  saveTimerState();
  render();
}

function updateTimerDisplay() {
  const display = document.querySelector("[data-timer-display]");
  const status = document.querySelector("[data-timer-status]");
  if (!display) {
    return;
  }

  display.textContent = formatTimer(timerElapsedMs());
  if (status) {
    status.textContent = ui.activeSession
      ? ui.timer?.runningSince
        ? "计时中"
        : "已暂停"
      : "等待开始";
    status.classList.toggle("running", Boolean(ui.timer?.runningSince));
  }
}

function syncTimerHeartbeat() {
  if (!ui.timer) {
    return;
  }

  saveTimerState();
  if (Date.now() - lastPersistedTimerAt > 15000 && ui.activeSession) {
    lastPersistedTimerAt = Date.now();
    putRecord(STORES.sessions, {
      ...ui.activeSession,
      activeSeconds: Math.round(timerElapsedMs() / 1000),
      checkpointedAt: new Date().toISOString(),
    }).catch(() => {});
  }
}

function timerPanelMarkup(plan) {
  const active = Boolean(ui.activeSession);
  const running = Boolean(ui.timer?.runningSince);
  return `
    <aside class="timer-panel">
      <div class="timer-top">
        <span class="timer-label">FOCUS TIMER</span>
        <span class="timer-status ${running ? "running" : ""}" data-timer-status>
          ${active ? (running ? "计时中" : "已暂停") : "等待开始"}
        </span>
      </div>
      <div>
        <div class="timer-display" data-timer-display>${formatTimer(timerElapsedMs())}</div>
        <div class="timer-target">
          ${active ? `本次目标约 ${ui.activeSession.plan.targetMinutes} 分钟` : `建议本次约 ${plan.targetMinutes} 分钟`}
        </div>
      </div>
      <div class="timer-actions">
        ${
          active
            ? `
              ${
                running
                  ? '<button class="secondary-button" data-action="pause-timer">暂停</button>'
                  : '<button class="primary-button" data-action="resume-timer">继续计时</button>'
              }
              <button class="secondary-button" data-action="end-session">结束</button>
            `
            : '<button class="primary-button" data-action="start-session">开始学习</button>'
        }
      </div>
    </aside>
  `;
}

function accountOpenedLabel(account) {
  if (!account.lastOpenedAt) {
    return "尚未开始学习";
  }
  return `上次打开 ${new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(new Date(account.lastOpenedAt))}`;
}

function renderAccountGate() {
  const accounts = listAccounts();
  const firstRun = accounts.length === 0;
  const showCreateForm = firstRun || ui.accountSetupMode === "create";
  app.innerHTML = `
    <div class="account-shell">
      <section class="account-intro">
        <div class="brand account-brand">
          <div class="brand-mark">滴</div>
          <div>
            <h1>滴水英语</h1>
            <p>每天一点，持续回到真实的英语里</p>
          </div>
        </div>
        <div class="account-intro-copy">
          <span class="eyebrow">MOBILE LEARNING EDITION</span>
          <h2>${firstRun ? "给自己留一个名字" : "今天用哪个账号学习？"}</h2>
          <p>账号只用来区分每个人的学习记录。数据保存在当前设备，不要求用户密码。</p>
        </div>
        <div class="account-feature-list" aria-label="应用特点">
          <span>手机优先</span>
          <span>离线可用</span>
          <span>记录独立</span>
        </div>
      </section>
      <section class="account-panel">
        ${
          firstRun
            ? `
              <div class="account-panel-heading">
                <span class="account-step">首次设置</span>
                <h3>创建账号和管理员密码</h3>
                <p>管理员密码用于保护内容替换、恢复备份等修改操作。</p>
              </div>
              <form id="first-account-form" class="account-form">
                <label class="form-field">
                  <span>账号名称</span>
                  <input id="account-name" name="accountName" type="text" maxlength="24" autocomplete="nickname" placeholder="例如：小林" required>
                </label>
                <label class="form-field">
                  <span>管理员密码</span>
                  <input id="admin-password" name="adminPassword" type="password" minlength="6" autocomplete="new-password" placeholder="至少 6 个字符" required>
                </label>
                <label class="form-field">
                  <span>再次输入密码</span>
                  <input name="adminPasswordConfirm" type="password" minlength="6" autocomplete="new-password" placeholder="确认管理员密码" required>
                </label>
                <button class="primary-button account-submit" type="submit">开始使用</button>
              </form>
            `
            : `
              <div class="account-panel-heading">
                <span class="account-step">当前设备</span>
                <h3>选择账号</h3>
                <p>你的进度、词库和阅读记录会分开保存。</p>
              </div>
              <div class="account-list">
                ${accounts
                  .map(
                    (account) => `
                      <button class="account-option" data-action="select-account" data-account-id="${escapeHtml(account.id)}">
                        <span class="account-avatar">${escapeHtml(accountInitial(account.name))}</span>
                        <span class="account-option-copy">
                          <strong>${escapeHtml(account.name)}</strong>
                          <small>${escapeHtml(accountOpenedLabel(account))}</small>
                        </span>
                        <span class="account-arrow" aria-hidden="true">→</span>
                      </button>
                    `,
                  )
                  .join("")}
              </div>
              ${
                showCreateForm
                  ? `
                    <form id="create-account-form" class="account-form compact-account-form">
                      <label class="form-field">
                        <span>新账号名称</span>
                        <input id="account-name" name="accountName" type="text" maxlength="24" autocomplete="nickname" placeholder="输入名字" required autofocus>
                      </label>
                      <div class="inline-form-actions">
                        <button class="ghost-button" type="button" data-action="cancel-account-create">取消</button>
                        <button class="primary-button" type="submit">创建账号</button>
                      </div>
                    </form>
                  `
                  : '<button class="secondary-button add-account-button" type="button" data-action="show-account-create">＋ 新建账号</button>'
              }
            `
        }
        <div class="account-note">
          <strong>本地保存</strong>
          <span>更换手机或清理浏览器数据前，请在“数据”页导出备份。</span>
        </div>
        ${
          ui.accountGateMessage
            ? `<div class="form-message" role="status">${escapeHtml(ui.accountGateMessage)}</div>`
            : ""
        }
      </section>
    </div>
  `;
}

function navMarkup() {
  const entries = [
    ["today", "今日"],
    ["report", "复盘"],
    ["data", "数据"],
  ];
  return `
    <button class="feedback-pill" data-action="feedback-now" title="导出本次反馈包">
      <span class="feedback-dot"></span>
      ${escapeHtml(formatTimeAgo(lastFeedbackSetting()?.value))}
    </button>
    <nav class="nav" aria-label="主导航">
      ${entries
        .map(
          ([page, label]) => `
            <button class="${ui.page === page ? "active" : ""}" data-action="navigate" data-page="${page}">
              ${label}
            </button>
          `,
        )
        .join("")}
    </nav>
  `;
}

function shellMarkup(screen) {
  const account = ui.currentAccount;
  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">滴</div>
          <div>
            <h1>滴水英语</h1>
            <p>手机学习 · 本地保存</p>
          </div>
        </div>
        <div class="top-meta">
          <span class="date-label">${escapeHtml(formatDateLabel(localDayKey()))}</span>
          ${
            account
              ? `<button class="account-chip" data-action="switch-account" title="切换账号">
                  <span class="account-avatar small">${escapeHtml(accountInitial(account.name))}</span>
                  <span>${escapeHtml(account.name)}</span>
                </button>`
              : ""
          }
          ${navMarkup()}
        </div>
      </header>
      <main>${screen}</main>
    </div>
  `;
}

function renderLoading() {
  app.innerHTML = `
    <div class="loading">
      <div>
        <div class="loading-mark">滴</div>
        <div>正在加载本地学习数据…</div>
      </div>
    </div>
  `;
}

function renderHome() {
  const plan = buildPreviewPlan();
  const metrics = homeMetrics();
  const previewReading = readingChoiceForHome(plan);
  const newCount = plan.tasks.filter((task) => task.mode === "new").length;
  const reviewCount = plan.tasks.filter((task) => task.mode === "review").length;
  const weak = recentWeakWords();
  const levels = difficultyDistribution();
  const recentSessions = [...data.sessions]
    .filter((session) => session.status === "completed")
    .reverse()
    .slice(0, 4);
  const hasActive = Boolean(ui.activeSession);

  return shellMarkup(`
    <div class="screen">
      <section class="hero">
        <div class="hero-main">
          <span class="eyebrow">MOBILE WEB EDITION</span>
          <h2>${hasActive ? "继续今天未完成的学习。" : `今天，先完成 <span>${plan.targetMinutes} 分钟</span>。`}</h2>
          <p class="hero-copy">
            ${hasActive
              ? "计时会从上次保存的位置继续。未完成任务不会在之后成倍堆积。"
              : escapeHtml(plan.reason)}
          </p>
          <div class="hero-actions">
            <button class="primary-button" data-action="${hasActive ? "resume-session" : "start-session"}">
              ${hasActive ? "回到当前会话" : "开始今日学习"}
            </button>
            <label class="state-field" for="energy-state">
              <span>当前状态</span>
              <select id="energy-state" data-action="change-energy">
                ${Object.entries(ENERGY_LABELS)
                  .map(
                    ([value, label]) =>
                      `<option value="${value}" ${value === ui.preferredState ? "selected" : ""}>${label}</option>`,
                  )
                  .join("")}
              </select>
            </label>
          </div>
        </div>
        ${timerPanelMarkup(plan)}
      </section>

      ${hasActive ? `
        <div class="notice" style="margin-bottom:20px">
          当前有一个进行中的学习会话。点击右上角“开始学习”区域或“回到当前会话”即可继续。
        </div>
      ` : ""}

      <section class="content-grid">
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h3>本次任务预览</h3>
                <p>${escapeHtml(plan.reason)}</p>
              </div>
              <span class="tag">${escapeHtml(ENERGY_LABELS[plan.state])}</span>
            </div>
            <div class="plan-list">
              <div class="plan-row">
                <span class="plan-index">01</span>
                <div>
                  <strong>到期复习</strong>
                  <span>优先处理已经到复习时间的词</span>
                </div>
                <span class="tag">${reviewCount} 词</span>
              </div>
              <div class="plan-row">
                <span class="plan-index">02</span>
                <div>
                  <strong>新词理解</strong>
                  <span>先回忆，再揭示词义与英文解释</span>
                </div>
                <span class="tag">${newCount} 词</span>
              </div>
              <div class="plan-row">
                <span class="plan-index">03</span>
                <div>
                  <strong>${plan.readingIncluded ? "短篇阅读" : "本次不安排阅读"}</strong>
                  <span>${plan.readingIncluded ? escapeHtml(previewReading?.title || "开放阅读") : escapeHtml(plan.readingReason)}</span>
                </div>
                <span class="tag ${plan.readingIncluded ? "gold" : ""}">${plan.readingIncluded ? "1 篇" : "—"}</span>
              </div>
            </div>
          </article>

          <article class="card">
            <div class="card-header">
              <div>
                <h3>学习进度</h3>
                <p>进度依据真实答题，不要求你补齐漏掉的日期。</p>
              </div>
            </div>
            <div class="metric-grid">
              <div class="metric">
                <div class="metric-label">今天有效学习</div>
                <div class="metric-value">${metrics.todaySeconds ? formatDuration(metrics.todaySeconds) : "还没有"}</div>
                <div class="metric-note">${metrics.todaySessionCount} 次已完成会话</div>
              </div>
              <div class="metric">
                <div class="metric-label">当前到期词</div>
                <div class="metric-value">${metrics.due}</div>
                <div class="metric-note">系统会在下次任务中分流</div>
              </div>
              <div class="metric">
                <div class="metric-label">已稳定掌握</div>
                <div class="metric-value">${metrics.mastered}</div>
                <div class="metric-note">至少两次“认识”且间隔 ≥ 3 天</div>
              </div>
              <div class="metric">
                <div class="metric-label">阅读正确率</div>
                <div class="metric-value">${metrics.readingAccuracy === null ? "—" : `${Math.round(metrics.readingAccuracy * 100)}%`}</div>
                <div class="metric-note">来自已完成阅读题</div>
              </div>
            </div>
            <div class="progress-block">
              <div class="progress-title"><span>词包接触范围</span><strong>${Math.round(metrics.coverage * 100)}%</strong></div>
              <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, metrics.coverage * 100)}%"></div></div>
            </div>
            <div class="progress-block">
              <div class="progress-title"><span>复习间隔形成的保持度</span><strong>${Math.round(metrics.retention * 100)}%</strong></div>
              <div class="progress-track"><div class="progress-fill gold" style="width:${Math.min(100, metrics.retention * 100)}%"></div></div>
            </div>
          </article>
        </div>

        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h3>需要再看一眼的词</h3>
                <p>最近 30 天内出现模糊或不认识的词。</p>
              </div>
            </div>
            ${
              weak.length
                ? `<ul class="weak-list">
                    ${weak
                      .map(
                        (item) => `
                          <li class="weak-item">
                            <div>
                              <div class="weak-word">${escapeHtml(item.word)}</div>
                              <div class="weak-meta">${escapeHtml((item.meaning || "").split("\n")[0])}</div>
                            </div>
                            <span class="tag red">${item.misses} 次未稳</span>
                          </li>
                        `,
                      )
                      .join("")}
                  </ul>`
                : '<div class="empty-note">完成第一次学习后，这里会显示真正需要补强的词。</div>'
            }
          </article>

          <article class="card">
            <div class="card-header">
              <div>
                <h3>词汇等级分布</h3>
                <p>等级越高越不熟；连续三次未稳会标记为重点不会。</p>
              </div>
              <span class="tag ${levels.hardCount ? "red" : ""}">${levels.hardCount} 个重点</span>
            </div>
            <div class="level-board">
              ${levels.counts
                .map(
                  (count, index) => `
                    <div class="level-cell level-${index + 1}">
                      <span>Lv.${index + 1}</span>
                      <strong>${count}</strong>
                    </div>
                  `,
                )
                .join("")}
            </div>
            <div class="level-tomorrow">
              <span>明日预计复习</span>
              <strong>${levels.tomorrowTotal} 个</strong>
              <span>${levels.tomorrowTotal ? levels.tomorrowCounts.map((count, index) => count ? `Lv.${index + 1}×${count}` : "").filter(Boolean).join(" · ") : "暂无到期"}</span>
            </div>
          </article>

          <article class="card">
            <div class="card-header">
              <div>
                <h3>最近会话</h3>
                <p>没有每周次数目标，只记录实际发生的学习。</p>
              </div>
            </div>
            ${
              recentSessions.length
                ? `<ul class="activity-list">
                    ${recentSessions
                      .map(
                        (session) => `
                          <li class="activity-item">
                            <div>
                              <strong>${escapeHtml(formatDateLabel(session.day))}</strong>
                              <div class="activity-meta">${escapeHtml(ENERGY_LABELS[session.plan?.state] || "学习")}</div>
                            </div>
                            <span class="tag">${formatDuration(session.activeSeconds || 0)}</span>
                          </li>
                        `,
                      )
                      .join("")}
                  </ul>`
                : '<div class="empty-note">还没有已完成的会话。</div>'
            }
          </article>
        </div>
      </section>
    </div>
  `);
}

function sessionProgress(session) {
  const attempts = sessionAttempts(session.id);
  const completedWordCards = attempts.filter(
    (attempt) => attempt.itemType === "word",
  ).length;
  const remainingWords = sessionQueue(session).length;
  const readingDone = attempts.some(
    (attempt) => attempt.itemType === "reading",
  );
  const plannedTotal =
    completedWordCards +
    remainingWords +
    (session.plan.readingIncluded ? 1 : 0);
  const completedTotal = completedWordCards + (readingDone ? 1 : 0);
  return {
    plannedTotal,
    completedTotal,
    remainingWords,
    ratio: plannedTotal ? completedTotal / plannedTotal : 1,
  };
}

function unresolvedSessionTasks(session) {
  return sessionQueue(session);
}

function sessionToolbar(session) {
  const progress = sessionProgress(session);
  const running = Boolean(ui.timer?.runningSince);
  return `
    <div class="session-toolbar">
      <div class="session-progress">
        <strong>${progress.completedTotal}/${progress.plannedTotal}</strong>
        <div class="progress-track">
          <div class="progress-fill" style="width:${Math.min(100, progress.ratio * 100)}%"></div>
        </div>
      </div>
      <div class="timer-actions" style="margin:0;min-width:310px">
        <span class="date-label" data-timer-display style="padding:11px 14px;border-radius:10px;background:var(--paper);font-variant-numeric:tabular-nums;font-size:16px;color:var(--ink)">
          ${formatTimer(timerElapsedMs())}
        </span>
        ${
          running
            ? '<button class="secondary-button" data-action="pause-timer">暂停</button>'
            : '<button class="secondary-button" data-action="resume-timer">继续计时</button>'
        }
        <button class="ghost-button" data-action="end-session">结束会话</button>
      </div>
    </div>
  `;
}

function wordMetaMarkup(word) {
  const tags = (word.tags || [])
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join(" ");
  const formLabels = {
    p: "过去式",
    d: "过去分词",
    i: "现在分词",
    "3": "第三人称单数",
    s: "复数",
    r: "比较级",
    t: "最高级",
  };
  const forms = String(word.exchange || "")
    .split("/")
    .map((part) => {
      const separator = part.indexOf(":");
      if (separator < 1) {
        return "";
      }
      const prefix = part.slice(0, separator);
      const value = part.slice(separator + 1);
      return formLabels[prefix] ? `${formLabels[prefix]}：${value}` : "";
    })
    .filter(Boolean);

  if (!tags && !forms.length) {
    return "";
  }

  return `
    <div class="word-meta">
      ${tags ? `<div class="meta-tags">${tags}</div>` : ""}
      ${forms.length ? `<div class="word-forms">${forms.map(escapeHtml).join(" · ")}</div>` : ""}
    </div>
  `;
}

function wordStateFor(wordId) {
  return data.wordStates.find((state) => state.id === wordId);
}

function wordSkills(word) {
  if (Array.isArray(word?.skills) && word.skills.length) {
    return word.skills;
  }
  return ["reading"];
}

function skillLabel(word) {
  const skills = wordSkills(word);
  if (skills.includes("writing") && skills.includes("reading")) {
    return "阅读 + 作文词";
  }
  if (skills.includes("writing")) {
    return "作文词";
  }
  return "阅读词";
}

function buildMeaningChoices(word) {
  const correct = (word.meaning || "").split("\n")[0] || word.definition;
  const candidates = content.words.items
    .filter(
      (candidate) =>
        candidate.id !== word.id &&
        candidate.meaning &&
        candidate.meaning.split("\n")[0] !== correct,
    )
    .map((candidate) => candidate.meaning.split("\n")[0]);
  const uniqueCandidates = [...new Set(candidates)];
  let seed = 0;
  for (const character of word.id) {
    seed = (seed * 31 + character.codePointAt(0)) >>> 0;
  }
  const distractors = [];
  for (let index = 0; index < uniqueCandidates.length && distractors.length < 3; index += 1) {
    const candidateIndex = (seed + index * 17) % uniqueCandidates.length;
    const candidate = uniqueCandidates[candidateIndex];
    if (candidate && !distractors.includes(candidate)) {
      distractors.push(candidate);
    }
  }
  const options = [
    { text: correct, correct: true },
    ...distractors.map((text) => ({ text, correct: false })),
  ];
  const rotateBy = seed % options.length;
  return [...options.slice(rotateBy), ...options.slice(0, rotateBy)];
}

function difficultyMarkup(level, hardFlag = false) {
  const safeLevel = Math.min(10, Math.max(1, Number(level) || 5));
  const tone =
    safeLevel >= 9
      ? "level-hard"
      : safeLevel >= 6
        ? "level-watch"
        : safeLevel >= 4
          ? "level-normal"
          : "level-easy";
  return `
    <span class="word-level ${tone}">Lv.${safeLevel}/10</span>
    ${hardFlag ? '<span class="tag red">重点不会</span>' : ""}
  `;
}

function renderWordCard(session, item) {
  const word = content.wordsById.get(item.wordId);
  if (!word) {
    return `<div class="empty-note">词包中已找不到 ${escapeHtml(item.wordId)}。请重新加载内容。</div>`;
  }
  const state = wordStateFor(item.wordId);
  const level = difficultyLevelOf(state);
  const skills = wordSkills(word);
  const spellingRequired = skills.includes("writing");

  if (ui.currentTaskId !== item.cardKey) {
    ui.currentTaskId = item.cardKey;
    ui.cardShownAt = Date.now();
  }

  if (item.attemptNumber > 1) {
    const retryContent = spellingRequired
      ? `
        <p class="answer-meaning retry-clue">${multiline(word.meaning)}</p>
        <form id="retry-form" class="retry-form">
          <label for="retry-answer">作文词汇：根据中文释义写出英文</label>
          <input
            id="retry-answer"
            name="retryAnswer"
            type="text"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            placeholder="输入英文单词"
            required
          >
          <div class="reading-actions" style="margin-top:14px">
            <button class="ghost-button" type="button" data-action="reveal-retry-answer">我不会，显示答案</button>
            <button class="primary-button" type="submit">检查拼写</button>
          </div>
        </form>
      `
      : `
        <h2 class="word-text retry-word">${escapeHtml(word.word)}</h2>
        <p class="phonetic">/${escapeHtml(word.phonetic)}/</p>
        <p class="word-prompt">阅读词汇：选择最符合的主要含义</p>
        <form id="retry-choice-form" class="meaning-choice-form">
          <div class="meaning-choice-grid">
            ${buildMeaningChoices(word)
              .map(
                (choice, index) => `
                  <label class="meaning-choice">
                    <input type="radio" name="meaningChoice" value="${index}" data-correct="${choice.correct}" required>
                    <span>${String.fromCharCode(65 + index)}. ${multiline(choice.text)}</span>
                  </label>
                `,
              )
              .join("")}
          </div>
          <div class="reading-actions" style="margin-top:14px">
            <button class="ghost-button" type="button" data-action="reveal-retry-answer">我不会，显示答案</button>
            <button class="primary-button" type="submit">检查词义</button>
          </div>
        </form>
      `;
    return `
      <article class="session-card">
        <div class="session-kicker">
          <span>重学 · 第 ${item.attemptNumber} 次回忆</span>
          <span class="difficulty-row">
            ${difficultyMarkup(level, state?.hardFlag)}
            <span>这次不再直接显示英文</span>
          </span>
        </div>
        <div class="word-stage">
          <span class="tag gold">${escapeHtml(skillLabel(word))} · 重学 ${item.attemptNumber}</span>
          ${spellingRequired ? '<h2 class="retry-title">根据释义写出英文单词</h2>' : ""}
          ${retryContent}
        </div>
      </article>
    `;
  }

  return `
    <article class="session-card">
      <div class="session-kicker">
        <span>
          ${item.mode === "review" ? "到期复习" : "新词理解"}
          ${word.studyDay ? ` · 第 ${word.studyDay} 天` : ""}
        </span>
        <span class="difficulty-row">
          ${difficultyMarkup(level, state?.hardFlag)}
          <span>${item.mode === "review" ? "先主动回忆，再核对" : "先判断熟悉度，再查看释义"}</span>
        </span>
      </div>
      <div class="word-stage">
        <span class="tag ${item.mode === "review" ? "" : "gold"}">${item.mode === "review" ? "REVIEW" : "NEW"}</span>
        <span class="tag">${escapeHtml(skillLabel(word))}</span>
        <h2 class="word-text">${escapeHtml(word.word)}</h2>
        <button class="speak-button" type="button" data-action="speak-word" data-word="${escapeHtml(word.word)}" title="朗读单词">▶</button>
        <p class="phonetic">/${escapeHtml(word.phonetic)}/</p>
        <p class="word-prompt">你能准确说出它的主要含义吗？</p>
        <div class="rating-grid">
          <button class="rating-button" data-action="rate-word" data-rating="unknown">
            不认识
            <small>很快再次出现</small>
          </button>
          <button class="rating-button" data-action="rate-word" data-rating="fuzzy">
            模糊
            <small>需要更近复习</small>
          </button>
          <button class="rating-button" data-action="rate-word" data-rating="known">
            认识
            <small>延长复习间隔</small>
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderPendingWord(session) {
  const pending = ui.pendingGrade;
  const word = content.wordsById.get(pending?.item.wordId);
  if (!word) {
    ui.pendingGrade = null;
    return renderSessionScreen();
  }
  const progress = sessionProgress(session);
  const currentState =
    wordStateFor(pending.item.wordId) ||
    createWordState(pending.item.wordId);
  const previewState = applyRating(
    currentState,
    pending.rating,
    Date.now(),
    pending.responseMs,
  );
  const retryFeedback = pending.recallAnswer !== undefined
    ? `<div class="recall-result ${pending.recallCorrect ? "correct" : "wrong"}">
        ${pending.recallCorrect ? "拼写正确" : `你的答案：${escapeHtml(pending.recallAnswer || "未填写")}`}
      </div>`
    : "";

  return `
    <article class="session-card">
      <div class="session-kicker">
        <span>
          ${RATING_LABELS[pending.rating]} ·
          ${Math.round((pending.responseMs || 0) / 100) / 10} 秒
          · 确认后 Lv.${previewState.difficultyLevel}/10
        </span>
        <span>${progress.completedTotal}/${progress.plannedTotal}</span>
      </div>
      <div class="word-stage" style="min-height:240px">
        <h2 class="word-text">${escapeHtml(word.word)}</h2>
        <p class="phonetic">/${escapeHtml(word.phonetic)}/</p>
        <div class="answer-panel">
          ${retryFeedback}
          <h4>中文释义</h4>
          <p class="answer-meaning">${multiline(word.meaning)}</p>
          <h4>英文释义</h4>
          <p class="answer-definition">${escapeHtml(word.definition)}</p>
          ${wordMetaMarkup(word)}
          <div class="difficulty-preview">
            ${difficultyMarkup(previewState.difficultyLevel, previewState.hardFlag)}
            <span>等级越高，后续出现越频繁；连续三次未稳会标记为重点不会。</span>
          </div>
          <div class="correction-block">
            <div>
              <strong>评价有误？可以修改</strong>
              <span>修改后再确认，不会马上跳到下一词。</span>
            </div>
            <div class="correction-actions">
              ${Object.entries(RATING_LABELS)
                .map(
                  ([rating, label]) => `
                    <button
                      class="rating-button correction-choice ${pending.rating === rating ? "selected" : ""}"
                      data-action="change-pending-rating"
                      data-rating="${rating}"
                    >
                      ${label}
                    </button>
                  `,
                )
                .join("")}
            </div>
          </div>
          <div class="answer-footer">
            <span>
              来源：${escapeHtml(word.source?.name || "内容包")} ·
              词频序 ${escapeHtml(word.frequencyRank || "—")}
              ${pending.initialRating !== pending.rating ? `· 已从“${RATING_LABELS[pending.initialRating]}”改为“${RATING_LABELS[pending.rating]}”` : ""}
            </span>
            <button class="secondary-button" data-action="confirm-word-rating">
              确认并继续
            </button>
          </div>
        </div>
      </div>
    </article>
  `;
}

function renderBatchReview(session) {
  const visible = ui.batchMeaningsVisible;
  return `
    <article class="session-card">
      <div class="session-kicker">
        <span>五词回看 · 第 ${(session.completedBatchCount || 0) + 1} 组</span>
        <span>先自己回想，再统一核对释义</span>
      </div>
      <div class="batch-review">
        <div class="batch-review-heading">
          <div>
            <h2>刚才这五个词，真的记住了吗？</h2>
            <p>释义默认遮挡。先逐个回忆，再决定是否展开核对。</p>
          </div>
          <button class="secondary-button" data-action="toggle-batch-meanings">
            ${visible ? "重新遮挡释义" : "统一显示释义"}
          </button>
        </div>
        <table class="batch-table">
          <thead>
            <tr><th>单词</th><th>音标</th><th>类型</th><th>等级</th><th>释义</th></tr>
          </thead>
          <tbody>
            ${(session.batchWordIds || [])
              .map((wordId) => {
                const word = content.wordsById.get(wordId);
                const state = wordStateFor(wordId);
                const level = difficultyLevelOf(state);
                return `
                  <tr>
                    <td><strong>${escapeHtml(word?.word || wordId)}</strong></td>
                    <td>/${escapeHtml(word?.phonetic || "")}/</td>
                    <td><span class="tag">${escapeHtml(skillLabel(word))}</span></td>
                    <td>${difficultyMarkup(level, state?.hardFlag)}</td>
                    <td class="${visible ? "batch-meaning revealed" : "batch-meaning"}">
                      ${visible ? multiline(word?.meaning || "无释义") : "••••••"}
                    </td>
                  </tr>
                `;
              })
              .join("")}
          </tbody>
        </table>
        <div class="reading-actions">
          <button class="primary-button" data-action="complete-batch-review">核对完毕，继续</button>
        </div>
      </div>
    </article>
  `;
}

function readingAnalysisMarkup(reading) {
  const analysis = reading.analysis;
  const translationNotes = Array.isArray(reading.translationNotes)
    ? reading.translationNotes
    : [];
  if (!analysis && !translationNotes.length) {
    return "";
  }
  return `
    <section class="reading-study-notes">
      ${
        analysis
          ? `<div class="study-note-column">
              <h4>文章结构与题目关键点</h4>
              ${analysis.mainIdea ? `<p><strong>主旨：</strong>${escapeHtml(analysis.mainIdea)}</p>` : ""}
              ${
                analysis.structure?.length
                  ? `<ol>${analysis.structure.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`
                  : ""
              }
              ${
                analysis.questionTips?.length
                  ? `<div class="note-subtitle">解题提醒</div><ul>${analysis.questionTips
                      .map((item) => `<li>${escapeHtml(item)}</li>`)
                      .join("")}</ul>`
                  : ""
              }
            </div>`
          : ""
      }
      ${
        translationNotes.length
          ? `<div class="study-note-column">
              <h4>译文关键点</h4>
              <dl class="translation-notes">
                ${translationNotes
                  .map(
                    (note) => `
                      <div>
                        <dt>${escapeHtml(note.source)}</dt>
                        <dd>${escapeHtml(note.target)}</dd>
                      </div>
                    `,
                  )
                  .join("")}
              </dl>
            </div>`
          : ""
      }
    </section>
  `;
}

function readingMemoMarkup(attemptId) {
  const attempt = data.attempts.find((item) => item.id === attemptId);
  return `
    <section class="reading-memo">
      <div class="reading-memo-heading">
        <div>
          <h4>阅读备忘录</h4>
          <p>记录为什么做错、哪句没看懂、想补充的译文或下次要注意的地方。</p>
        </div>
        <span id="reading-memo-status" class="memo-status">
          ${attempt?.memo?.updatedAt ? "已保存" : "自动保存"}
        </span>
      </div>
      <textarea
        id="reading-memo"
        data-attempt-id="${escapeHtml(attemptId)}"
        placeholder="例如：第二题把作者态度读反了；关键句 actually rather than 是对比关系……"
      >${escapeHtml(attempt?.memo?.text || "")}</textarea>
    </section>
  `;
}

function renderReading(session) {
  const reading = content.readingsById.get(session.plan.readingId) ||
    content.readings.items[0];
  if (!reading) {
    return '<div class="empty-note">当前没有可用阅读材料。</div>';
  }

  if (!ui.readingStartedAt) {
    ui.readingStartedAt = Date.now();
  }

  if (ui.readingFeedback) {
    const hasQuestions = ui.readingFeedback.questionCount > 0;
    const percentage = hasQuestions
      ? Math.round(
          (ui.readingFeedback.correctCount / ui.readingFeedback.questionCount) *
            100,
        )
      : null;
    return `
      <article class="session-card">
        <div class="reading-header">
          <div>
            <span class="eyebrow">READING RESULT</span>
            <h2>${escapeHtml(reading.title)}</h2>
            <div class="source-line">${escapeHtml(reading.author)} · ${escapeHtml(reading.license)}</div>
          </div>
          <span class="tag ${percentage === null || percentage >= 60 ? "" : "red"}">${percentage === null ? "已读" : `${percentage}%`}</span>
        </div>
        <div class="reading-result ${percentage === null || percentage >= 60 ? "" : "wrong"}">
          ${hasQuestions
            ? `本次答对 ${ui.readingFeedback.correctCount}/${ui.readingFeedback.questionCount} 题。错题原因会写入本地报告。`
            : "这篇文章没有配置题目，正文和阅读时间已经保存，可在复盘中回看。"}
        </div>
        ${readingAnalysisMarkup(reading)}
        ${readingMemoMarkup(ui.readingFeedback.attemptId)}
        <div class="question-list">
          ${reading.questions
            .map((question, index) => {
              const selected = ui.readingFeedback.answers[question.id];
              const correct = selected === question.answerIndex;
              return `
                <div class="question">
                  <h4>${index + 1}. ${escapeHtml(question.prompt)}</h4>
                  <p class="muted">
                    你的答案：${escapeHtml(question.options[selected] ?? "未选择")}<br>
                    正确答案：${escapeHtml(question.options[question.answerIndex])}
                  </p>
                  <p class="${correct ? "muted" : ""}" style="${correct ? "" : "color:var(--red)"}">
                    ${escapeHtml(question.explanation)}
                  </p>
                </div>
              `;
            })
            .join("")}
        </div>
        <div class="reading-actions">
          <button class="primary-button" data-action="finish-reading-feedback">完成阅读</button>
        </div>
      </article>
    `;
  }

  if (!reading.questions.length) {
    return `
      <article class="session-card">
        <div class="reading-header">
          <div>
            <span class="eyebrow">READING · IMPORTED</span>
            <h2>${escapeHtml(reading.title)}</h2>
            <div class="source-line">
              ${escapeHtml(reading.author)} · ${reading.wordCount} words<br>
              ${escapeHtml(reading.license)}
            </div>
          </div>
          <span class="tag gold">${escapeHtml(reading.topic)}</span>
        </div>
        <div class="passage">${escapeHtml(reading.text)}</div>
        <div class="reading-actions">
          <button class="primary-button" data-action="complete-open-reading">完成阅读</button>
        </div>
      </article>
    `;
  }

  return `
    <article class="session-card">
      <div class="reading-header">
        <div>
          <span class="eyebrow">READING · ${escapeHtml(reading.level.toUpperCase())}</span>
          <h2>${escapeHtml(reading.title)}</h2>
          <div class="source-line">
            ${escapeHtml(reading.author)} · ${reading.wordCount} words<br>
            ${escapeHtml(reading.license)} ·
            <a href="${escapeHtml(reading.sourceUrl)}" target="_blank" rel="noreferrer">原文来源</a>
          </div>
        </div>
        <span class="tag gold">${escapeHtml(reading.topic)}</span>
      </div>
      <div class="passage">${escapeHtml(reading.text)}</div>
      <form id="reading-form">
        <div class="question-list">
          ${reading.questions
            .map(
              (question, index) => `
                <fieldset class="question" style="border:1px solid rgba(23,60,53,.1);margin:0">
                  <legend class="muted" style="padding:0 6px">Question ${index + 1}</legend>
                  <h4>${escapeHtml(question.prompt)}</h4>
                  ${question.options
                    .map(
                      (option, optionIndex) => `
                        <label class="choice">
                          <input type="radio" name="${escapeHtml(question.id)}" value="${optionIndex}" required>
                          <span>${String.fromCharCode(65 + optionIndex)}. ${escapeHtml(option)}</span>
                        </label>
                      `,
                    )
                    .join("")}
                </fieldset>
              `,
            )
            .join("")}
        </div>
        <div class="reading-actions">
          <button class="ghost-button" type="button" data-action="skip-reading">这次跳过</button>
          <button class="primary-button" type="submit">提交答案</button>
        </div>
      </form>
    </article>
  `;
}

function renderComplete(session) {
  const attempts = sessionAttempts(session.id);
  const wordAttempts = attempts.filter((attempt) => attempt.itemType === "word");
  const wordCount = new Set(wordAttempts.map((attempt) => attempt.itemId)).size;
  const deferredCount = new Set(session.deferredWordIds || []).size;
  return `
    <article class="session-card">
      <div class="complete-state">
        <div class="completion-mark">✓</div>
        <h2>本次任务已经完成</h2>
        <p>点击“保存并结束”后，本次时间、重学过程和阅读表现会写入本地记录。</p>
        <div class="complete-stats">
          <div class="metric"><div class="metric-label">涉及单词</div><div class="metric-value">${wordCount}</div></div>
          <div class="metric"><div class="metric-label">作答次数</div><div class="metric-value">${wordAttempts.length}</div></div>
          <div class="metric"><div class="metric-label">留待后续加强</div><div class="metric-value">${deferredCount}</div></div>
        </div>
        <div class="complete-actions">
          <button class="primary-button" data-action="end-session">保存并结束</button>
        </div>
      </div>
    </article>
  `;
}

function renderSessionScreen() {
  const session = ui.activeSession;
  if (!session) {
    return renderHome();
  }

  if (ui.pendingGrade) {
    return shellMarkup(`
      <div class="session-screen screen">
        ${sessionToolbar(session)}
        ${renderPendingWord(session)}
      </div>
    `);
  }

  if (session.batchReviewPending) {
    return shellMarkup(`
      <div class="session-screen screen">
        ${sessionToolbar(session)}
        ${renderBatchReview(session)}
      </div>
    `);
  }

  const unresolved = unresolvedSessionTasks(session);
  if (unresolved.length) {
    return shellMarkup(`
      <div class="session-screen screen">
        ${sessionToolbar(session)}
        ${renderWordCard(session, unresolved[0])}
      </div>
    `);
  }

  const readingAttempt = readingAttemptForSession(session.id);
  if (session.plan.readingIncluded && readingAttempt && ui.readingFeedback) {
    return shellMarkup(`
      <div class="session-screen screen">
        ${sessionToolbar(session)}
        ${renderReading(session)}
      </div>
    `);
  }

  if (session.plan.readingIncluded && !readingAttempt) {
    return shellMarkup(`
      <div class="session-screen screen">
        ${sessionToolbar(session)}
        ${renderReading(session)}
      </div>
    `);
  }

  return shellMarkup(`
    <div class="session-screen screen">
      ${sessionToolbar(session)}
      ${renderComplete(session)}
    </div>
  `);
}

function reportViewModelForDay(dayKey) {
  return buildReport({
    dayKey,
    attempts: data.attempts,
    sessions: data.sessions,
    wordStates: data.wordStates,
    words: content.words.items,
    readingPack: content.readings,
  });
}

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function renderDetailedHistory(dayKey) {
  const attempts = data.attempts
    .filter((attempt) => attempt.day === dayKey)
    .sort((left, right) => left.timestamp - right.timestamp);
  const wordAttempts = attempts.filter((attempt) => attempt.itemType === "word");
  const readingAttempts = attempts.filter(
    (attempt) => attempt.itemType === "reading",
  );

  if (!attempts.length) {
    return '<div class="empty-note">这一天还没有详细学习记录。</div>';
  }

  return `
    <div class="history-section">
      <div class="history-heading">
        <strong>单词作答流水</strong>
        <span>${wordAttempts.length} 次</span>
      </div>
      ${
        wordAttempts.length
          ? `<div class="history-table-wrap">
              <table class="report-table history-table">
                <thead><tr><th>时间</th><th>单词</th><th>轮次</th><th>最终评价</th><th>修正/回忆</th></tr></thead>
                <tbody>
                  ${wordAttempts
                    .map((attempt) => {
                      const word =
                        attempt.wordSnapshot ||
                        content.wordsById.get(attempt.itemId);
                      const correction =
                        attempt.initialRating &&
                        attempt.initialRating !== attempt.rating
                          ? `原为${RATING_LABELS[attempt.initialRating]}`
                          : attempt.recallAnswer !== undefined
                            ? attempt.recallCorrect
                              ? attempt.recallType === "meaning-choice"
                                ? "词义选择正确"
                                : "拼写回忆正确"
                              : `${attempt.recallType === "meaning-choice" ? "误选" : "拼写"}：${attempt.recallAnswer || "未填写"}`
                            : "—";
                      return `
                        <tr>
                          <td>${timeLabel(attempt.timestamp)}</td>
                          <td>
                            <strong>${escapeHtml(word?.word || attempt.itemId)}</strong>
                            <div class="history-word-meaning">${escapeHtml((word?.meaning || "").split("\n")[0])}</div>
                          </td>
                          <td>${attempt.cardAttemptNumber || 1}</td>
                          <td>${escapeHtml(RATING_LABELS[attempt.rating] || attempt.rating)}</td>
                          <td>${escapeHtml(correction)}</td>
                        </tr>
                      `;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>`
          : '<div class="empty-note">没有单词记录。</div>'
      }
    </div>
    <div class="history-section">
      <div class="history-heading">
        <strong>阅读原文与答题</strong>
        <span>${readingAttempts.length} 次</span>
      </div>
      ${
        readingAttempts.length
          ? readingAttempts
              .map((attempt, attemptIndex) => {
                const reading =
                  attempt.readingSnapshot ||
                  content.readingsById.get(attempt.itemId);
                if (!reading) {
                  return `<div class="empty-note">阅读原文快照缺失：${escapeHtml(attempt.itemId)}</div>`;
                }
                const skipped = attempt.skipped;
                const hasQuestions = (attempt.questionCount || 0) > 0;
                const percentage =
                  skipped || !hasQuestions
                    ? null
                    : Math.round(
                        ((attempt.correctCount || 0) / attempt.questionCount) *
                          100,
                      );
                return `
                  <details class="history-reading" ${readingAttempts.length === 1 ? "open" : ""}>
                    <summary>
                      <span>${escapeHtml(reading.title)}</span>
                      <span>${skipped ? "已跳过" : hasQuestions ? `${attempt.correctCount}/${attempt.questionCount} · ${percentage}%` : "已完成阅读"}</span>
                    </summary>
                    <div class="history-reading-body">
                      <div class="source-line">
                        ${escapeHtml(reading.author || "")} ·
                        ${escapeHtml(reading.license || "")} ·
                        ${timeLabel(attempt.timestamp)}
                      </div>
                      <div class="passage history-passage">${escapeHtml(reading.text)}</div>
                      ${readingAnalysisMarkup(reading)}
                      <div class="question-list">
                        ${(reading.questions || [])
                          .map((question, questionIndex) => {
                            const selected = attempt.answers?.[question.id];
                            const correct =
                              !skipped && selected === question.answerIndex;
                            return `
                              <div class="question">
                                <h4>${questionIndex + 1}. ${escapeHtml(question.prompt)}</h4>
                                <p class="muted">
                                  你的答案：${skipped ? "未作答" : escapeHtml(question.options[selected] ?? "未选择")}<br>
                                  正确答案：${escapeHtml(question.options[question.answerIndex])}
                                </p>
                                <p style="${correct ? "color:var(--forest-2)" : "color:var(--red)"}">
                                  ${correct ? "回答正确。" : ""}${escapeHtml(question.explanation)}
                                </p>
                              </div>
                            `;
                          })
                          .join("")}
                      </div>
                      ${
                        attempt.memo?.text
                          ? `<div class="history-memo">
                              <strong>阅读备忘录</strong>
                              <p>${multiline(attempt.memo.text)}</p>
                            </div>`
                          : ""
                      }
                    </div>
                  </details>
                `;
              })
              .join("")
          : '<div class="empty-note">没有阅读记录。</div>'
      }
    </div>
  `;
}

function renderReport() {
  const report = reportViewModelForDay(ui.reportDay);
  return shellMarkup(`
    <div class="screen">
      <div class="report-heading">
        <div>
          <span class="eyebrow">LOCAL REVIEW</span>
          <h2>学习复盘</h2>
          <p>报告由本地脚本生成，不调用外部 API。</p>
        </div>
        <div class="hero-actions">
          <input
            id="report-date"
            type="date"
            value="${escapeHtml(ui.reportDay)}"
            data-action="change-report-date"
            style="padding:11px 13px;border:1px solid var(--line);border-radius:10px;background:var(--paper)"
          >
          <button class="secondary-button" data-action="export-daily-markdown">导出本日摘要</button>
        </div>
      </div>
      <div class="report-layout">
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h3>${escapeHtml(formatDateLabel(report.dayKey))}</h3>
                <p>${report.sessionCount ? "记录的是实际完成的会话，不计算漏掉的日期。" : "这一天没有完成会话。"}</p>
              </div>
              <span class="tag ${report.activeSeconds ? "" : "red"}">${formatDuration(report.activeSeconds)}</span>
            </div>
            <div class="metric-grid">
              <div class="metric"><div class="metric-label">单词答题</div><div class="metric-value">${report.wordAttemptCount}</div><div class="metric-note">新词 ${report.newWordCount} / 复习 ${report.reviewCount}</div></div>
              <div class="metric"><div class="metric-label">不认识</div><div class="metric-value">${report.ratingCounts.unknown}</div><div class="metric-note">模糊 ${report.ratingCounts.fuzzy} / 认识 ${report.ratingCounts.known}</div></div>
              <div class="metric"><div class="metric-label">平均反应</div><div class="metric-value">${report.averageResponseMs ? `${Math.round(report.averageResponseMs / 100) / 10}s` : "—"}</div><div class="metric-note">从单词出现到选择评价</div></div>
              <div class="metric"><div class="metric-label">阅读正确率</div><div class="metric-value">${report.readingAccuracy === null ? "—" : `${Math.round(report.readingAccuracy * 100)}%`}</div><div class="metric-note">${report.readingResults.length} 次阅读</div></div>
            </div>
          </article>

          <article class="card">
            <div class="card-header">
              <div>
                <h3>今日详细记录</h3>
                <p>可以回看每次评价修正、重学轮次以及完整阅读原文。</p>
              </div>
            </div>
            ${renderDetailedHistory(report.dayKey)}
          </article>

          <article class="card">
            <div class="card-header">
              <div>
                <h3>需要补强的词</h3>
                <p>同日出现模糊或不认识的词会排在前面。</p>
              </div>
            </div>
            ${
              report.weakWords.length
                ? `<table class="report-table">
                    <thead><tr><th>单词</th><th>中文释义</th><th>未稳次数</th></tr></thead>
                    <tbody>
                      ${report.weakWords
                        .map(
                          (word) => `
                            <tr>
                              <td><strong>${escapeHtml(word.word)}</strong></td>
                              <td>${escapeHtml((word.meaning || "").split("\n")[0])}</td>
                              <td>${word.missCount}</td>
                            </tr>
                          `,
                        )
                        .join("")}
                    </tbody>
                  </table>`
                : '<div class="empty-note">今天没有出现需要补强的单词。</div>'
            }
          </article>
        </div>
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h3>本地判断</h3>
                <p>会根据下一次真实数据重新计算。</p>
              </div>
            </div>
            <ul class="recommendation-list">
              ${report.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </article>
          <article class="card">
            <div class="card-header">
              <div>
                <h3>周期检查包</h3>
                <p>每 3–7 天导出一次，可在本对话中复盘调整。</p>
              </div>
            </div>
            <div class="report-actions" style="flex-direction:column">
              <button class="primary-button" data-action="feedback-now" style="width:100%">生成反馈包 JSON</button>
              <button class="secondary-button" data-action="export-checkpoint-markdown" style="width:100%">导出可读摘要 Markdown</button>
            </div>
            <div class="notice" style="margin-top:15px">
              检查包包含答题时间、评价、阅读原文、题目与解析，不包含管理员密码或 API Key。分享前请确认其中的文章允许共享。
            </div>
          </article>
        </div>
      </div>
    </div>
  `);
}

function isAdminUnlocked() {
  return ui.adminUnlockedUntil > Date.now();
}

function requireAdmin() {
  if (isAdminUnlocked()) {
    return true;
  }
  showToast("请先在“数据”页输入管理员密码。");
  return false;
}

function adminPanelMarkup() {
  if (!isAdminConfigured()) {
    return `
      <article class="card admin-card" id="admin-panel">
        <div class="card-header">
          <div>
            <h3>设置管理员密码</h3>
            <p>为内容替换和备份恢复增加一道本机操作保护。</p>
          </div>
          <span class="tag gold">未设置</span>
        </div>
        <form id="set-admin-password-form" class="account-form compact-account-form">
          <label class="form-field">
            <span>管理员密码</span>
            <input name="adminPassword" type="password" minlength="6" autocomplete="new-password" placeholder="至少 6 个字符" required>
          </label>
          <label class="form-field">
            <span>再次输入</span>
            <input name="adminPasswordConfirm" type="password" minlength="6" autocomplete="new-password" placeholder="确认密码" required>
          </label>
          <button class="primary-button" type="submit">设置并解锁</button>
        </form>
      </article>
    `;
  }

  if (!isAdminUnlocked()) {
    return `
      <article class="card admin-card" id="admin-panel">
        <div class="card-header">
          <div>
            <h3>管理员修改</h3>
            <p>输入密码后才能导入内容或恢复备份。</p>
          </div>
          <span class="tag">已锁定</span>
        </div>
        <form id="admin-unlock-form" class="account-form compact-account-form">
          <label class="form-field">
            <span>管理员密码</span>
            <input id="admin-unlock-password" name="adminPassword" type="password" autocomplete="current-password" placeholder="输入管理员密码" required>
          </label>
          <button class="primary-button" type="submit">解锁修改</button>
        </form>
        <div class="admin-security-note">
          解锁状态保留 30 分钟。用户学习本身不需要密码。
        </div>
      </article>
    `;
  }

  return `
    <article class="card admin-card" id="admin-panel">
      <div class="card-header">
        <div>
          <h3>管理员已解锁</h3>
          <p>内容导入、恢复备份和内容重载已开放。</p>
        </div>
        <span class="tag">可修改</span>
      </div>
      <button class="secondary-button full-button" type="button" data-action="lock-admin">立即锁定</button>
      <details class="admin-details">
        <summary>修改管理员密码</summary>
        <form id="change-admin-password-form" class="account-form compact-account-form">
          <label class="form-field">
            <span>当前密码</span>
            <input name="currentPassword" type="password" autocomplete="current-password" required>
          </label>
          <label class="form-field">
            <span>新密码</span>
            <input name="newPassword" type="password" minlength="6" autocomplete="new-password" placeholder="至少 6 个字符" required>
          </label>
          <label class="form-field">
            <span>再次输入新密码</span>
            <input name="newPasswordConfirm" type="password" minlength="6" autocomplete="new-password" required>
          </label>
          <button class="secondary-button" type="submit">更新密码</button>
        </form>
      </details>
    </article>
  `;
}

function renderData() {
  const backupSize = data.attempts.length;
  const unlocked = isAdminUnlocked();
  return shellMarkup(`
    <div class="screen">
      <div class="report-heading">
        <div>
          <span class="eyebrow">CONTENT & DATA</span>
          <h2>${escapeHtml(ui.currentAccount?.name || "")}的内容与数据</h2>
          <p>学习记录按账号独立保存，修改类操作由管理员密码保护。</p>
        </div>
        ${
          unlocked
            ? '<button class="secondary-button" data-action="refresh-content">重新加载内容包</button>'
            : '<button class="secondary-button" data-action="focus-admin">管理员解锁</button>'
        }
      </div>
      <div class="report-layout">
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h3>当前内容包</h3>
                <p>用户可以直接学习；替换和导入需要管理员权限。</p>
              </div>
              <span class="tag">${escapeHtml(content.manifest.updatedAt.slice(0, 10))}</span>
            </div>
            <div class="content-list">
              <div class="content-item">
                <div>
                  <strong>${escapeHtml(content.words.title)}</strong>
                  <span>${content.words.items.length} 词 · 版本 ${escapeHtml(content.words.version)} · ${escapeHtml(content.words.license?.name || "自定义内容")}</span>
                </div>
                <div class="content-actions">
                  ${
                    unlocked
                      ? `${content.words.custom ? '<button class="ghost-button" data-action="reset-word-pack">恢复默认</button>' : ""}
                         <button class="secondary-button" data-action="trigger-word-import">导入词表</button>`
                      : '<span class="locked-action">管理员可修改</span>'
                  }
                </div>
              </div>
              <div class="content-item">
                <div>
                  <strong>${escapeHtml(content.readings.title)}</strong>
                  <span>${content.readings.items.length} 篇文章 · 版本 ${escapeHtml(content.readings.version)} · ${escapeHtml(content.readings.license?.name || "自定义内容")}</span>
                </div>
                <div class="content-actions">
                  ${
                    unlocked
                      ? `${content.readings.custom ? '<button class="ghost-button" data-action="reset-reading-pack">恢复默认</button>' : ""}
                         <button class="secondary-button" data-action="trigger-reading-import">导入文章</button>`
                      : '<span class="locked-action">管理员可修改</span>'
                  }
                </div>
              </div>
            </div>
            <input id="word-pack-file" type="file" accept=".json,.csv,application/json,text/csv" hidden>
            <input id="reading-pack-file" type="file" accept=".json,.md,.txt,application/json,text/markdown,text/plain" hidden>
            <div class="notice" style="margin-top:15px">
              ${escapeHtml(content.readings.attribution || "自定义内容由用户本地导入。")}
            </div>
          </article>

          <article class="card">
            <div class="card-header">
              <div>
                <h3>内容文件</h3>
                <p>学习记录按稳定 ID 关联，不随内容包覆盖而清除。</p>
              </div>
            </div>
            <table class="report-table">
              <tbody>
                <tr><td>单词包</td><td><code>content/${escapeHtml(content.manifest.wordPack)}</code></td></tr>
                <tr><td>阅读包</td><td><code>content/${escapeHtml(content.manifest.readingPack)}</code></td></tr>
                <tr><td>内容索引</td><td><code>content/manifest.json</code></td></tr>
              </tbody>
            </table>
          </article>
        </div>
        <div class="stack">
          <article class="card">
            <div class="card-header">
              <div>
                <h3>${escapeHtml(ui.currentAccount?.name || "")}的本地数据</h3>
                <p>${backupSize} 条答题记录 · ${data.sessions.length} 次会话</p>
              </div>
            </div>
            <div class="report-actions" style="flex-direction:column">
              <button class="primary-button" data-action="export-backup" style="width:100%">导出完整备份</button>
              ${
                unlocked
                  ? '<button class="secondary-button" data-action="trigger-import-backup" style="width:100%">从备份恢复</button>'
                  : '<button class="secondary-button" data-action="focus-admin" style="width:100%">解锁后恢复备份</button>'
              }
            </div>
            <input id="backup-file" type="file" accept="application/json,.json" hidden>
            <div class="notice" style="margin-top:15px">
              该账号的数据只保存在当前浏览器。清除站点数据或更换手机前，请先导出备份。
            </div>
          </article>
          ${adminPanelMarkup()}
          <article class="card">
            <div class="card-header">
              <div>
                <h3>账号与隐私边界</h3>
                <p>当前为本地账号，不会把学习记录上传到远程后台。</p>
              </div>
            </div>
            <ul class="recommendation-list">
              <li>账号用于区分同一设备上的不同使用者。</li>
              <li>账号之间使用独立的浏览器数据库。</li>
              <li>每日报告在本地由脚本计算。</li>
              <li>管理员密码不会以明文保存。</li>
              <li>API Key 不应保存在内容包或学习记录中。</li>
            </ul>
          </article>
        </div>
      </div>
    </div>
  `);
}

function render() {
  if (ui.page === "session" && ui.activeSession) {
    app.innerHTML = renderSessionScreen();
  } else if (ui.page === "report") {
    app.innerHTML = renderReport();
  } else if (ui.page === "data") {
    app.innerHTML = renderData();
  } else {
    ui.page = "today";
    app.innerHTML = renderHome();
  }
  updateTimerDisplay();
}

async function createSession() {
  if (ui.activeSession) {
    ui.page = "session";
    render();
    return;
  }

  const plan = buildPreviewPlan();
  const previousReadingIds = data.attempts
    .filter((attempt) => attempt.itemType === "reading")
    .map((attempt) => attempt.itemId);
  const reading = plan.readingIncluded
    ? chooseReading(content.readings.items, previousReadingIds, "foundation")
    : null;

  if (!plan.tasks.length && !reading) {
    showToast("当前没有到期复习或新词，也没有可安排的阅读。");
    return;
  }

  const now = Date.now();
  const session = {
    id: makeId("session"),
    day: localDayKey(),
    startedAt: now,
    endedAt: null,
    status: "active",
    activeSeconds: 0,
    queue: buildInitialQueue(plan.tasks),
    deferredWordIds: [],
    batchWordIds: [],
    batchReviewPending: false,
    completedBatchCount: 0,
    plan: {
      ...plan,
      readingId: reading?.id || null,
      content: {
        wordPack: content.words.version,
        readingPack: content.readings.version,
      },
    },
  };

  await putRecord(STORES.sessions, session);
  ui.activeSession = session;
  ui.page = "session";
  ui.currentTaskId = null;
  ui.cardShownAt = null;
  ui.pendingGrade = null;
  ui.readingFeedback = null;
  ui.readingStartedAt = null;
  startTimer(session.id);
  render();
}

function beginWordRating(rating) {
  const item = unresolvedSessionTasks(ui.activeSession)[0];
  if (!item || !Object.values(RATINGS).includes(rating)) {
    return;
  }

  const word = content.wordsById.get(item.wordId);
  if (!word) {
    return;
  }

  ui.pendingGrade = {
    item,
    initialRating: rating,
    rating,
    responseMs: Math.max(0, Date.now() - (ui.cardShownAt || Date.now())),
  };
  render();
}

function changePendingRating(rating) {
  if (!ui.pendingGrade || !Object.values(RATINGS).includes(rating)) {
    return;
  }
  ui.pendingGrade.rating = rating;
  render();
}

function submitRetryRecall(form) {
  const item = unresolvedSessionTasks(ui.activeSession)[0];
  const word = content.wordsById.get(item?.wordId);
  if (!item || !word) {
    return;
  }

  const answer = String(new FormData(form).get("retryAnswer") || "");
  const recallCorrect =
    normalizeRecallAnswer(answer) === normalizeRecallAnswer(word.word);
  const rating = recallCorrect ? RATINGS.known : RATINGS.unknown;
  ui.pendingGrade = {
    item,
    initialRating: rating,
    rating,
    responseMs: Math.max(0, Date.now() - (ui.cardShownAt || Date.now())),
    recallAnswer: answer.trim(),
    recallCorrect,
    recallType: "spelling",
  };
  render();
}

function submitRetryChoice(form) {
  const item = unresolvedSessionTasks(ui.activeSession)[0];
  if (!item) {
    return;
  }
  const selected = form.querySelector('input[name="meaningChoice"]:checked');
  if (!selected) {
    showToast("请选择一个释义。");
    return;
  }
  const recallCorrect = selected.dataset.correct === "true";
  const rating = recallCorrect ? RATINGS.known : RATINGS.unknown;
  ui.pendingGrade = {
    item,
    initialRating: rating,
    rating,
    responseMs: Math.max(0, Date.now() - (ui.cardShownAt || Date.now())),
    recallAnswer:
      selected.closest("label")?.querySelector("span")?.innerText || "",
    recallCorrect,
    recallType: "meaning-choice",
  };
  render();
}

function revealRetryAnswer() {
  const item = unresolvedSessionTasks(ui.activeSession)[0];
  if (!item) {
    return;
  }
  ui.pendingGrade = {
    item,
    initialRating: RATINGS.unknown,
    rating: RATINGS.unknown,
    responseMs: Math.max(0, Date.now() - (ui.cardShownAt || Date.now())),
    recallAnswer: "",
    recallCorrect: false,
    recallType: wordSkills(content.wordsById.get(item.wordId)).includes("writing")
      ? "spelling"
      : "meaning-choice",
  };
  render();
}

async function confirmPendingWord() {
  const pending = ui.pendingGrade;
  const session = ui.activeSession;
  if (!pending || !session) {
    return;
  }

  const queue = sessionQueue(session);
  const current = queue[0];
  if (!current || current.cardKey !== pending.item.cardKey) {
    showToast("当前单词已经变化，请重新作答。");
    ui.pendingGrade = null;
    render();
    return;
  }

  const previous =
    data.wordStates.find((state) => state.id === current.wordId) ||
    createWordState(current.wordId);
  const word = content.wordsById.get(current.wordId);
  if (!word) {
    showToast("当前词条已不在内容包中，无法保存。");
    return;
  }
  const nextState = applyRating(previous, pending.rating);
  const queueResult = advanceLearningQueue(
    queue,
    current,
    pending.rating,
  );
  const deferredWordIds = new Set(session.deferredWordIds || []);
  if (queueResult.deferred) {
    deferredWordIds.add(current.wordId);
  }
  const batchWordIds = [...(session.batchWordIds || [])];
  if (!batchWordIds.includes(current.wordId) && batchWordIds.length < 5) {
    batchWordIds.push(current.wordId);
  }

  const updatedSession = {
    ...session,
    queue: queueResult.queue,
    deferredWordIds: [...deferredWordIds],
    batchWordIds,
    batchReviewPending: batchWordIds.length >= 5,
    updatedAt: Date.now(),
  };
  const attempt = {
    id: makeId("attempt"),
    sessionId: session.id,
    day: localDayKey(),
    timestamp: Date.now(),
    itemType: "word",
    itemId: current.wordId,
    mode: current.mode,
    cardAttemptNumber: current.attemptNumber,
    initialRating: pending.initialRating,
    rating: pending.rating,
    ratingChanged: pending.initialRating !== pending.rating,
    recallAnswer: pending.recallAnswer,
    recallCorrect: pending.recallCorrect,
    recallType: pending.recallType,
    responseMs: pending.responseMs,
    requeued: queueResult.requeued,
    deferred: queueResult.deferred,
    difficultyLevel: nextState.difficultyLevel,
    hardFlag: nextState.hardFlag,
    wordSnapshot: {
      word: word.word,
      phonetic: word.phonetic,
      meaning: word.meaning,
      definition: word.definition,
      tags: [...(word.tags || [])],
      exchange: word.exchange || "",
      skills: wordSkills(word),
    },
    packVersion: content.words.version,
  };

  await saveWordTurn({
    session: updatedSession,
    wordState: nextState,
    attempt,
  });

  const existingIndex = data.wordStates.findIndex(
    (state) => state.id === current.wordId,
  );
  if (existingIndex >= 0) {
    data.wordStates[existingIndex] = nextState;
  } else {
    data.wordStates.push(nextState);
  }
  data.attempts.push(attempt);
  const sessionIndex = data.sessions.findIndex((item) => item.id === session.id);
  if (sessionIndex >= 0) {
    data.sessions[sessionIndex] = updatedSession;
  }
  ui.activeSession = updatedSession;
  ui.pendingGrade = null;
  ui.currentTaskId = null;
  ui.cardShownAt = null;
  if (updatedSession.batchReviewPending) {
    ui.batchMeaningsVisible = false;
  }

  if (queueResult.requeued) {
    const delay = pending.rating === RATINGS.unknown ? 4 : 3;
    showToast(`将在约 ${delay} 张卡后再次出现。`);
  } else if (queueResult.deferred) {
    showToast("该词已标记为后续重点，会继续在后续复习中出现。");
  }
  render();
}

async function completeBatchReview() {
  const session = ui.activeSession;
  if (!session) {
    return;
  }
  const updatedSession = {
    ...session,
    batchWordIds: [],
    batchReviewPending: false,
    completedBatchCount: (session.completedBatchCount || 0) + 1,
    updatedAt: Date.now(),
  };
  await putRecord(STORES.sessions, updatedSession);
  const sessionIndex = data.sessions.findIndex(
    (item) => item.id === session.id,
  );
  if (sessionIndex >= 0) {
    data.sessions[sessionIndex] = updatedSession;
  }
  ui.activeSession = updatedSession;
  ui.batchMeaningsVisible = false;
  render();
}

async function submitReading(form) {
  const reading = content.readingsById.get(ui.activeSession.plan.readingId) ||
    content.readings.items[0];
  if (!reading) {
    return;
  }

  const formData = new FormData(form);
  const answers = {};
  let correctCount = 0;

  for (const question of reading.questions) {
    const value = formData.get(question.id);
    if (value === null) {
      showToast("请完成所有题目后再提交。");
      return;
    }
    const selected = Number(value);
    answers[question.id] = selected;
    if (selected === question.answerIndex) {
      correctCount += 1;
    }
  }

  const questionCount = reading.questions.length;
  const readingSnapshot = {
    id: reading.id,
    title: reading.title,
    level: reading.level,
    topic: reading.topic,
    wordCount: reading.wordCount,
    text: reading.text,
    author: reading.author,
    sourceUrl: reading.sourceUrl,
    license: reading.license,
    analysis: reading.analysis,
    translationNotes: reading.translationNotes,
    questions: reading.questions.map((question) => ({
      ...question,
      options: [...question.options],
    })),
  };
  const attempt = {
    id: makeId("attempt"),
    sessionId: ui.activeSession.id,
    day: localDayKey(),
    timestamp: Date.now(),
    itemType: "reading",
    itemId: reading.id,
    mode: "reading",
    rating:
      correctCount === questionCount
        ? RATINGS.known
        : correctCount > 0
          ? RATINGS.fuzzy
          : RATINGS.unknown,
    responseMs: Math.max(0, Date.now() - (ui.readingStartedAt || Date.now())),
    correctCount,
    questionCount,
    answers,
    skipped: false,
    readingSnapshot,
    packVersion: content.readings.version,
  };

  await putRecord(STORES.attempts, attempt);
  data.attempts.push(attempt);
  ui.readingFeedback = {
    correctCount,
    questionCount,
    answers,
    attemptId: attempt.id,
  };
  render();
}

async function completeOpenReading() {
  const reading = content.readingsById.get(ui.activeSession.plan.readingId) ||
    content.readings.items[0];
  if (!reading) {
    return;
  }
  const attempt = {
    id: makeId("attempt"),
    sessionId: ui.activeSession.id,
    day: localDayKey(),
    timestamp: Date.now(),
    itemType: "reading",
    itemId: reading.id,
    mode: "reading",
    rating: RATINGS.known,
    responseMs: Math.max(0, Date.now() - (ui.readingStartedAt || Date.now())),
    correctCount: 0,
    questionCount: 0,
    answers: {},
    skipped: false,
    readingSnapshot: {
      id: reading.id,
      title: reading.title,
      level: reading.level,
      topic: reading.topic,
      wordCount: reading.wordCount,
      text: reading.text,
      author: reading.author,
      sourceUrl: reading.sourceUrl,
      license: reading.license,
      analysis: reading.analysis,
      translationNotes: reading.translationNotes,
      questions: [],
    },
    packVersion: content.readings.version,
  };
  await putRecord(STORES.attempts, attempt);
  data.attempts.push(attempt);
  ui.readingFeedback = {
    correctCount: 0,
    questionCount: 0,
    answers: {},
    attemptId: attempt.id,
  };
  render();
}

async function saveReadingMemo(silent = false) {
  const textarea = document.querySelector("#reading-memo");
  const attemptId = textarea?.dataset.attemptId || ui.readingFeedback?.attemptId;
  if (!attemptId) {
    return;
  }
  const attempt = data.attempts.find((item) => item.id === attemptId);
  if (!attempt) {
    return;
  }

  const updatedAttempt = {
    ...attempt,
    memo: {
      text:
        textarea?.value ??
        ui.readingFeedback?.memoDraft ??
        attempt.memo?.text ??
        "",
      updatedAt: new Date().toISOString(),
    },
  };
  await putRecord(STORES.attempts, updatedAttempt);
  const index = data.attempts.findIndex((item) => item.id === attemptId);
  if (index >= 0) {
    data.attempts[index] = updatedAttempt;
  }
  const status = document.querySelector("#reading-memo-status");
  if (status) {
    status.textContent = "已自动保存";
  }
  if (!silent) {
    showToast("阅读备忘录已保存。");
  }
}

async function skipReading() {
  const reading = content.readingsById.get(ui.activeSession.plan.readingId) ||
    content.readings.items[0];
  if (!reading) {
    return;
  }

  const attempt = {
    id: makeId("attempt"),
    sessionId: ui.activeSession.id,
    day: localDayKey(),
    timestamp: Date.now(),
    itemType: "reading",
    itemId: reading.id,
    mode: "reading",
    rating: RATINGS.unknown,
    responseMs: Math.max(0, Date.now() - (ui.readingStartedAt || Date.now())),
    correctCount: 0,
    questionCount: reading.questions.length,
    answers: {},
    skipped: true,
    readingSnapshot: {
      id: reading.id,
      title: reading.title,
      level: reading.level,
      topic: reading.topic,
      wordCount: reading.wordCount,
      text: reading.text,
      author: reading.author,
      sourceUrl: reading.sourceUrl,
      license: reading.license,
      analysis: reading.analysis,
      translationNotes: reading.translationNotes,
      questions: reading.questions.map((question) => ({
        ...question,
        options: [...question.options],
      })),
    },
    packVersion: content.readings.version,
  };
  await putRecord(STORES.attempts, attempt);
  data.attempts.push(attempt);
  ui.readingStartedAt = null;
  render();
}

async function finishSession(force = false) {
  const session = ui.activeSession;
  if (!session) {
    return;
  }

  if (
    ui.pendingGrade &&
    !window.confirm("当前单词的评价还没有确认，结束将不会记录这一次作答。继续吗？")
  ) {
    return;
  }

  const unresolved = unresolvedSessionTasks(session);
  const readingDone = Boolean(readingAttemptForSession(session.id));
  const isComplete =
    !unresolved.length &&
    (!session.plan.readingIncluded || readingDone) &&
    !session.batchReviewPending;

  if (
    !force &&
    !isComplete &&
    !window.confirm("本次还有未完成任务。结束会保留已做内容，未完成项不会补账。继续吗？")
  ) {
    return;
  }

  if (ui.timer?.runningSince) {
    ui.timer.accumulatedMs = timerElapsedMs();
    ui.timer.runningSince = null;
  }

  const completedSession = {
    ...session,
    status: "completed",
    endedAt: Date.now(),
    activeSeconds: Math.max(1, Math.round(timerElapsedMs() / 1000)),
    completedWords: sessionAttempts(session.id).filter(
      (attempt) => attempt.itemType === "word",
    ).length,
    readingDone,
  };

  await putRecord(STORES.sessions, completedSession);
  localStorage.removeItem(timerStorageKey());
  ui.activeSession = null;
  ui.timer = null;
  ui.pendingGrade = null;
  ui.readingFeedback = null;
  ui.readingStartedAt = null;
  ui.currentTaskId = null;
  ui.cardShownAt = null;
  await refreshData();
  ui.reportDay = completedSession.day;
  ui.page = "report";
  render();
  showToast("本次学习已保存到本地。");
}

function dailyReportMarkdown(dayKey) {
  const report = reportViewModelForDay(dayKey);
  const lines = [
    `# 滴水英语每日摘要 · ${dayKey}`,
    "",
    `- 账号：${ui.currentAccount?.name || "未命名账号"}`,
    `- 完成会话：${report.sessionCount}`,
    `- 有效学习：${formatDuration(report.activeSeconds)}`,
    `- 单词答题：${report.wordAttemptCount}`,
    `- 不认识：${report.ratingCounts.unknown}`,
    `- 模糊：${report.ratingCounts.fuzzy}`,
    `- 认识：${report.ratingCounts.known}`,
    `- 当前到期词：${report.dueCount}`,
    "",
    "## 本地建议",
    "",
    ...report.recommendations.map((item) => `- ${item}`),
  ];
  if (report.weakWords.length) {
    lines.push("", "## 需要补强的词", "");
    for (const word of report.weakWords) {
      lines.push(
        `- ${word.word}：${(word.meaning || "").split("\n")[0]}（未稳 ${word.missCount} 次）`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildCheckpoint() {
  return buildCheckpointPayload({
    days: 7,
    accountName: ui.currentAccount?.name || "",
    attempts: data.attempts,
    sessions: data.sessions,
    wordStates: data.wordStates,
    words: content.words.items,
    readingPack: content.readings,
    wordPack: content.words,
    readingPackMeta: {
      license: content.readings.license,
      attribution: content.readings.attribution,
    },
    manifest: content.manifest,
  });
}

async function exportCheckpointJson(markFeedback = false) {
  if (!data.attempts.length) {
    showToast("还没有学习记录，暂时没有可反馈的数据。");
    return;
  }
  window.clearTimeout(memoSaveTimer);
  await saveReadingMemo(true);
  const payload = buildCheckpoint();
  downloadFile(
    `danshi-checkpoint-${localDayKey()}.json`,
    JSON.stringify(payload, null, 2),
    "application/json",
  );
  if (markFeedback) {
    const feedbackAt = new Date().toISOString();
    await putRecord(STORES.settings, {
      key: LAST_FEEDBACK_KEY,
      value: feedbackAt,
      updatedAt: feedbackAt,
    });
    const existing = data.settings.findIndex(
      (setting) => setting.key === LAST_FEEDBACK_KEY,
    );
    const setting = {
      key: LAST_FEEDBACK_KEY,
      value: feedbackAt,
      updatedAt: feedbackAt,
    };
    if (existing >= 0) {
      data.settings[existing] = setting;
    } else {
      data.settings.push(setting);
    }
    render();
  }
  showToast(
    markFeedback
      ? "反馈包已生成，并记录了本次反馈时间。"
      : "7 天检查包已导出。",
  );
}

async function exportCheckpointMarkdown() {
  const payload = buildCheckpoint();
  downloadFile(
    `danshi-checkpoint-${localDayKey()}.md`,
    checkpointToMarkdown(payload),
    "text/markdown",
  );
  showToast("Markdown 摘要已导出。");
}

async function exportBackup() {
  const backup = await exportDatabaseBackup();
  downloadFile(
    `danshi-backup-${localDayKey()}.json`,
    JSON.stringify(backup, null, 2),
    "application/json",
  );
  showToast("完整本地备份已导出。");
}

async function importBackup(file) {
  if (!file) {
    return;
  }
  const text = await file.text();
  let backup;
  try {
    backup = JSON.parse(text);
  } catch {
    showToast("备份文件不是有效 JSON。");
    return;
  }

  if (!window.confirm("恢复会合并备份中的记录。现有同名记录可能被覆盖，继续吗？")) {
    return;
  }

  try {
    await importDatabaseBackup(backup);
    await refreshData();
    render();
    showToast("备份已恢复。");
  } catch (error) {
    showToast(error.message || "恢复失败。");
  }
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((cell) => cell.trim())) {
        rows.push(row);
      }
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  row.push(field.replace(/\r$/, ""));
  if (row.some((cell) => cell.trim())) {
    rows.push(row);
  }
  return rows;
}

function createWordPackFromCsv(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) {
    throw new Error("CSV 至少需要表头和一行单词。");
  }

  const normalizedHeaders = rows[0].map((header) => header.trim().toLowerCase());
  const findHeader = (...names) =>
    normalizedHeaders.findIndex((header) => names.includes(header));
  const wordIndex = findHeader("word", "单词", "英文");
  const meaningIndex = findHeader("meaning", "translation", "中文释义", "释义");
  const phoneticIndex = findHeader("phonetic", "音标");
  const definitionIndex = findHeader("definition", "英文释义");
  if (wordIndex < 0 || meaningIndex < 0) {
    throw new Error("CSV 必须包含 word/单词 和 meaning/中文释义 列。");
  }

  const seen = new Set();
  const items = [];
  for (const row of rows.slice(1)) {
    const word = String(row[wordIndex] || "").trim();
    const meaning = String(row[meaningIndex] || "").trim();
    if (!word || !meaning || seen.has(word.toLowerCase())) {
      continue;
    }
    seen.add(word.toLowerCase());
    items.push({
      id: `local:${word.toLowerCase()}`,
      word,
      phonetic: phoneticIndex >= 0 ? String(row[phoneticIndex] || "").trim() : "",
      meaning,
      definition:
        definitionIndex >= 0 ? String(row[definitionIndex] || "").trim() : "",
      frequencyRank: items.length + 1,
      tags: ["imported"],
      exchange: "",
      source: {
        name: "用户导入",
        url: "",
        license: "用户未声明",
      },
    });
  }

  if (!items.length) {
    throw new Error("CSV 中没有有效单词。");
  }

  return {
    id: `custom-words-${stableHash(JSON.stringify(items))}`,
    title: "本地导入词包",
    version: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    custom: true,
    description: "由用户从本地 CSV 导入。",
    license: {
      name: "用户提供",
      url: "",
      note: "许可证由导入者负责确认。",
    },
    attribution: "User-imported vocabulary data.",
    items,
  };
}

function normalizeWordPack(pack) {
  if (!pack || !Array.isArray(pack.items)) {
    throw new Error("词包 JSON 必须包含 items 数组。");
  }
  const items = pack.items
    .map((item, index) => ({
      id: String(item.id || `local:${String(item.word || "").toLowerCase()}`),
      word: String(item.word || "").trim(),
      phonetic: String(item.phonetic || "").trim(),
      meaning: String(item.meaning || "").trim(),
      definition: String(item.definition || "").trim(),
      frequencyRank: Number(item.frequencyRank) || index + 1,
      tags: Array.isArray(item.tags) ? item.tags : ["imported"],
      skills:
        Array.isArray(item.skills) && item.skills.length
          ? item.skills.filter((skill) =>
              ["reading", "writing"].includes(skill),
            )
          : ["reading"],
      exchange: String(item.exchange || ""),
      source: item.source || {
        name: "用户导入",
        url: "",
        license: "用户未声明",
      },
    }))
    .filter((item) => item.id && item.word && item.meaning);
  if (!items.length) {
    throw new Error("词包中没有有效单词。");
  }
  return {
    ...pack,
    title: pack.title || "本地导入词包",
    version: pack.version || new Date().toISOString(),
    custom: true,
    items,
  };
}

function normalizeReadingPack(pack) {
  if (!pack || !Array.isArray(pack.items)) {
    throw new Error("阅读包 JSON 必须包含 items 数组。");
  }
  const items = pack.items
    .map((item) => ({
      ...item,
      id: String(item.id || `local-reading:${stableHash(item.text || "")}`),
      title: String(item.title || "未命名文章"),
      level: item.level || "imported",
      topic: item.topic || "imported",
      wordCount:
        Number(item.wordCount) ||
        String(item.text || "").trim().split(/\s+/).filter(Boolean).length,
      text: String(item.text || "").trim(),
      author: item.author || "用户导入",
      sourceUrl: item.sourceUrl || "",
      license: item.license || "用户未声明",
      questions: Array.isArray(item.questions) ? item.questions : [],
    }))
    .filter((item) => item.text);
  if (!items.length) {
    throw new Error("阅读包中没有有效文章。");
  }
  return {
    ...pack,
    title: pack.title || "本地导入阅读包",
    version: pack.version || new Date().toISOString(),
    custom: true,
    items,
  };
}

async function saveContentOverride(key, pack) {
  await putRecord(STORES.settings, {
    key,
    value: pack,
    updatedAt: new Date().toISOString(),
  });
  await refreshData();
  await loadContent();
  render();
}

async function importWordFile(file) {
  if (!file) {
    return;
  }
  const text = await file.text();
  let pack;
  if (file.name.toLowerCase().endsWith(".csv")) {
    pack = createWordPackFromCsv(text);
  } else {
    pack = normalizeWordPack(JSON.parse(text));
  }
  await saveContentOverride(CUSTOM_WORD_PACK_KEY, pack);
  showToast(`已导入 ${pack.items.length} 个单词；原学习记录仍保留。`);
}

function markdownToReading(text, filename) {
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  const heading = cleaned.match(/^#\s+(.+)$/m);
  const title = heading?.[1]?.trim() || filename.replace(/\.[^.]+$/, "");
  const body = heading
    ? cleaned.replace(heading[0], "").trim()
    : cleaned;
  return {
    id: `local-reading:${stableHash(`${title}\n${body}`)}`,
    title,
    level: "imported",
    topic: "imported",
    wordCount: body.split(/\s+/).filter(Boolean).length,
    text: body,
    author: "用户导入",
    sourceUrl: "",
    accessedAt: localDayKey(),
    license: "用户未声明",
    questions: [],
  };
}

async function importReadingFile(file) {
  if (!file) {
    return;
  }
  const text = await file.text();
  let nextPack;
  if (file.name.toLowerCase().endsWith(".json")) {
    const parsed = JSON.parse(text);
    nextPack = normalizeReadingPack(parsed);
  } else {
    const item = markdownToReading(text, file.name);
    const existingItems = content.readings.items.filter(
      (reading) => reading.id !== item.id,
    );
    nextPack = normalizeReadingPack({
      id: `custom-readings-${Date.now()}`,
      title: "本地阅读包",
      version: new Date().toISOString(),
      custom: true,
      description: "由用户从本地 Markdown 或纯文本导入。",
      license: { name: "用户提供", url: "" },
      attribution: "User-imported reading material.",
      items: [...existingItems, item],
    });
  }
  await saveContentOverride(CUSTOM_READING_PACK_KEY, nextPack);
  showToast(`已导入阅读包，共 ${nextPack.items.length} 篇文章。`);
}

async function resetContentOverride(key, label) {
  await deleteRecord(STORES.settings, key);
  await refreshData();
  await loadContent();
  render();
  showToast(`${label}已恢复为应用默认内容。`);
}

async function saveEnergyState(value) {
  ui.preferredState = value;
  await putRecord(STORES.settings, {
    key: ENERGY_KEY,
    value,
    updatedAt: new Date().toISOString(),
  });
  render();
}

function speakWord(word) {
  if (!("speechSynthesis" in window)) {
    showToast("当前浏览器不支持语音朗读。");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = "en-US";
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}

function passwordsFromForm(form) {
  const formData = new FormData(form);
  return {
    password: String(formData.get("adminPassword") || ""),
    confirmation: String(formData.get("adminPasswordConfirm") || ""),
  };
}

function assertPasswordConfirmation(password, confirmation) {
  if (password !== confirmation) {
    throw new Error("两次输入的管理员密码不一致。");
  }
}

async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  if (action === "select-account") {
    const account = selectAccount(target.dataset.accountId);
    setDatabaseAccount(account);
    window.location.reload();
    return;
  }
  if (action === "show-account-create") {
    ui.accountSetupMode = "create";
    ui.accountGateMessage = "";
    renderAccountGate();
    return;
  }
  if (action === "cancel-account-create") {
    ui.accountSetupMode = "select";
    renderAccountGate();
    return;
  }
  if (action === "switch-account") {
    saveTimerState();
    clearActiveAccount();
    ui.currentAccount = null;
    ui.adminUnlockedUntil = 0;
    window.location.reload();
    return;
  }
  if (action === "focus-admin") {
    const panel = document.querySelector("#admin-panel");
    const passwordInput = document.querySelector("#admin-unlock-password");
    panel?.scrollIntoView({ behavior: "smooth", block: "center" });
    passwordInput?.focus();
    return;
  }
  if (action === "lock-admin") {
    ui.adminUnlockedUntil = 0;
    render();
    showToast("管理员修改已锁定。");
    return;
  }
  if (action === "navigate") {
    ui.page = target.dataset.page;
    ui.readingFeedback = null;
    render();
    return;
  }
  if (action === "start-session") {
    await createSession();
    return;
  }
  if (action === "resume-session") {
    ui.page = "session";
    render();
    return;
  }
  if (action === "pause-timer") {
    pauseTimer();
    return;
  }
  if (action === "resume-timer") {
    resumeTimer();
    return;
  }
  if (action === "end-session") {
    await finishSession();
    return;
  }
  if (action === "rate-word") {
    beginWordRating(target.dataset.rating);
    return;
  }
  if (action === "change-pending-rating") {
    changePendingRating(target.dataset.rating);
    return;
  }
  if (action === "confirm-word-rating") {
    await confirmPendingWord();
    return;
  }
  if (action === "toggle-batch-meanings") {
    ui.batchMeaningsVisible = !ui.batchMeaningsVisible;
    render();
    return;
  }
  if (action === "complete-batch-review") {
    await completeBatchReview();
    return;
  }
  if (action === "reveal-retry-answer") {
    revealRetryAnswer();
    return;
  }
  if (action === "speak-word") {
    speakWord(target.dataset.word || "");
    return;
  }
  if (action === "skip-reading") {
    await skipReading();
    return;
  }
  if (action === "complete-open-reading") {
    await completeOpenReading();
    return;
  }
  if (action === "finish-reading-feedback") {
    window.clearTimeout(memoSaveTimer);
    await saveReadingMemo(true);
    ui.readingFeedback = null;
    ui.readingStartedAt = null;
    render();
    return;
  }
  if (action === "export-daily-markdown") {
    downloadFile(
      `danshi-daily-${ui.reportDay}.md`,
      dailyReportMarkdown(ui.reportDay),
      "text/markdown",
    );
    showToast("本日摘要已导出。");
    return;
  }
  if (action === "feedback-now") {
    await exportCheckpointJson(true);
    return;
  }
  if (action === "export-checkpoint-json") {
    await exportCheckpointJson(false);
    return;
  }
  if (action === "export-checkpoint-markdown") {
    await exportCheckpointMarkdown();
    return;
  }
  if (action === "export-backup") {
    await exportBackup();
    return;
  }
  if (action === "trigger-import-backup") {
    if (!requireAdmin()) {
      return;
    }
    document.querySelector("#backup-file")?.click();
    return;
  }
  if (action === "trigger-word-import") {
    if (!requireAdmin()) {
      return;
    }
    if (ui.activeSession) {
      showToast("请先结束当前学习会话，再更换词表。");
      return;
    }
    document.querySelector("#word-pack-file")?.click();
    return;
  }
  if (action === "trigger-reading-import") {
    if (!requireAdmin()) {
      return;
    }
    if (ui.activeSession) {
      showToast("请先结束当前学习会话，再更换阅读包。");
      return;
    }
    document.querySelector("#reading-pack-file")?.click();
    return;
  }
  if (action === "reset-word-pack") {
    if (!requireAdmin()) {
      return;
    }
    if (window.confirm("恢复默认词包不会删除旧单词的复习记录。继续吗？")) {
      await resetContentOverride(CUSTOM_WORD_PACK_KEY, "词包");
    }
    return;
  }
  if (action === "reset-reading-pack") {
    if (!requireAdmin()) {
      return;
    }
    if (window.confirm("恢复默认阅读包不会删除旧的阅读记录。继续吗？")) {
      await resetContentOverride(CUSTOM_READING_PACK_KEY, "阅读包");
    }
    return;
  }
  if (action === "refresh-content") {
    if (!requireAdmin()) {
      return;
    }
    if (ui.activeSession) {
      showToast("请先结束当前学习会话，再重新加载内容。");
      return;
    }
    try {
      await loadContent();
      render();
      showToast("内容包已重新读取；本地学习记录未改变。");
    } catch (error) {
      showToast(error.message || "内容读取失败。");
    }
  }
}

async function handleChange(event) {
  const target = event.target;
  if (target.matches('[data-action="change-energy"]')) {
    await saveEnergyState(target.value);
    return;
  }
  if (target.matches('[data-action="change-report-date"]')) {
    ui.reportDay = target.value || localDayKey();
    render();
    return;
  }
  if (target.id === "backup-file" && target.files?.[0]) {
    if (!requireAdmin()) {
      target.value = "";
      return;
    }
    await importBackup(target.files[0]);
    target.value = "";
    return;
  }
  if (target.id === "word-pack-file" && target.files?.[0]) {
    if (!requireAdmin()) {
      target.value = "";
      return;
    }
    await importWordFile(target.files[0]);
    target.value = "";
    return;
  }
  if (target.id === "reading-pack-file" && target.files?.[0]) {
    if (!requireAdmin()) {
      target.value = "";
      return;
    }
    await importReadingFile(target.files[0]);
    target.value = "";
  }
}

async function handleSubmit(event) {
  if (event.target.id === "first-account-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const { password, confirmation } = passwordsFromForm(event.target);
    assertPasswordConfirmation(password, confirmation);
    const account = await setupFirstAccount({
      name: formData.get("accountName"),
      adminPassword: password,
    });
    setDatabaseAccount(account);
    window.location.reload();
    return;
  }
  if (event.target.id === "create-account-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const account = createAccount(formData.get("accountName"));
    selectAccount(account.id);
    setDatabaseAccount(account);
    window.location.reload();
    return;
  }
  if (event.target.id === "set-admin-password-form") {
    event.preventDefault();
    const { password, confirmation } = passwordsFromForm(event.target);
    assertPasswordConfirmation(password, confirmation);
    await saveAdminPassword(password);
    ui.adminUnlockedUntil = Date.now() + ADMIN_UNLOCK_MS;
    render();
    showToast("管理员密码已设置，修改权限已解锁。");
    return;
  }
  if (event.target.id === "admin-unlock-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const verified = await verifyAdminPassword(formData.get("adminPassword"));
    if (!verified) {
      throw new Error("管理员密码不正确。");
    }
    ui.adminUnlockedUntil = Date.now() + ADMIN_UNLOCK_MS;
    render();
    showToast("管理员修改已解锁，30 分钟内有效。");
    return;
  }
  if (event.target.id === "change-admin-password-form") {
    event.preventDefault();
    const formData = new FormData(event.target);
    const currentPassword = String(formData.get("currentPassword") || "");
    const newPassword = String(formData.get("newPassword") || "");
    const confirmation = String(
      formData.get("newPasswordConfirm") || "",
    );
    assertPasswordConfirmation(newPassword, confirmation);
    await changeAdminPassword(currentPassword, newPassword);
    ui.adminUnlockedUntil = Date.now() + ADMIN_UNLOCK_MS;
    render();
    showToast("管理员密码已更新。");
    return;
  }
  if (event.target.id === "retry-choice-form") {
    event.preventDefault();
    submitRetryChoice(event.target);
    return;
  }
  if (event.target.id === "retry-form") {
    event.preventDefault();
    submitRetryRecall(event.target);
    return;
  }
  if (event.target.id !== "reading-form") {
    return;
  }
  event.preventDefault();
  await submitReading(event.target);
}

function handleInput(event) {
  if (event.target.id !== "reading-memo") {
    return;
  }
  const status = document.querySelector("#reading-memo-status");
  if (status) {
    status.textContent = "正在保存…";
  }
  if (ui.readingFeedback) {
    ui.readingFeedback.memoDraft = event.target.value;
  }
  window.clearTimeout(memoSaveTimer);
  memoSaveTimer = window.setTimeout(() => {
    saveReadingMemo(true).catch((error) => {
      console.error(error);
      if (status) {
        status.textContent = "保存失败";
      }
    });
  }, 600);
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      // The application still works online or through the local server without caching.
    }
  }
}

function bindAppEvents() {
  app.addEventListener("click", (event) => {
    handleClick(event).catch((error) => {
      console.error(error);
      showToast(error.message || "操作失败。");
    });
  });
  app.addEventListener("change", (event) => {
    handleChange(event).catch((error) => {
      console.error(error);
      showToast(error.message || "操作失败。");
    });
  });
  app.addEventListener("submit", (event) => {
    handleSubmit(event).catch((error) => {
      console.error(error);
      showToast(error.message || "提交失败。");
    });
  });
  app.addEventListener("input", handleInput);

  timerInterval = window.setInterval(() => {
    updateTimerDisplay();
    syncTimerHeartbeat();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveTimerState();
    }
  });
  window.addEventListener("beforeunload", saveTimerState);
}

async function loadLearningApp() {
  setDatabaseAccount(ui.currentAccount);
  await openDatabase();
  await refreshData();
  await loadContent();
  const active = latestActiveSession();
  if (active) {
    ui.activeSession = active;
    restoreTimerState(active.id);
    ui.page = "session";
  }
  render();
  if (ui.activeSession && ui.timer?.recovered) {
    showToast("已恢复上次未结束的会话，计时处于暂停状态。");
  }
}

async function boot() {
  bindAppEvents();
  try {
    const account = getActiveAccount();
    if (!account) {
      renderAccountGate();
      await registerServiceWorker();
      return;
    }
    ui.currentAccount = account;
    renderLoading();
    await loadLearningApp();
    await registerServiceWorker();
  } catch (error) {
    console.error(error);
    app.innerHTML = `
      <div class="loading">
        <div>
          <div class="loading-mark">!</div>
          <div>${escapeHtml(error.message || "应用加载失败。")}</div>
          <div style="margin-top:12px" class="muted">请确认通过本地服务器打开，而不是直接双击 HTML。</div>
        </div>
      </div>
    `;
  }
}

boot();

