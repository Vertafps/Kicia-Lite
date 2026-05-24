"use strict";

// per-guild rate-limited log channel write queue
// drain rate: 4 messages / 5s per guild (1 per 1250ms)
// overflow: drop oldest entries (FIFO drop) when depth > maxDepth
// critical priority: bypasses queue, sends inline

// ---------------------------------------------------------------------------
// Settings keys (register these in the settings registry via Batch A agent):
//   log.queue.enabled  bool  default true  — if false every call sends inline
//   log.queue.rate     int   default 4     — messages per 5-second window
//   log.queue.maxDepth int   default 200   — max pending entries per guild
// ---------------------------------------------------------------------------

// Tags in panel.header that callers can pass with {priority:"critical"} to
// skip the queue. Left empty for now — callers explicitly opt in.
const CRITICAL_PRIORITY_TAGS = Object.freeze([
  // e.g. "Outage Detected", "Link Timeout · severe", "Memory Pressure"
]);

// guildId → QueueState
// QueueState: { entries, timer, stats, guildRef, lastWarnAt }
//   entries: [{panel, options, resolve}]
//   timer:   NodeJS.Timeout | null
//   stats:   {pending, dropped, sent}
//   lastWarnAt: number | null — for overflow warn rate-limiting (once/min)
const QUEUE = new Map();

// ---------------------------------------------------------------------------
// Lazy helpers (avoid circular deps + avoid loading before bot is ready)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Config readers (call on each operation so owner changes take effect live)
// ---------------------------------------------------------------------------

function isQueueEnabled() {
  const v = getGetSetting()("log.queue.enabled");
  return v == null ? true : Boolean(v);
}

function getRate() {
  // messages per 5-second window
  const v = getGetSetting()("log.queue.rate");
  const n = v == null ? 4 : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function getMaxDepth() {
  const v = getGetSetting()("log.queue.maxDepth");
  const n = v == null ? 200 : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 200;
}

// drain interval = 5000ms / rate  (floored to 50ms floor as sanity guard)
function getDrainIntervalMs() {
  return Math.max(50, Math.floor(5000 / getRate()));
}

// ---------------------------------------------------------------------------
// Direct (inline) send — used for critical priority and queue-disabled path
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Queue state initializer
// ---------------------------------------------------------------------------

function initState(guild) {
  return {
    entries: [],
    timer: null,
    stats: { pending: 0, dropped: 0, sent: 0 },
    guildRef: guild,
    lastWarnAt: null,
  };
}

// ---------------------------------------------------------------------------
// Drain timer management
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Overflow handling — drop oldest, warn at most once per minute per guild
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Primary export: enqueueLogPanel
// ---------------------------------------------------------------------------

/**
 * Enqueue a log panel for delivery to the guild's log channel.
 *
 * @param {object} guild    - Discord.js Guild object
 * @param {object} panel    - panel descriptor (same shape as sendLogPanel accepts)
 * @param {object} [options]
 * @param {"normal"|"critical"} [options.priority="normal"]
 * @param {boolean} [options.ignoreLogChannel=false]
 * @returns {Promise<{queued: boolean, dropped?: boolean, sent?: boolean, reason?: string}>}
 */
async function enqueueLogPanel(guild, panel, options) {
  options = options || {};

  const guildId = guild?.id;
  if (!guildId) return { queued: false, reason: "no-guild" };

  // --- fast path: queue disabled
  if (!isQueueEnabled()) {
    const ok = await sendLogPanelDirect(guild, panel, options);
    return { queued: false, sent: ok };
  }

  // --- critical priority: bypass queue, send inline immediately
  if (options.priority === "critical") {
    const ok = await sendLogPanelDirect(guild, panel, options);
    return { queued: false, dropped: !ok, sent: ok };
  }

  // --- normal path: enqueue
  let state = QUEUE.get(guildId);
  if (!state) {
    state = initState(guild);
    QUEUE.set(guildId, state);
  } else {
    // keep guildRef fresh (guild object may be re-fetched)
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

// ---------------------------------------------------------------------------
// Graceful shutdown: flush all queues (2-second budget, up to 10 per guild)
// ---------------------------------------------------------------------------

/**
 * Best-effort flush of all pending queued entries before process exit.
 * Sends up to 10 entries per guild immediately (parallel Promise.allSettled),
 * then resolves. Anything beyond 10 per guild is abandoned.
 * @returns {Promise<void>}
 */
async function flushAllQueues() {
  const BUDGET_PER_GUILD = 10;
  const flushPromises = [];

  for (const [, state] of QUEUE) {
    stopDrainTimer(state);

    const toFlush = state.entries.splice(0, BUDGET_PER_GUILD);
    state.stats.pending = Math.max(0, state.stats.pending - toFlush.length);

    // abandon anything beyond budget
    for (const entry of state.entries) {
      entry.resolve({ queued: true, sent: false, reason: "shutdown-overflow" });
    }
    state.entries.length = 0;

    // flush the capped batch immediately (Discord will rate-limit us, that's fine)
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

// ---------------------------------------------------------------------------
// Stats snapshot
// ---------------------------------------------------------------------------

/**
 * Returns a snapshot of queue stats for all guilds.
 * @returns {{ [guildId: string]: {pending: number, dropped: number, sent: number} }}
 */
function getQueueStats() {
  const result = {};
  for (const [guildId, state] of QUEUE) {
    result[guildId] = { ...state.stats };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function __resetForTests() {
  for (const [, state] of QUEUE) {
    stopDrainTimer(state);
  }
  QUEUE.clear();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CRITICAL_PRIORITY_TAGS,
  enqueueLogPanel,
  flushAllQueues,
  getQueueStats,
  __resetForTests,
};
