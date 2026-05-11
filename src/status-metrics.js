const {
  getMostRecentStatusTransition,
  getPersistedRuntimeStatus,
  listStatusTransitionsSince
} = require("./restricted-emoji-db");

const DAY_MS = 24 * 60 * 60 * 1000;
const RIBBON_SLOTS = 96;

function clampStatus(status) {
  const v = String(status || "").toUpperCase();
  if (v === "UP" || v === "DOWN" || v === "UNAWARE") return v;
  return "UP";
}

function ribbonStateForStatus(status) {
  const v = clampStatus(status);
  if (v === "DOWN") return "down";
  if (v === "UNAWARE") return "unaware";
  return "up";
}

function pickDominantState(slices) {
  let bestState = null;
  let bestDuration = -1;
  for (const [state, duration] of Object.entries(slices)) {
    if (duration > bestDuration) {
      bestDuration = duration;
      bestState = state;
    }
  }
  return bestState || "UP";
}

function buildTimeline({ windowStart, windowEnd, transitions, currentStatus }) {
  const sorted = transitions
    .slice()
    .sort((a, b) => a.occurredAt - b.occurredAt || a.id - b.id);

  // State at windowStart: latest transition <= windowStart, else the first
  // transition's fromStatus (captures pre-history state), else current status.
  let stateAtStart = null;
  for (const t of sorted) {
    if (t.occurredAt <= windowStart) {
      stateAtStart = t.toStatus;
    } else break;
  }
  if (!stateAtStart) {
    const firstInWindow = sorted.find((t) => t.occurredAt > windowStart);
    stateAtStart = firstInWindow?.fromStatus || currentStatus || "UP";
  }
  stateAtStart = clampStatus(stateAtStart);

  // Build segments [{from, to, state}] within the window.
  const segments = [];
  let cursor = windowStart;
  let state = stateAtStart;
  for (const t of sorted) {
    if (t.occurredAt <= windowStart) continue;
    if (t.occurredAt > windowEnd) break;
    if (t.occurredAt > cursor) {
      segments.push({ from: cursor, to: t.occurredAt, state });
    }
    state = clampStatus(t.toStatus);
    cursor = t.occurredAt;
  }
  if (cursor < windowEnd) {
    segments.push({ from: cursor, to: windowEnd, state });
  }
  return { segments, stateAtStart };
}

function computeTimeInState(segments) {
  const totals = { UP: 0, DOWN: 0, UNAWARE: 0 };
  for (const seg of segments) {
    const ms = Math.max(0, seg.to - seg.from);
    totals[seg.state] = (totals[seg.state] || 0) + ms;
  }
  return totals;
}

function computeIncidents(transitions, { windowStart, windowEnd }) {
  return transitions.filter((t) => {
    if (t.occurredAt < windowStart || t.occurredAt > windowEnd) return false;
    return t.toStatus === "DOWN" || t.toStatus === "UNAWARE";
  }).length;
}

function buildRibbonFromSegments(segments, { windowStart, windowEnd, slots = RIBBON_SLOTS }) {
  const span = Math.max(1, windowEnd - windowStart);
  const slotSize = span / slots;
  const ribbon = new Array(slots).fill("up");

  for (let i = 0; i < slots; i++) {
    const slotStart = windowStart + i * slotSize;
    const slotEnd = slotStart + slotSize;
    const slices = { UP: 0, DOWN: 0, UNAWARE: 0 };
    for (const seg of segments) {
      const overlapFrom = Math.max(seg.from, slotStart);
      const overlapTo = Math.min(seg.to, slotEnd);
      if (overlapTo <= overlapFrom) continue;
      slices[seg.state] += overlapTo - overlapFrom;
    }
    ribbon[i] = ribbonStateForStatus(pickDominantState(slices));
  }
  return ribbon;
}

function formatRelative(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

async function buildStatusMetrics({
  windowMs = DAY_MS,
  now = Date.now(),
  currentStatus = null
} = {}) {
  const windowEnd = Math.max(1, Math.round(now));
  const windowStart = Math.max(0, windowEnd - windowMs);

  let persistedStatus = currentStatus;
  if (!persistedStatus) {
    try {
      const snapshot = await getPersistedRuntimeStatus();
      persistedStatus = snapshot?.status || "UP";
    } catch {
      persistedStatus = "UP";
    }
  }
  persistedStatus = clampStatus(persistedStatus);

  let transitions = [];
  let lastDownTransition = null;
  try {
    transitions = await listStatusTransitionsSince({
      sinceAt: windowStart - DAY_MS,
      limit: 1000
    });
  } catch {
    transitions = [];
  }
  try {
    lastDownTransition = await getMostRecentStatusTransition({ toStatus: "DOWN" });
  } catch {
    lastDownTransition = null;
  }

  const { segments } = buildTimeline({
    windowStart,
    windowEnd,
    transitions,
    currentStatus: persistedStatus
  });

  const timeInState = computeTimeInState(segments);
  const totalMs = Math.max(1, windowEnd - windowStart);
  const uptimePct = Math.max(0, Math.min(100, (timeInState.UP / totalMs) * 100));
  const incidents = computeIncidents(transitions, { windowStart, windowEnd });
  const ribbon = buildRibbonFromSegments(segments, { windowStart, windowEnd });

  const lastDownAt = lastDownTransition?.occurredAt || null;
  const lastDownLabel = lastDownAt
    ? formatRelative(windowEnd - lastDownAt)
    : null;

  return {
    status: persistedStatus,
    windowStart,
    windowEnd,
    uptimePct,
    timeInState,
    incidents,
    ribbon,
    lastDownAt,
    lastDownLabel: lastDownLabel || "—"
  };
}

module.exports = {
  DAY_MS,
  RIBBON_SLOTS,
  buildStatusMetrics,
  buildTimeline,
  buildRibbonFromSegments,
  computeIncidents,
  computeTimeInState,
  formatRelative
};
