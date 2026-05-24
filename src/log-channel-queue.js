// per-guild rate-limited log channel write queue
// drain rate: 4 messages / 5s per guild (1 per 1250ms)

const CRITICAL_PRIORITY_TAGS = Object.freeze([]);

// guildId -> { entries, timer, stats, guildRef, lastWarnAt }
const QUEUE = new Map();

function getLogChannel() {
  return require("./log-channel");
}

function getGetSetting() {
  try {
    return require("./settings").getSetting;
  } catch (_) {
    return () => undefined;
  }
}

function getRecordRuntimeEvent() {
  try {
    return require("./runtime-health").recordRuntimeEvent;
  } catch (_) {
    return () => {};
  }
}

function isQueueEnabled() {
  const v = getGetSetting()("log.queue.enabled");
  return v == null ? true : Boolean(v);
}

function getRate() {
  const v = getGetSetting()("log.queue.rate");
  const n = v == null ? 4 : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function getMaxDepth() {
  const v = getGetSetting()("log.queue.maxDepth");
  const n = v == null ? 200 : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

// drain interval = 5000ms / rate
function getDrainIntervalMs() {
  return Math.max(50, Math.floor(5000 / getRate()));
}

async function sendLogPanelDirect(guild, panel, options) {
  const logChannel = getLogChannel();
  try {
    let ok;
    if (options && options.ignoreLogChannel) {
      ok = await logChannel.sendIgnoreLogPanel(guild, panel);
    } else {
      ok = await logChannel.sendLogPanel(guild, panel);
    }
    return Boolean(ok);
  } catch (err) {
    getRecordRuntimeEvent()("warn", "log-channel-queue-inline", err?.message || String(err));
    return false;
  }
}

function initState(guild) {
  return {
    entries: [],
    timer: null,
    stats: { pending: 0, dropped: 0, sent: 0 },
    guildRef: guild,
    lastWarnAt: null,
  };
}

function startDrainIfIdle(state) {
  if (state.timer) return;

  state.timer = setInterval(() => {
    const entry = state.entries.shift();
    if (!entry) {
      clearInterval(state.timer);
      state.timer = null;
      return;
    }
    state.stats.pending = Math.max(0, state.stats.pending - 1);

    sendLogPanelDirect(state.guildRef, entry.panel, entry.options)
      .then((ok) => {
        if (ok) state.stats.sent++;
        entry.resolve({ queued: true, sent: ok });
      })
      .catch((err) => {
        getRecordRuntimeEvent()("warn", "log-queue-drain", err?.message || String(err));
        entry.resolve({ queued: true, sent: false });
      });
  }, getDrainIntervalMs());

  // don't block Node process exit
  if (typeof state.timer.unref === "function") state.timer.unref();
}

function stopDrainTimer(state) {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function enforceMaxDepth(state, maxDepth) {
  while (state.entries.length >= maxDepth) {
    state.entries.shift();
    state.stats.dropped++;
    state.stats.pending = Math.max(0, state.stats.pending - 1);
  }

  const now = Date.now();
  if (state.lastWarnAt == null || now - state.lastWarnAt > 60_000) {
    state.lastWarnAt = now;
    getRecordRuntimeEvent()(
      "warn",
      "log-channel-queue",
      `queue overflow for guild ${state.guildRef?.id ?? "unknown"} — dropping oldest entries`
    );
  }
}

async function enqueueLogPanel(guild, panel, options) {
  options = options || {};

  const guildId = guild?.id;
  if (!guildId) return { queued: false, reason: "no-guild" };

  if (!isQueueEnabled()) {
    const ok = await sendLogPanelDirect(guild, panel, options);
    return { queued: false, sent: ok };
  }

  if (options.priority === "critical") {
    const ok = await sendLogPanelDirect(guild, panel, options);
    return { queued: false, dropped: !ok, sent: ok };
  }

  let state = QUEUE.get(guildId);
  if (!state) {
    state = initState(guild);
    QUEUE.set(guildId, state);
  } else {
    state.guildRef = guild;
  }

  const maxDepth = getMaxDepth();
  enforceMaxDepth(state, maxDepth);

  return new Promise((resolve) => {
    state.entries.push({ panel, options, resolve });
    state.stats.pending++;
    startDrainIfIdle(state);
  });
}

async function flushAllQueues() {
  const BUDGET_PER_GUILD = 10;
  const flushPromises = [];

  for (const [, state] of QUEUE) {
    stopDrainTimer(state);

    const toFlush = state.entries.splice(0, BUDGET_PER_GUILD);
    state.stats.pending = Math.max(0, state.stats.pending - toFlush.length);

    for (const entry of state.entries) {
      entry.resolve({ queued: true, sent: false, reason: "shutdown-overflow" });
    }
    state.entries.length = 0;

    const batchPromise = Promise.allSettled(
      toFlush.map((entry) =>
        sendLogPanelDirect(state.guildRef, entry.panel, entry.options)
          .then((ok) => {
            if (ok) state.stats.sent++;
            entry.resolve({ queued: true, sent: ok, reason: "shutdown-flush" });
          })
          .catch((err) => {
            getRecordRuntimeEvent()("warn", "log-queue-flush", err?.message || String(err));
            entry.resolve({ queued: true, sent: false, reason: "shutdown-flush-error" });
          })
      )
    );

    flushPromises.push(batchPromise);
  }

  // 2-second total budget
  await Promise.race([
    Promise.allSettled(flushPromises),
    new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}

function getQueueStats() {
  const result = {};
  for (const [guildId, state] of QUEUE) {
    result[guildId] = { ...state.stats };
  }
  return result;
}

function __resetForTests() {
  for (const [, state] of QUEUE) {
    stopDrainTimer(state);
  }
  QUEUE.clear();
}

module.exports = {
  CRITICAL_PRIORITY_TAGS,
  enqueueLogPanel,
  flushAllQueues,
  getQueueStats,
  __resetForTests,
};
