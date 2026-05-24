"use strict";

/**
 * Owner-tunable settings registry + read-through cache.
 *
 * Registers every runtime-adjustable setting (toggles, durations, thresholds)
 * with a typed descriptor and provides:
 *   - getSetting(key)              sync, hot-path safe, falls back to default
 *   - setSetting(key, raw, {db})   async, persists to app_config, audits
 *   - resetSetting(key, {db})      async, deletes the row, audits
 *   - hydrateSettingsCache(db)     async, single batched SELECT at boot
 *
 * Persistence shape: rows live in the existing `app_config` SQLite table
 * (key TEXT PRIMARY KEY, value TEXT NOT NULL). Empty databases inherit
 * defaults cleanly — rows only exist when an owner runs `$config set`.
 *
 * Cache shape: in-process Map<key, {value, loadedAt}> with a 60s TTL. The
 * hot path NEVER awaits — cache hit returns immediately, miss/expiry
 * returns the descriptor default.
 */

const {
  parseDurationInput,
  formatDuration,
  clampDurationMs,
  MAX_TIMEOUT_MS
} = require("./duration");
const { buildPanel, WARN, INFO } = require("./embed");
const { recordRuntimeEvent } = require("./runtime-health");

// inline two-row levenshtein. prohibited-commerce.js exposes a private
// implementation; keep settings.js self-contained so circular imports stay
// impossible regardless of future exports.
function levenshteinDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
    }
  }
  return previous[right.length];
}

const CACHE_TTL_MS = 60_000;
const STRING_MAX_LEN = 256;

const SETTING_TYPES = Object.freeze({
  BOOL: "bool",
  DURATION: "duration",
  FLOAT: "float",
  INT: "int",
  ENUM: "enum",
  STRING: "string"
});

// lazy require of restricted-emoji-db to avoid circular import at module load.
// the file is large and re-entrant — defer it until actually needed.
let _emojiDb = null;
function emojiDb() {
  if (!_emojiDb) {
    try {
      _emojiDb = require("./restricted-emoji-db");
    } catch {
      _emojiDb = {};
    }
  }
  return _emojiDb;
}

function flushNow(db) {
  const helpers = emojiDb();
  if (typeof helpers.flushRestrictedEmojiDatabaseNow === "function") {
    try {
      helpers.flushRestrictedEmojiDatabaseNow(db);
    } catch (err) {
      recordRuntimeEvent("warn", "settings.flush", err?.message || err);
    }
  }
}

// raw db ops — keep settings.js self-contained so an evolving
// restricted-emoji-db.js export surface doesn't break the hot path.
function dbGetAppConfig(db, key) {
  const stmt = db.prepare("SELECT value FROM app_config WHERE key = ?");
  try {
    stmt.bind([key]);
    if (!stmt.step()) return null;
    return stmt.get()[0];
  } finally {
    stmt.free();
  }
}

function dbSetAppConfig(db, key, value) {
  db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)", [
    String(key),
    String(value)
  ]);
}

function dbDeleteAppConfig(db, key) {
  db.run("DELETE FROM app_config WHERE key = ?", [String(key)]);
}

function dbGetRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

// formatters per type — used by $config get / list to render current value.
function formatBoolDisplay(value) {
  return value ? "enabled" : "disabled";
}

function formatDurationDisplay(value) {
  return formatDuration(Number(value) || 0);
}

function formatFloatDisplay(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0.00";
  return num.toFixed(2);
}

function formatIntDisplay(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  return String(Math.trunc(num));
}

function formatEnumDisplay(value) {
  return String(value ?? "");
}

function formatStringDisplay(value) {
  return `\`${String(value ?? "")}\``;
}

// coercers per type — raw user input → typed value or {ok:false, error}.
function coerceBool(raw) {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  const str = String(raw ?? "").trim().toLowerCase();
  if (["on", "true", "1", "yes", "enabled", "enable", "y"].includes(str)) {
    return { ok: true, value: true };
  }
  if (["off", "false", "0", "no", "disabled", "disable", "n"].includes(str)) {
    return { ok: true, value: false };
  }
  return { ok: false, error: "expected on/off/true/false/yes/no" };
}

function coerceDuration(raw, descriptor) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const min = descriptor.min ?? 60_000;
    const max = descriptor.max ?? MAX_TIMEOUT_MS;
    return { ok: true, value: clampDurationMs(raw, { min, max }) };
  }
  const parsed = parseDurationInput(raw);
  if (parsed == null) {
    return { ok: false, error: "expected duration like 30s / 5m / 1h / 24h / 7d" };
  }
  const min = descriptor.min ?? 60_000;
  const max = descriptor.max ?? MAX_TIMEOUT_MS;
  return { ok: true, value: clampDurationMs(parsed, { min, max }) };
}

function coerceFloat(raw, descriptor) {
  const num = parseFloat(String(raw).trim());
  if (!Number.isFinite(num)) return { ok: false, error: "expected a number" };
  let clamped = num;
  if (descriptor.min != null && clamped < descriptor.min) clamped = descriptor.min;
  if (descriptor.max != null && clamped > descriptor.max) clamped = descriptor.max;
  return { ok: true, value: clamped };
}

function coerceInt(raw, descriptor) {
  const num = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(num)) return { ok: false, error: "expected an integer" };
  let clamped = num;
  if (descriptor.min != null && clamped < descriptor.min) clamped = descriptor.min;
  if (descriptor.max != null && clamped > descriptor.max) clamped = descriptor.max;
  return { ok: true, value: clamped };
}

function coerceEnum(raw, descriptor) {
  const choices = Array.isArray(descriptor.choices) ? descriptor.choices : [];
  const lower = String(raw ?? "").trim().toLowerCase();
  const match = choices.find((c) => String(c).toLowerCase() === lower);
  if (!match) {
    return { ok: false, error: `expected one of: ${choices.join(", ")}` };
  }
  return { ok: true, value: match };
}

function coerceString(raw) {
  const str = String(raw ?? "").trim();
  if (!str) return { ok: false, error: "value must be non-empty" };
  return { ok: true, value: str.slice(0, STRING_MAX_LEN) };
}

// deserializer per type — converts the stringified app_config row to a
// typed value at hydrate time.
function deserializeValue(descriptor, raw) {
  if (raw == null) return descriptor.defaultValue;
  switch (descriptor.type) {
    case SETTING_TYPES.BOOL: {
      const result = coerceBool(raw);
      return result.ok ? result.value : descriptor.defaultValue;
    }
    case SETTING_TYPES.DURATION: {
      const num = Number(raw);
      if (Number.isFinite(num) && num > 0) {
        const min = descriptor.min ?? 60_000;
        const max = descriptor.max ?? MAX_TIMEOUT_MS;
        return clampDurationMs(num, { min, max });
      }
      const result = coerceDuration(raw, descriptor);
      return result.ok ? result.value : descriptor.defaultValue;
    }
    case SETTING_TYPES.FLOAT: {
      const result = coerceFloat(raw, descriptor);
      return result.ok ? result.value : descriptor.defaultValue;
    }
    case SETTING_TYPES.INT: {
      const result = coerceInt(raw, descriptor);
      return result.ok ? result.value : descriptor.defaultValue;
    }
    case SETTING_TYPES.ENUM: {
      const result = coerceEnum(raw, descriptor);
      return result.ok ? result.value : descriptor.defaultValue;
    }
    case SETTING_TYPES.STRING:
    default: {
      const str = String(raw);
      return str.length > STRING_MAX_LEN ? str.slice(0, STRING_MAX_LEN) : str;
    }
  }
}

// canonical string form for app_config storage. read back by deserializeValue.
function serializeValue(descriptor, value) {
  switch (descriptor.type) {
    case SETTING_TYPES.BOOL:
      return value ? "1" : "0";
    case SETTING_TYPES.DURATION:
    case SETTING_TYPES.INT:
      return String(Math.trunc(Number(value) || 0));
    case SETTING_TYPES.FLOAT:
      return String(Number(value) || 0);
    case SETTING_TYPES.ENUM:
    case SETTING_TYPES.STRING:
    default:
      return String(value ?? "");
  }
}

function formatValueForDisplay(descriptor, value) {
  switch (descriptor.type) {
    case SETTING_TYPES.BOOL:
      return formatBoolDisplay(Boolean(value));
    case SETTING_TYPES.DURATION:
      return formatDurationDisplay(value);
    case SETTING_TYPES.FLOAT:
      return formatFloatDisplay(value);
    case SETTING_TYPES.INT:
      return formatIntDisplay(value);
    case SETTING_TYPES.ENUM:
      return formatEnumDisplay(value);
    case SETTING_TYPES.STRING:
    default:
      return formatStringDisplay(value);
  }
}

// duration helpers for the registry below.
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// the registry. every entry is one tunable setting; sections group them
// for $config list pagination. keep order stable: section, then alphabetical.
const REGISTRY_ENTRIES = [
  // ---------- link ----------
  ["link.guard.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Link Guard",
    description: "Master toggle for the link policy / threat-intel pipeline.",
    section: "link"
  }],
  ["link.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 60 * SECOND_MS,
    label: "Link Timeout",
    description: "Mute duration applied when a link triggers action.",
    section: "link",
    min: 10 * SECOND_MS,
    max: 7 * DAY_MS
  }],
  ["link.new-account.days", {
    type: SETTING_TYPES.INT,
    defaultValue: 30,
    label: "New-Account Days",
    description: "Accounts younger than this many days face stricter link checks.",
    section: "link",
    min: 0,
    max: 365
  }],
  ["link.new-member.days", {
    type: SETTING_TYPES.INT,
    defaultValue: 7,
    label: "New-Member Days",
    description: "Members joined more recently than this face stricter link checks.",
    section: "link",
    min: 0,
    max: 365
  }],
  ["link.fishfish-only", {
    type: SETTING_TYPES.BOOL,
    defaultValue: false,
    label: "FishFish-Only Mode",
    description: "When enabled, only FishFish is consulted (other intel providers skipped).",
    section: "link"
  }],
  ["link.expansion.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Link Expansion",
    description: "Follow shortener redirects before threat checks.",
    section: "link"
  }],
  ["link.threshold.action", {
    type: SETTING_TYPES.INT,
    defaultValue: 85,
    label: "Action Threshold",
    description: "Combined link threat score (0-100) that triggers a timeout.",
    section: "link",
    min: 0,
    max: 100
  }],
  ["link.threshold.warn", {
    type: SETTING_TYPES.INT,
    defaultValue: 55,
    label: "Warn Threshold",
    description: "Link threat score that pings staff but takes no auto-action.",
    section: "link",
    min: 0,
    max: 100
  }],
  ["link.threshold.review", {
    type: SETTING_TYPES.INT,
    defaultValue: 35,
    label: "Review Threshold",
    description: "Link threat score that logs for manual review.",
    section: "link",
    min: 0,
    max: 100
  }],

  // ---------- scam ----------
  ["scam.guard.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Scam Guard",
    description: "Master toggle for the Kicia-product scam/trade classifier.",
    section: "scam"
  }],
  ["scam.severity.light.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: HOUR_MS,
    label: "Scam Light Timeout",
    description: "Timeout duration for the lightest scam severity tier.",
    section: "scam",
    min: 5 * MINUTE_MS,
    max: 7 * DAY_MS
  }],
  ["scam.severity.medium.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 12 * HOUR_MS,
    label: "Scam Medium Timeout",
    description: "Timeout duration for the medium scam severity tier.",
    section: "scam",
    min: 5 * MINUTE_MS,
    max: 14 * DAY_MS
  }],
  ["scam.severity.severe.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 24 * HOUR_MS,
    label: "Scam Severe Timeout",
    description: "Timeout duration for the severe scam severity tier.",
    section: "scam",
    min: 30 * MINUTE_MS,
    max: 28 * DAY_MS
  }],
  ["scam.firstoffense.confidence", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.92,
    label: "First-Offense Confidence",
    description: "Combined confidence required to auto-timeout on first offense.",
    section: "scam",
    min: 0,
    max: 1
  }],
  ["scam.threshold.action", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.85,
    label: "Action Threshold",
    description: "Confidence above which scam classifier auto-acts.",
    section: "scam",
    min: 0,
    max: 1
  }],
  ["scam.threshold.review", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.60,
    label: "Review Threshold",
    description: "Confidence above which scam classifier flags for review.",
    section: "scam",
    min: 0,
    max: 1
  }],
  ["scam.semantic.delta", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.18,
    label: "Semantic Delta",
    description: "Sell-bank minus buy-bank cosine gap that counts as a sell-lean signal.",
    section: "scam",
    min: 0,
    max: 1
  }],
  ["scam.head.threshold", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.78,
    label: "Head Threshold",
    description: "Trained-head sigmoid score above which the head signal counts.",
    section: "scam",
    min: 0,
    max: 1
  }],
  ["scam.newaccount.bump", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.05,
    label: "New-Account Bump",
    description: "Confidence bump added when the author account is fresh.",
    section: "scam",
    min: 0,
    max: 0.5
  }],
  ["scam.staff.ping.role", {
    type: SETTING_TYPES.STRING,
    defaultValue: "",
    label: "Scam Staff Ping Role",
    description: "Role ID to ping when scam classifier asks for review (empty = no ping).",
    section: "scam"
  }],

  // ---------- respect ----------
  ["respect.guard.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Respect Guard",
    description: "Master toggle for the Kicia/KiciaHook disrespect detector.",
    section: "respect"
  }],
  ["respect.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 15 * MINUTE_MS,
    label: "Respect Timeout",
    description: "Default mute duration for confirmed disrespect.",
    section: "respect",
    min: MINUTE_MS,
    max: 7 * DAY_MS
  }],
  ["respect.threshold.action", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.80,
    label: "Action Threshold",
    description: "Disrespect confidence above which the bot auto-acts.",
    section: "respect",
    min: 0,
    max: 1
  }],
  ["respect.threshold.review", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.55,
    label: "Review Threshold",
    description: "Disrespect confidence above which the bot pings staff for review.",
    section: "respect",
    min: 0,
    max: 1
  }],
  ["respect.semantic.high", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.20,
    label: "Semantic High",
    description: "Disrespect-bank minus neutral-bank cosine gap counted as a high signal.",
    section: "respect",
    min: 0,
    max: 1
  }],
  ["respect.semantic.med", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.10,
    label: "Semantic Medium",
    description: "Disrespect-bank cosine gap counted as a moderate signal.",
    section: "respect",
    min: 0,
    max: 1
  }],
  ["respect.head.threshold", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.78,
    label: "Head Threshold",
    description: "Trained-head sigmoid score above which the disrespect head signal counts.",
    section: "respect",
    min: 0,
    max: 1
  }],
  ["respect.tier2.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: HOUR_MS,
    label: "Tier-2 Timeout",
    description: "Repeat-offense escalation timeout (tier 2).",
    section: "respect",
    min: MINUTE_MS,
    max: 14 * DAY_MS
  }],
  ["respect.tier3.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 24 * HOUR_MS,
    label: "Tier-3 Timeout",
    description: "Repeat-offense escalation timeout (tier 3).",
    section: "respect",
    min: MINUTE_MS,
    max: 28 * DAY_MS
  }],
  ["respect.tier.decayMs", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 7 * DAY_MS,
    label: "Tier Decay Window",
    description: "Time window after which a repeat-offense tier resets for escalation tracking.",
    section: "respect",
    min: HOUR_MS,
    max: 30 * DAY_MS
  }],

  // ---------- drug ----------
  ["drug.guard.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Drug Guard",
    description: "Master toggle for the prohibited-commerce (drugs/weapons) classifier.",
    section: "drug"
  }],
  ["drug.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: HOUR_MS,
    label: "Drug Timeout",
    description: "Mute duration applied when prohibited-commerce action fires.",
    section: "drug",
    min: MINUTE_MS,
    max: 28 * DAY_MS
  }],
  ["drug.threshold.confidence", {
    type: SETTING_TYPES.INT,
    defaultValue: 75,
    label: "Confidence Threshold",
    description: "Prohibited-commerce confidence (0-100) required to auto-act.",
    section: "drug",
    min: 0,
    max: 100
  }],

  // ---------- rr (restricted reactions) ----------
  ["rr.guard.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Restricted-Reaction Guard",
    description: "Master toggle for the restricted-emoji-on-staff anti-harassment guard.",
    section: "rr"
  }],
  ["rr.tier1.window", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 30 * SECOND_MS,
    label: "Tier-1 Window",
    description: "Time window for tier-1 reaction spam counting.",
    section: "rr",
    min: 5 * SECOND_MS,
    max: HOUR_MS
  }],
  ["rr.tier1.count", {
    type: SETTING_TYPES.INT,
    defaultValue: 3,
    label: "Tier-1 Count",
    description: "Reactions inside the tier-1 window required to escalate.",
    section: "rr",
    min: 1,
    max: 50
  }],
  ["rr.tier1.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 5 * MINUTE_MS,
    label: "Tier-1 Timeout",
    description: "Timeout duration applied at tier 1.",
    section: "rr",
    min: MINUTE_MS,
    max: 7 * DAY_MS
  }],
  ["rr.tier2.window", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 60 * SECOND_MS,
    label: "Tier-2 Window",
    description: "Time window for tier-2 reaction spam counting.",
    section: "rr",
    min: 5 * SECOND_MS,
    max: HOUR_MS
  }],
  ["rr.tier2.count", {
    type: SETTING_TYPES.INT,
    defaultValue: 5,
    label: "Tier-2 Count",
    description: "Reactions inside the tier-2 window required to escalate.",
    section: "rr",
    min: 1,
    max: 100
  }],
  ["rr.tier2.timeout", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 30 * MINUTE_MS,
    label: "Tier-2 Timeout",
    description: "Timeout duration applied at tier 2.",
    section: "rr",
    min: MINUTE_MS,
    max: 14 * DAY_MS
  }],
  ["rr.tier3.window", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 5 * MINUTE_MS,
    label: "Tier-3 Window",
    description: "Time window for tier-3 reaction spam counting.",
    section: "rr",
    min: 5 * SECOND_MS,
    max: HOUR_MS
  }],
  ["rr.tier3.count", {
    type: SETTING_TYPES.INT,
    defaultValue: 8,
    label: "Tier-3 Count",
    description: "Reactions inside the tier-3 window required to flag for manual review.",
    section: "rr",
    min: 1,
    max: 200
  }],

  // ---------- ghost-ping ----------
  ["ghost-ping.guard.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Ghost-Ping Guard",
    description: "Master toggle for the ghost-ping detector.",
    section: "ghost-ping"
  }],
  ["ghost-ping.retention", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 60 * SECOND_MS,
    label: "Ghost-Ping Retention",
    description: "How long mention-bearing messages stay in the ghost-ping cache.",
    section: "ghost-ping",
    min: 5 * SECOND_MS,
    max: HOUR_MS
  }],

  // ---------- nickname ----------
  ["nickname.guard.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Nickname Guard",
    description: "Master toggle for the bad-nickname rename policy.",
    section: "nickname"
  }],
  ["nickname.cache.ttl", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 10 * MINUTE_MS,
    label: "Nickname Cache TTL",
    description: "Time a normalized-nickname check stays cached per user.",
    section: "nickname",
    min: 30 * SECOND_MS,
    max: HOUR_MS
  }],

  // ---------- impersonation ----------
  ["impersonation.guard.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Impersonation Guard",
    description: "Master toggle for the impersonation-of-staff detector.",
    section: "impersonation"
  }],
  ["impersonation.threshold", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.75,
    label: "Impersonation Threshold",
    description: "Similarity-to-staff-name required to flag as impersonation.",
    section: "impersonation",
    min: 0,
    max: 1
  }],

  // ---------- support ----------
  ["support.answer.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Support Auto-Answer",
    description: "Master toggle for the support-question KB auto-answer.",
    section: "support"
  }],
  ["support.cooldown.user", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 30 * SECOND_MS,
    label: "Per-User Cooldown",
    description: "Per-user cooldown between support auto-answers.",
    section: "support",
    min: SECOND_MS,
    max: 30 * MINUTE_MS
  }],
  ["support.cooldown.global", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 5 * SECOND_MS,
    label: "Global Cooldown",
    description: "Global cooldown between support auto-answers (per channel).",
    section: "support",
    min: SECOND_MS,
    max: 5 * MINUTE_MS
  }],

  // ---------- status ----------
  ["status.answer.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Status Auto-Answer",
    description: "Master toggle for the status / outage question auto-answer.",
    section: "status"
  }],
  ["status.widget.refresh", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 60 * SECOND_MS,
    label: "Status Widget Refresh",
    description: "Status-widget embed refresh interval.",
    section: "status",
    min: 10 * SECOND_MS,
    max: 10 * MINUTE_MS
  }],
  ["status.autodetect.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Auto-Detect & Lockdown",
    description: "Master switch: when off, the bot never auto-detects outages and never auto-locks channels. Owners can still use $status / $lock manually.",
    section: "status"
  }],
  ["status.autodetect.distinct_users", {
    type: SETTING_TYPES.INT,
    defaultValue: 4,
    label: "Auto-Detect Distinct Users",
    description: "Distinct users reporting issues within the window required to auto-detect an outage.",
    section: "status",
    min: 1,
    max: 50
  }],
  ["status.autodetect.window", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 10 * MINUTE_MS,
    label: "Auto-Detect Window",
    description: "Time window used by the outage auto-detector.",
    section: "status",
    min: MINUTE_MS,
    max: HOUR_MS
  }],
  ["status.autodetect.cooldown", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 30 * MINUTE_MS,
    label: "Auto-Detect Cooldown",
    description: "How long auto-detection stays cooled-down after firing once.",
    section: "status",
    min: MINUTE_MS,
    max: 24 * HOUR_MS
  }],

  // ---------- training ----------
  ["training.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Training Pipeline",
    description: "Master toggle for the classifier training-channel pipeline.",
    section: "training"
  }],
  ["training.label.role", {
    type: SETTING_TYPES.STRING,
    defaultValue: "staff",
    label: "Label Role",
    description: "Role name (or ID) whose members may label training samples.",
    section: "training"
  }],
  ["training.retain.days", {
    type: SETTING_TYPES.INT,
    defaultValue: 90,
    label: "Retention Days",
    description: "Training samples older than this are pruned daily.",
    section: "training",
    min: 7,
    max: 365
  }],
  ["training.dedup.windowMs", {
    type: SETTING_TYPES.DURATION,
    defaultValue: 6 * HOUR_MS,
    label: "Dedup Window",
    description: "Identical-text samples from the same author within this window are de-duplicated.",
    section: "training",
    min: MINUTE_MS,
    max: 7 * DAY_MS
  }],
  ["training.borderline.margin", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.10,
    label: "Borderline Margin",
    description: "Samples within +/- this confidence margin from threshold are kept for labeling.",
    section: "training",
    min: 0,
    max: 0.5
  }],
  ["training.auto_retrain.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: false,
    label: "Auto-Retrain",
    description: "Periodically retrain classifier heads from accumulated labels.",
    section: "training"
  }],
  ["training.auto_retrain.min_labels", {
    type: SETTING_TYPES.INT,
    defaultValue: 25,
    label: "Auto-Retrain Min Labels",
    description: "Minimum labels per class before auto-retrain may fire.",
    section: "training",
    min: 5,
    max: 10_000
  }],
  ["training.post.rate_per_sec", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 1,
    label: "Post Rate",
    description: "Maximum training-channel posts per second per guild.",
    section: "training",
    min: 0.1,
    max: 10
  }],
  ["training.post.max_queue", {
    type: SETTING_TYPES.INT,
    defaultValue: 100,
    label: "Post Max Queue",
    description: "Maximum training-channel post queue depth before oldest entries are dropped.",
    section: "training",
    min: 10,
    max: 1000
  }],
  ["training.classifier.scam.threshold", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.30,
    label: "Scam Classifier Threshold",
    description: "Borderline gate for the scam classifier; samples within this margin are queued for labeling. Default is intentionally low because the scam confidence formula is H/5-weighted and rarely exceeds 0.55 on cold start.",
    section: "training",
    min: 0,
    max: 1
  }],
  ["training.classifier.respect.threshold", {
    type: SETTING_TYPES.FLOAT,
    defaultValue: 0.55,
    label: "Respect Classifier Threshold",
    description: "Borderline gate for the respect classifier; samples within this margin are queued for labeling.",
    section: "training",
    min: 0,
    max: 1
  }],

  // ---------- ui ----------
  ["ui.animated-heroes", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Animated Heroes",
    description: "Use animated hero GIFs in critical embeds when available.",
    section: "ui"
  }],
  ["ui.ephemeral-staff", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Ephemeral Staff Replies",
    description: "Make staff command responses ephemeral by default.",
    section: "ui"
  }],

  // ---------- log ----------
  ["log.queue.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Log Queue",
    description: "Controls whether log-channel writes are queued and rate-limited.",
    section: "log"
  }],
  ["log.queue.rate", {
    type: SETTING_TYPES.INT,
    defaultValue: 4,
    label: "Log Queue Rate",
    description: "Maximum log-channel messages per 5 seconds per guild.",
    section: "log",
    min: 1,
    max: 20
  }],
  ["log.queue.maxDepth", {
    type: SETTING_TYPES.INT,
    defaultValue: 200,
    label: "Log Queue Max Depth",
    description: "Maximum log-channel queue depth; oldest entries are dropped when exceeded.",
    section: "log",
    min: 10,
    max: 2000
  }],

  // ---------- daily-stats ----------
  ["daily-stats.enabled", {
    type: SETTING_TYPES.BOOL,
    defaultValue: true,
    label: "Daily Stats",
    description: "Master toggle for the daily-stats summary report.",
    section: "daily-stats"
  }]
];

// build the immutable registry map. validate runs late so descriptors can
// reference their own type-defaulted validate() if they need extra checks.
function buildRegistry() {
  const map = new Map();
  for (const [key, raw] of REGISTRY_ENTRIES) {
    const descriptor = {
      key,
      type: raw.type,
      defaultValue: raw.defaultValue,
      label: raw.label || key,
      description: raw.description || "",
      section: raw.section || "other",
      min: raw.min,
      max: raw.max,
      choices: raw.choices,
      validate: raw.validate || (() => null)
    };
    map.set(key, Object.freeze(descriptor));
  }
  return map;
}

const REGISTRY = buildRegistry();
const SECTION_LIST = Object.freeze(
  Array.from(new Set(Array.from(REGISTRY.values()).map((d) => d.section)))
);

// per-key value cache. populated by hydrateSettingsCache() and by setSetting().
// {value: any, loadedAt: epoch-ms}. expires after CACHE_TTL_MS — past that the
// hot path returns the descriptor default until the next hydrate.
const cache = new Map();

function cacheStore(key, value) {
  cache.set(key, { value, loadedAt: Date.now() });
}

function cacheRead(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  // BUG FIX (2026-05-24): previously expired entries after CACHE_TTL_MS (60s),
  // causing getSetting() to fall through to the descriptor default — which
  // silently undid every $toggle / $config set ~60s after the write. The cache
  // is the single source of truth for the running process: hydrated on boot,
  // updated on every setSetting/resetSetting. No reason to expire it.
  return entry.value;
}

function cacheEvict(key) {
  cache.delete(key);
}

// ---------- public API ----------

function getSetting(key) {
  const descriptor = REGISTRY.get(key);
  if (!descriptor) {
    recordRuntimeEvent("warn", "settings.unknown", `getSetting(${key}) — unknown key`);
    return undefined;
  }
  const cached = cacheRead(key);
  if (cached !== undefined) return cached;
  return descriptor.defaultValue;
}

function getRegistry() {
  return REGISTRY;
}

function listSections() {
  return [...SECTION_LIST];
}

function describeSetting(key) {
  return REGISTRY.get(key) || null;
}

function formatValue(key, value) {
  const descriptor = REGISTRY.get(key);
  if (!descriptor) return String(value ?? "");
  return formatValueForDisplay(descriptor, value);
}

function coerceInputValue(key, rawValue) {
  const descriptor = REGISTRY.get(key);
  if (!descriptor) return { ok: false, error: `unknown setting key: ${key}` };
  let result;
  switch (descriptor.type) {
    case SETTING_TYPES.BOOL:
      result = coerceBool(rawValue);
      break;
    case SETTING_TYPES.DURATION:
      result = coerceDuration(rawValue, descriptor);
      break;
    case SETTING_TYPES.FLOAT:
      result = coerceFloat(rawValue, descriptor);
      break;
    case SETTING_TYPES.INT:
      result = coerceInt(rawValue, descriptor);
      break;
    case SETTING_TYPES.ENUM:
      result = coerceEnum(rawValue, descriptor);
      break;
    case SETTING_TYPES.STRING:
    default:
      result = coerceString(rawValue);
      break;
  }
  if (!result.ok) return result;
  const validateError = descriptor.validate ? descriptor.validate(result.value) : null;
  if (validateError) return { ok: false, error: validateError };
  return result;
}

function suggestKeys(input, { limit = 3 } = {}) {
  const needle = String(input || "").trim().toLowerCase();
  if (!needle) return [];
  const max = Math.max(1, Math.min(20, Number(limit) || 3));
  const scored = [];
  for (const key of REGISTRY.keys()) {
    const distance = levenshteinDistance(needle, key.toLowerCase());
    const contains = key.toLowerCase().includes(needle) ? 0 : 1;
    scored.push({ key, score: distance + contains * 0.5 });
  }
  scored.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key));
  return scored.slice(0, max).map((entry) => entry.key);
}

async function hydrateSettingsCache(db) {
  if (!db) return;
  const keys = Array.from(REGISTRY.keys());
  if (!keys.length) return;
  try {
    const placeholders = keys.map(() => "?").join(",");
    const rows = dbGetRows(
      db,
      `SELECT key, value FROM app_config WHERE key IN (${placeholders})`,
      keys
    );
    const byKey = new Map();
    for (const row of rows) {
      if (row && row.key != null) byKey.set(String(row.key), row.value);
    }
    for (const [key, descriptor] of REGISTRY.entries()) {
      if (byKey.has(key)) {
        const coerced = deserializeValue(descriptor, byKey.get(key));
        cacheStore(key, coerced);
      } else {
        // leave the cache empty so getSetting returns the descriptor default
        // until an owner sets a value.
        cache.delete(key);
      }
    }
  } catch (err) {
    recordRuntimeEvent("error", "settings.hydrate", err?.message || err);
  }
}

function buildAuditPanel({ verb, key, descriptor, previous, next, actor, color }) {
  const actorMention = actor && actor.id ? `<@${actor.id}>` : "unknown actor";
  const previousDisplay = previous === undefined
    ? "_unset_"
    : formatValueForDisplay(descriptor, previous);
  const nextDisplay = next === undefined
    ? "_default_"
    : formatValueForDisplay(descriptor, next);
  const lines = [
    `**Actor:** ${actorMention}`,
    `**Key:** \`${key}\``,
    `**Section:** \`${descriptor.section}\``,
    `**Type:** \`${descriptor.type}\``,
    `**${verb === "reset" ? "Reset to default" : "Change"}:** \`${previousDisplay}\` → \`${nextDisplay}\``,
    `**When:** <t:${Math.floor(Date.now() / 1000)}:R>`
  ];
  return buildPanel({
    header: "Config Changed",
    body: lines.join("\n"),
    color,
    autoFields: true
  });
}

async function emitAudit(guild, panel) {
  if (!guild) return;
  try {
    const logChannel = require("./log-channel");
    if (typeof logChannel.sendLogPanel === "function") {
      await logChannel.sendLogPanel(guild, { embed: panel });
    }
  } catch (err) {
    recordRuntimeEvent("warn", "settings.audit", err?.message || err);
  }
}

async function setSetting(key, rawValue, options = {}) {
  const { db, actor, guild } = options;
  const descriptor = REGISTRY.get(key);
  if (!descriptor) {
    const suggestions = suggestKeys(key);
    return {
      ok: false,
      error: `unknown setting key: ${key}`,
      suggestions
    };
  }
  if (!db) {
    return { ok: false, error: "no database handle supplied", descriptor };
  }
  const coerced = coerceInputValue(key, rawValue);
  if (!coerced.ok) {
    return { ok: false, error: coerced.error, descriptor };
  }
  const previous = getSetting(key);
  const next = coerced.value;
  try {
    dbSetAppConfig(db, key, serializeValue(descriptor, next));
    flushNow(db);
  } catch (err) {
    recordRuntimeEvent("error", "settings.persist", `${key}: ${err?.message || err}`);
    return { ok: false, error: "failed to persist setting", descriptor };
  }
  cacheStore(key, next);
  if (guild) {
    const panel = buildAuditPanel({
      verb: "set",
      key,
      descriptor,
      previous,
      next,
      actor,
      color: WARN
    });
    await emitAudit(guild, panel);
  }
  return { ok: true, previous, next, descriptor };
}

async function resetSetting(key, options = {}) {
  const { db, actor, guild } = options;
  const descriptor = REGISTRY.get(key);
  if (!descriptor) {
    const suggestions = suggestKeys(key);
    return {
      ok: false,
      error: `unknown setting key: ${key}`,
      suggestions
    };
  }
  if (!db) {
    return { ok: false, error: "no database handle supplied", descriptor };
  }
  const previous = getSetting(key);
  try {
    dbDeleteAppConfig(db, key);
    flushNow(db);
  } catch (err) {
    recordRuntimeEvent("error", "settings.reset", `${key}: ${err?.message || err}`);
    return { ok: false, error: "failed to reset setting", descriptor };
  }
  cacheEvict(key);
  if (guild) {
    const panel = buildAuditPanel({
      verb: "reset",
      key,
      descriptor,
      previous,
      next: descriptor.defaultValue,
      actor,
      color: INFO
    });
    await emitAudit(guild, panel);
  }
  return { ok: true, previous, descriptor };
}

// ---------- test hooks ----------

function __resetForTests() {
  cache.clear();
  _emojiDb = null;
}

function __getCacheSnapshotForTests() {
  const out = {};
  for (const [key, entry] of cache.entries()) {
    out[key] = { value: entry.value, loadedAt: entry.loadedAt };
  }
  return out;
}

module.exports = {
  SETTING_TYPES,
  CACHE_TTL_MS,
  getSetting,
  setSetting,
  resetSetting,
  hydrateSettingsCache,
  getRegistry,
  listSections,
  describeSetting,
  formatValue,
  coerceInputValue,
  suggestKeys,
  __resetForTests,
  __getCacheSnapshotForTests
};
