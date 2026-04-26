const MINUTE_MS = 60 * 1000;
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const UNIT_TO_MS = new Map([
  ["s", 1000],
  ["sec", 1000],
  ["secs", 1000],
  ["second", 1000],
  ["seconds", 1000],
  ["m", MINUTE_MS],
  ["min", MINUTE_MS],
  ["mins", MINUTE_MS],
  ["minute", MINUTE_MS],
  ["minutes", MINUTE_MS],
  ["h", 60 * MINUTE_MS],
  ["hr", 60 * MINUTE_MS],
  ["hrs", 60 * MINUTE_MS],
  ["hour", 60 * MINUTE_MS],
  ["hours", 60 * MINUTE_MS],
  ["d", 24 * 60 * MINUTE_MS],
  ["day", 24 * 60 * MINUTE_MS],
  ["days", 24 * 60 * MINUTE_MS]
]);

function clampDurationMs(durationMs, {
  min = MINUTE_MS,
  max = MAX_TIMEOUT_MS
} = {}) {
  const numeric = Number(durationMs);
  if (!Number.isFinite(numeric) || numeric <= 0) return min;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function parseDurationInput(input, { defaultUnit = "m" } = {}) {
  const normalized = String(input || "").trim().toLowerCase();
  if (!normalized) return null;

  const match = normalized.match(
    /^(\d+)(?:\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))?$/
  );
  if (!match) return null;

  const value = Number(match[1]);
  const unit = match[2] || defaultUnit;
  const multiplier = UNIT_TO_MS.get(unit);
  if (!Number.isFinite(value) || value <= 0 || !multiplier) return null;

  return clampDurationMs(value * multiplier);
}

function formatDuration(durationMs) {
  const roundedSeconds = Math.max(1, Math.round(Number(durationMs || 0) / 1000));
  const days = Math.floor(roundedSeconds / 86_400);
  const hours = Math.floor((roundedSeconds % 86_400) / 3_600);
  const minutes = Math.floor((roundedSeconds % 3_600) / 60);
  const seconds = roundedSeconds % 60;

  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!parts.length || (!days && !hours && seconds)) parts.push(`${seconds}s`);

  return parts.slice(0, 2).join(" ");
}

module.exports = {
  MINUTE_MS,
  MAX_TIMEOUT_MS,
  clampDurationMs,
  parseDurationInput,
  formatDuration
};
