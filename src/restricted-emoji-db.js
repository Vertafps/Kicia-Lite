const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const initSqlJs = require("sql.js");
const { BOT_PRESENCE_TEXT, DEFAULT_EMOJI_TIMEOUT_MS } = require("./config");
const {
  CHANNEL_CONFIG_SLOTS,
  getChannelSlotDefinition,
  getStoredChannelConfigKey,
  hydrateChannelConfigCache,
  listChannelConfigSlots,
  normalizeChannelId,
  resetCachedChannelSlot,
  resetChannelConfigCache,
  setCachedChannelSlot
} = require("./channel-config");
const { clampDurationMs } = require("./duration");
const {
  BOT_PRESENCE_STATE_KEY,
  sanitizePresenceState,
  validatePresenceState
} = require("./presence-state");
const { formatNicknameRenameTarget } = require("./nickname-policy");
const { recordRuntimeEvent } = require("./runtime-health");

const CUSTOM_EMOJI_RE = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/;
const DEFAULT_DATABASE_PATH = path.join(__dirname, "..", "data", "restricted-reactions.sqlite");
const SQL_JS_DIST_DIR = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
const PERSIST_DEBOUNCE_MS = 2_500;
const DAILY_STATS_WINDOW_KEY = "daily_stats_window_started_at";

let sqlPromise = null;
let dbPromise = null;
let currentDb = null;
let databasePath = DEFAULT_DATABASE_PATH;
let persistTimer = null;
let databaseDirty = false;

function ensureDatabaseDirectory(filePath = databasePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getLocateFilePath(file) {
  return path.join(SQL_JS_DIST_DIR, file);
}

function clearPersistTimer() {
  if (!persistTimer) return;
  clearTimeout(persistTimer);
  persistTimer = null;
}

function writeDatabaseFile(db) {
  ensureDatabaseDirectory();
  const exportBuffer = Buffer.from(db.export());
  const tempPath = `${databasePath}.tmp`;
  fs.writeFileSync(tempPath, exportBuffer);
  fs.renameSync(tempPath, databasePath);
}

function schedulePersist(db, { immediate = false } = {}) {
  if (!db) return false;
  databaseDirty = true;

  if (immediate) {
    flushRestrictedEmojiDatabaseNow(db);
    return true;
  }

  if (persistTimer) return true;
  persistTimer = setTimeout(() => {
    try {
      flushRestrictedEmojiDatabaseNow(db);
    } catch (err) {
      recordRuntimeEvent("error", "emoji-db-persist", err?.message || err);
    }
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
  return true;
}

function buildStoredEmojiKey({ type, id, name }) {
  if (type === "custom" && id) return `custom:${id}`;
  if (type === "unicode" && name) return `unicode:${name}`;
  return null;
}

function parseEmojiInput(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return null;

  const customMatch = trimmed.match(CUSTOM_EMOJI_RE);
  if (customMatch) {
    const [, animatedFlag, name, id] = customMatch;
    return {
      key: buildStoredEmojiKey({ type: "custom", id }),
      type: "custom",
      display: trimmed,
      name,
      id,
      animated: animatedFlag === "a"
    };
  }

  if (/\s/.test(trimmed)) return null;
  return {
    key: buildStoredEmojiKey({ type: "unicode", name: trimmed }),
    type: "unicode",
    display: trimmed,
    name: trimmed,
    id: null,
    animated: false
  };
}

function getReactionEmojiRecord(emoji) {
  if (emoji?.id) {
    const id = String(emoji.id);
    const name = String(emoji.name || "emoji");
    const animated = Boolean(emoji.animated);
    return {
      key: buildStoredEmojiKey({ type: "custom", id }),
      type: "custom",
      display: `<${animated ? "a" : ""}:${name}:${id}>`,
      name,
      id,
      animated
    };
  }

  const name = String(emoji?.name || "").trim();
  if (!name) return null;
  return {
    key: buildStoredEmojiKey({ type: "unicode", name }),
    type: "unicode",
    display: name,
    name,
    id: null,
    animated: false
  };
}

function matchesStoredEmoji(storedEmoji, reactionEmoji) {
  const reactionRecord = getReactionEmojiRecord(reactionEmoji);
  return Boolean(storedEmoji?.key && reactionRecord?.key && storedEmoji.key === reactionRecord.key);
}

async function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: getLocateFilePath
    });
  }
  return sqlPromise;
}

function closeDatabase(db) {
  clearPersistTimer();
  try {
    db?.close?.();
  } catch {}
  currentDb = null;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS restricted_emojis (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      display TEXT NOT NULL,
      emoji_name TEXT,
      emoji_id TEXT,
      animated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_user_message_stats (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER NOT NULL DEFAULT 0,
      last_channel_id TEXT,
      last_channel_name TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_channel_message_stats (
      channel_id TEXT PRIMARY KEY,
      channel_name TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_hour_message_stats (
      local_hour INTEGER PRIMARY KEY,
      message_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_staff_message_stats (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message_at INTEGER NOT NULL DEFAULT 0,
      last_channel_id TEXT,
      last_channel_name TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_moderation_stats (
      event_key TEXT PRIMARY KEY,
      event_count INTEGER NOT NULL DEFAULT 0,
      last_event_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS trusted_links (
      key TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderation_whitelist (
      user_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      guild_id TEXT,
      channel_id TEXT,
      message_id TEXT,
      message_url TEXT,
      user_id TEXT,
      username TEXT,
      action_type TEXT NOT NULL,
      action_label TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL DEFAULT 0,
      timeout_applied INTEGER NOT NULL DEFAULT 0,
      delete_applied INTEGER NOT NULL DEFAULT 0,
      dm_sent INTEGER NOT NULL DEFAULT 0,
      message_content TEXT,
      recent_messages_json TEXT,
      reasons_json TEXT
    );

    CREATE INDEX IF NOT EXISTS moderation_actions_expires_idx
      ON moderation_actions (expires_at);

    CREATE TABLE IF NOT EXISTS nickname_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      flags TEXT NOT NULL DEFAULT 'i',
      rename_to TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS nickname_patterns_pattern_flags_idx
      ON nickname_patterns (pattern, flags);

    CREATE TABLE IF NOT EXISTS status_transitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_id TEXT,
      actor_label TEXT,
      reason TEXT
    );

    CREATE INDEX IF NOT EXISTS status_transitions_occurred_idx
      ON status_transitions (occurred_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS outage_reviews (
      review_id TEXT PRIMARY KEY,
      guild_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      distinct_users INTEGER NOT NULL DEFAULT 0,
      samples_json TEXT,
      lock_result_json TEXT,
      resolved_at INTEGER,
      resolved_by_id TEXT,
      resolved_by_label TEXT,
      resolution TEXT
    );

    CREATE INDEX IF NOT EXISTS outage_reviews_status_idx
      ON outage_reviews (status);

    CREATE INDEX IF NOT EXISTS outage_reviews_expires_idx
      ON outage_reviews (expires_at);

  `);

  try {
    db.exec("ALTER TABLE moderation_actions ADD COLUMN recent_messages_json TEXT;");
  } catch {}

  // Migration: drop the old scam_decision_audit table from pre-v2 databases.
  // Scam detection has been removed entirely; the table is no longer used.
  try {
    db.exec("DROP TABLE IF EXISTS scam_decision_audit;");
  } catch {}

  // Migration: ensure new feature tables exist.
  db.exec(`
    CREATE TABLE IF NOT EXISTS restricted_emoji_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      emoji_key TEXT NOT NULL,
      channel_id TEXT,
      occurred_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS restricted_emoji_usage_user_idx
      ON restricted_emoji_usage (user_id, occurred_at DESC);

    CREATE INDEX IF NOT EXISTS restricted_emoji_usage_occurred_idx
      ON restricted_emoji_usage (occurred_at DESC);

    CREATE TABLE IF NOT EXISTS emoji_spam_state (
      user_id TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_action_tier INTEGER NOT NULL DEFAULT 0,
      last_action_at INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function getScalarValue(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (!stmt.step()) return null;
    return stmt.get()[0];
  } finally {
    stmt.free();
  }
}

function getRows(db, sql, params = []) {
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

function getAppConfigValue(db, key) {
  return getScalarValue(db, "SELECT value FROM app_config WHERE key = ?", [key]);
}

function setAppConfigValue(db, key, value, { immediate = false } = {}) {
  db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)", [
    key,
    String(value)
  ]);
  schedulePersist(db, { immediate });
}

function deleteAppConfigValue(db, key, { immediate = false } = {}) {
  db.run("DELETE FROM app_config WHERE key = ?", [key]);
  schedulePersist(db, { immediate });
}

function hydrateChannelConfigFromDatabase(db) {
  const values = {};
  for (const slot of CHANNEL_CONFIG_SLOTS) {
    const stored = getAppConfigValue(db, getStoredChannelConfigKey(slot.key));
    if (stored) values[slot.key] = stored;
  }
  hydrateChannelConfigCache(values);
}

function ensureDefaultConfig(db) {
  db.run("INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)", [
    "emoji_timeout_ms",
    String(DEFAULT_EMOJI_TIMEOUT_MS)
  ]);
  db.run("INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)", [
    BOT_PRESENCE_STATE_KEY,
    BOT_PRESENCE_TEXT
  ]);
}

function mapEmojiRow(row) {
  return {
    key: String(row.key || ""),
    type: String(row.type || "unicode"),
    display: String(row.display || ""),
    name: row.emoji_name ? String(row.emoji_name) : null,
    id: row.emoji_id ? String(row.emoji_id) : null,
    animated: Boolean(row.animated),
    createdAt: Number(row.created_at || 0)
  };
}

function mapDailyUserRow(row) {
  return {
    userId: String(row.user_id || ""),
    username: row.username ? String(row.username) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    messageCount: Number(row.message_count || 0),
    lastMessageAt: Number(row.last_message_at || 0),
    lastChannelId: row.last_channel_id ? String(row.last_channel_id) : null,
    lastChannelName: row.last_channel_name ? String(row.last_channel_name) : null
  };
}

function mapDailyChannelRow(row) {
  return {
    channelId: String(row.channel_id || ""),
    channelName: row.channel_name ? String(row.channel_name) : null,
    messageCount: Number(row.message_count || 0),
    lastMessageAt: Number(row.last_message_at || 0)
  };
}

function mapDailyHourRow(row) {
  return {
    localHour: Number(row.local_hour || 0),
    messageCount: Number(row.message_count || 0)
  };
}

function mapDailyStaffRow(row) {
  return {
    userId: String(row.user_id || ""),
    username: row.username ? String(row.username) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    messageCount: Number(row.message_count || 0),
    lastMessageAt: Number(row.last_message_at || 0),
    lastChannelId: row.last_channel_id ? String(row.last_channel_id) : null,
    lastChannelName: row.last_channel_name ? String(row.last_channel_name) : null
  };
}

function mapDailyModerationRow(row) {
  return {
    eventKey: String(row.event_key || ""),
    eventCount: Number(row.event_count || 0),
    lastEventAt: Number(row.last_event_at || 0)
  };
}

function mapTrustedLinkRow(row) {
  return {
    key: String(row.key || ""),
    url: String(row.url || ""),
    createdAt: Number(row.created_at || 0)
  };
}

function mapModerationWhitelistRow(row) {
  return {
    userId: String(row.user_id || ""),
    createdAt: Number(row.created_at || 0),
    createdBy: row.created_by ? String(row.created_by) : null
  };
}

function mapNicknamePatternRow(row) {
  const pattern = String(row.pattern || "");
  const flags = String(row.flags || "i");
  const renameTo = String(row.rename_to || "");
  const displayRenameTo = formatNicknameRenameTarget(renameTo);
  return {
    id: Number(row.id || 0),
    pattern,
    flags,
    renameTo,
    createdAt: Number(row.created_at || 0),
    display: `/${pattern}/${flags} -> ${displayRenameTo}`
  };
}

function mapAuditVerdict(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (normalized === "borderline") return null;
  return undefined;
}

// Scam audit table + helpers removed — see scam_decision_audit DROP migration
// in createSchema().

function mapModerationActionRow(row) {
  let reasons = [];
  let recentMessages = [];
  try {
    reasons = JSON.parse(row.reasons_json || "[]");
  } catch {
    reasons = [];
  }
  try {
    const parsed = JSON.parse(row.recent_messages_json || "[]");
    recentMessages = Array.isArray(parsed) ? parsed : [];
  } catch {
    recentMessages = [];
  }

  return {
    id: row.id,
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
    guildId: row.guild_id || null,
    channelId: row.channel_id || null,
    messageId: row.message_id || null,
    messageUrl: row.message_url || null,
    userId: row.user_id || null,
    username: row.username || null,
    actionType: row.action_type,
    actionLabel: row.action_label,
    timeoutMs: Number(row.timeout_ms || 0),
    timeoutApplied: Boolean(row.timeout_applied),
    deleteApplied: Boolean(row.delete_applied),
    dmSent: Boolean(row.dm_sent),
    messageContent: row.message_content || "",
    recentMessages,
    reasons: Array.isArray(reasons) ? reasons : []
  };
}

async function loadDatabase() {
  ensureDatabaseDirectory();
  const SQL = await getSql();

  try {
    const db = fs.existsSync(databasePath)
      ? new SQL.Database(fs.readFileSync(databasePath))
      : new SQL.Database();

    currentDb = db;
    createSchema(db);
    ensureDefaultConfig(db);
    hydrateChannelConfigFromDatabase(db);
    writeDatabaseFile(db);
    databaseDirty = false;
    return db;
  } catch (err) {
    recordRuntimeEvent("error", "emoji-db-load", err?.message || err);

    try {
      if (fs.existsSync(databasePath)) {
        fs.renameSync(databasePath, `${databasePath}.broken-${Date.now()}`);
      }
    } catch {}

    const db = new SQL.Database();
    currentDb = db;
    createSchema(db);
    ensureDefaultConfig(db);
    hydrateChannelConfigFromDatabase(db);
    writeDatabaseFile(db);
    databaseDirty = false;
    return db;
  }
}

async function getDatabase() {
  if (!dbPromise) {
    dbPromise = loadDatabase();
  }

  try {
    return await dbPromise;
  } catch (err) {
    dbPromise = null;
    currentDb = null;
    throw err;
  }
}

function flushRestrictedEmojiDatabaseNow(db = currentDb) {
  if (!db || !databaseDirty) {
    clearPersistTimer();
    return false;
  }

  clearPersistTimer();
  writeDatabaseFile(db);
  databaseDirty = false;
  return true;
}

async function cleanupRestrictedEmojiDatabaseTempFiles() {
  try {
    flushRestrictedEmojiDatabaseNow();
  } catch (err) {
    recordRuntimeEvent("warn", "emoji-db-cleanup-flush", err?.message || err);
  }

  const tempPath = `${databasePath}.tmp`;
  const removed = [];

  if (fs.existsSync(tempPath)) {
    try {
      fs.rmSync(tempPath, { force: true });
      removed.push(tempPath);
    } catch (err) {
      recordRuntimeEvent("warn", "emoji-db-temp-cleanup", err?.message || err);
    }
  }

  return {
    removed,
    checked: [tempPath]
  };
}

async function getEmojiTimeoutMs() {
  const db = await getDatabase();
  const stored = getAppConfigValue(db, "emoji_timeout_ms");
  return clampDurationMs(Number(stored || DEFAULT_EMOJI_TIMEOUT_MS));
}

async function setEmojiTimeoutMs(durationMs) {
  const db = await getDatabase();
  const normalized = clampDurationMs(durationMs);

  setAppConfigValue(db, "emoji_timeout_ms", normalized, { immediate: true });
  return normalized;
}

const POLICY_ENFORCEMENT_ENABLED_KEY = "policy_enforcement_enabled";

function readBooleanAppConfig(db, key, defaultValue) {
  const stored = getAppConfigValue(db, key);
  if (stored == null || stored === "") return defaultValue;
  const value = String(stored).toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

async function getPolicyEnforcementEnabled() {
  const db = await getDatabase();
  return readBooleanAppConfig(db, POLICY_ENFORCEMENT_ENABLED_KEY, true);
}

async function setPolicyEnforcementEnabled(enabled) {
  const db = await getDatabase();
  setAppConfigValue(db, POLICY_ENFORCEMENT_ENABLED_KEY, enabled ? "1" : "0", { immediate: true });
  return Boolean(enabled);
}

async function getBotPresenceState() {
  const db = await getDatabase();
  const stored = sanitizePresenceState(getAppConfigValue(db, BOT_PRESENCE_STATE_KEY));
  return stored || BOT_PRESENCE_TEXT;
}

async function setBotPresenceState(input) {
  const validation = validatePresenceState(input);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const db = await getDatabase();
  setAppConfigValue(db, BOT_PRESENCE_STATE_KEY, validation.state, { immediate: true });
  return validation.state;
}

async function resetBotPresenceState() {
  const db = await getDatabase();
  setAppConfigValue(db, BOT_PRESENCE_STATE_KEY, BOT_PRESENCE_TEXT, { immediate: true });
  return BOT_PRESENCE_TEXT;
}

async function hydrateChannelSettings() {
  const db = await getDatabase();
  hydrateChannelConfigFromDatabase(db);
  return listChannelConfigSlots();
}

async function listChannelSettings() {
  const db = await getDatabase();
  hydrateChannelConfigFromDatabase(db);
  return listChannelConfigSlots();
}

async function setChannelSetting(slotKey, channelId) {
  const slot = getChannelSlotDefinition(slotKey);
  const id = normalizeChannelId(channelId);
  if (!slot || !id) return null;

  const db = await getDatabase();
  setAppConfigValue(db, getStoredChannelConfigKey(slot.key), id, { immediate: true });
  setCachedChannelSlot(slot.key, id);
  return listChannelConfigSlots().find((entry) => entry.key === slot.key) || null;
}

async function resetChannelSetting(slotKey) {
  const slot = getChannelSlotDefinition(slotKey);
  if (!slot) return null;

  const db = await getDatabase();
  deleteAppConfigValue(db, getStoredChannelConfigKey(slot.key), { immediate: true });
  resetCachedChannelSlot(slot.key);
  return listChannelConfigSlots().find((entry) => entry.key === slot.key) || null;
}

async function getDailyStatsWindowStartedAt() {
  const db = await getDatabase();
  const stored = Number(getAppConfigValue(db, DAILY_STATS_WINDOW_KEY) || 0);
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

async function ensureDailyStatsWindowStartedAt(defaultStartedAt) {
  const db = await getDatabase();
  const stored = Number(getAppConfigValue(db, DAILY_STATS_WINDOW_KEY) || 0);
  if (Number.isFinite(stored) && stored > 0) {
    return stored;
  }

  const nextValue = Number.isFinite(Number(defaultStartedAt)) && Number(defaultStartedAt) > 0
    ? Math.round(Number(defaultStartedAt))
    : Date.now();
  setAppConfigValue(db, DAILY_STATS_WINDOW_KEY, nextValue, { immediate: true });
  return nextValue;
}

async function setDailyStatsWindowStartedAt(startedAt) {
  const db = await getDatabase();
  const normalized = Math.max(1, Math.round(Number(startedAt) || Date.now()));
  setAppConfigValue(db, DAILY_STATS_WINDOW_KEY, normalized, { immediate: true });
  return normalized;
}

async function listRestrictedEmojis() {
  const db = await getDatabase();
  return getRows(
    db,
    `
      SELECT key, type, display, emoji_name, emoji_id, animated, created_at
      FROM restricted_emojis
      ORDER BY created_at ASC, key ASC
    `
  ).map(mapEmojiRow);
}

// ── Restricted emoji telemetry + spam escalation ─────────────────────────────

async function recordRestrictedEmojiUsage({ userId, emojiKey, channelId = null, occurredAt = Date.now() } = {}) {
  if (!userId || !emojiKey) return false;
  const db = await getDatabase();
  db.run(
    `
      INSERT INTO restricted_emoji_usage (user_id, emoji_key, channel_id, occurred_at)
      VALUES (?, ?, ?, ?)
    `,
    [
      String(userId),
      String(emojiKey),
      channelId ? String(channelId) : null,
      Math.max(1, Math.round(Number(occurredAt) || Date.now()))
    ]
  );
  schedulePersist(db);
  return true;
}

async function listRestrictedEmojiTopOffenders({ sinceMs = 7 * 24 * 60 * 60 * 1000, limit = 10, now = Date.now() } = {}) {
  const db = await getDatabase();
  const since = Math.max(1, Math.round(now - sinceMs));
  return getRows(
    db,
    `
      SELECT user_id, COUNT(*) AS total
      FROM restricted_emoji_usage
      WHERE occurred_at >= ?
      GROUP BY user_id
      ORDER BY total DESC
      LIMIT ?
    `,
    [since, Math.max(1, Math.min(50, Math.round(Number(limit) || 10)))]
  ).map((row) => ({ userId: String(row.user_id), total: Number(row.total || 0) }));
}

async function listRestrictedEmojiTopUsage({ sinceMs = 7 * 24 * 60 * 60 * 1000, limit = 10, now = Date.now() } = {}) {
  const db = await getDatabase();
  const since = Math.max(1, Math.round(now - sinceMs));
  return getRows(
    db,
    `
      SELECT emoji_key, COUNT(*) AS total
      FROM restricted_emoji_usage
      WHERE occurred_at >= ?
      GROUP BY emoji_key
      ORDER BY total DESC
      LIMIT ?
    `,
    [since, Math.max(1, Math.min(50, Math.round(Number(limit) || 10)))]
  ).map((row) => ({ emojiKey: String(row.emoji_key), total: Number(row.total || 0) }));
}

async function getRestrictedEmojiCountSince({ sinceMs = 7 * 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const db = await getDatabase();
  const since = Math.max(1, Math.round(now - sinceMs));
  return Number(
    getScalarValue(
      db,
      "SELECT COUNT(*) FROM restricted_emoji_usage WHERE occurred_at >= ?",
      [since]
    ) || 0
  );
}

/**
 * Bump per-user emoji-spam state and return any escalation tier triggered.
 *
 * Tiers (configurable via EMOJI_SPAM_TIER*_* env):
 *   tier 1 — 3 in 30s   → 5-minute timeout
 *   tier 2 — 5 in 60s   → 30-minute timeout
 *   tier 3 — 8 in 5min  → staff manual-review flag (no auto-timeout)
 *
 * State columns:
 *   window_start    — start of the rolling tier-3 window
 *   count           — events since window_start
 *   last_action_tier— max tier triggered in this window (so we don't double-fire)
 *   last_action_at  — when the last action was taken
 *
 * Returns: { tier: 1|2|3|0, count, windowMs }
 */
async function bumpEmojiSpamState({
  userId,
  now = Date.now(),
  tier1Window,
  tier1Count,
  tier2Window,
  tier2Count,
  tier3Window,
  tier3Count
} = {}) {
  if (!userId) return { tier: 0, count: 0 };

  const t1Win = Math.max(5_000, Number(tier1Window) || 30_000);
  const t1Cnt = Math.max(2, Number(tier1Count) || 3);
  const t2Win = Math.max(t1Win, Number(tier2Window) || 60_000);
  const t2Cnt = Math.max(t1Cnt + 1, Number(tier2Count) || 5);
  const t3Win = Math.max(t2Win, Number(tier3Window) || 5 * 60 * 1000);
  const t3Cnt = Math.max(t2Cnt + 1, Number(tier3Count) || 8);

  const db = await getDatabase();
  const existing = getRows(
    db,
    "SELECT user_id, window_start, count, last_action_tier, last_action_at FROM emoji_spam_state WHERE user_id = ? LIMIT 1",
    [String(userId)]
  )[0];

  const windowStart = existing && (now - Number(existing.window_start || 0)) < t3Win
    ? Number(existing.window_start)
    : now;
  const previousTier = existing && windowStart === Number(existing.window_start)
    ? Number(existing.last_action_tier || 0)
    : 0;
  const previousCount = existing && windowStart === Number(existing.window_start)
    ? Number(existing.count || 0)
    : 0;
  const count = previousCount + 1;

  // Determine the highest tier triggered in this bump (only fire each tier once
  // per rolling window).
  let tier = 0;
  if (previousTier < 3 && count >= t3Cnt && (now - windowStart) < t3Win) tier = 3;
  else if (previousTier < 2 && count >= t2Cnt && (now - windowStart) < t2Win) tier = 2;
  else if (previousTier < 1 && count >= t1Cnt && (now - windowStart) < t1Win) tier = 1;

  const lastActionTier = Math.max(previousTier, tier);
  const lastActionAt = tier > previousTier ? now : Number(existing?.last_action_at || 0);

  db.run(
    `
      INSERT INTO emoji_spam_state (user_id, window_start, count, last_action_tier, last_action_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        window_start = excluded.window_start,
        count = excluded.count,
        last_action_tier = excluded.last_action_tier,
        last_action_at = excluded.last_action_at
    `,
    [String(userId), windowStart, count, lastActionTier, lastActionAt]
  );
  schedulePersist(db);

  return { tier, count, windowStart };
}

async function cleanupExpiredEmojiSpamState({ olderThanMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const db = await getDatabase();
  const cutoff = Math.max(1, Math.round(now - olderThanMs));
  db.run("DELETE FROM emoji_spam_state WHERE window_start < ?", [cutoff]);
  schedulePersist(db);
  return true;
}

async function addRestrictedEmoji(emojiRecord) {
  if (!emojiRecord?.key) {
    throw new Error("Missing emoji key");
  }

  const db = await getDatabase();
  const existing = getRows(
    db,
    `
      SELECT key, type, display, emoji_name, emoji_id, animated, created_at
      FROM restricted_emojis
      WHERE key = ?
      LIMIT 1
    `,
    [emojiRecord.key]
  )[0];

  if (existing) {
    return {
      added: false,
      emoji: mapEmojiRow(existing)
    };
  }

  db.run(
    `
      INSERT INTO restricted_emojis (
        key,
        type,
        display,
        emoji_name,
        emoji_id,
        animated,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      emojiRecord.key,
      emojiRecord.type,
      emojiRecord.display,
      emojiRecord.name,
      emojiRecord.id,
      emojiRecord.animated ? 1 : 0,
      Date.now()
    ]
  );
  schedulePersist(db, { immediate: true });

  return {
    added: true,
    emoji: emojiRecord
  };
}

async function removeRestrictedEmojiByKey(key) {
  if (!key) {
    throw new Error("Missing emoji key");
  }

  const db = await getDatabase();
  const existing = getRows(
    db,
    `
      SELECT key, type, display, emoji_name, emoji_id, animated, created_at
      FROM restricted_emojis
      WHERE key = ?
      LIMIT 1
    `,
    [key]
  )[0];

  if (!existing) {
    return {
      removed: false,
      emoji: null
    };
  }

  db.run("DELETE FROM restricted_emojis WHERE key = ?", [key]);
  schedulePersist(db, { immediate: true });

  return {
    removed: true,
    emoji: mapEmojiRow(existing)
  };
}

async function listTrustedLinks() {
  const db = await getDatabase();
  return getRows(
    db,
    `
      SELECT key, url, created_at
      FROM trusted_links
      ORDER BY created_at ASC, key ASC
    `
  ).map(mapTrustedLinkRow);
}

async function addTrustedLink(linkRecord) {
  if (!linkRecord?.key || !linkRecord?.url) {
    throw new Error("Missing trusted link");
  }

  const db = await getDatabase();
  const existing = getRows(
    db,
    `
      SELECT key, url, created_at
      FROM trusted_links
      WHERE key = ?
      LIMIT 1
    `,
    [linkRecord.key]
  )[0];

  if (existing) {
    return {
      added: false,
      link: mapTrustedLinkRow(existing)
    };
  }

  db.run(
    `
      INSERT INTO trusted_links (
        key,
        url,
        created_at
      ) VALUES (?, ?, ?)
    `,
    [
      linkRecord.key,
      linkRecord.url,
      Date.now()
    ]
  );
  schedulePersist(db, { immediate: true });

  return {
    added: true,
    link: linkRecord
  };
}

async function removeTrustedLinkByKey(key) {
  if (!key) {
    throw new Error("Missing trusted link key");
  }

  const db = await getDatabase();
  const existing = getRows(
    db,
    `
      SELECT key, url, created_at
      FROM trusted_links
      WHERE key = ?
      LIMIT 1
    `,
    [key]
  )[0];

  if (!existing) {
    return {
      removed: false,
      link: null
    };
  }

  db.run("DELETE FROM trusted_links WHERE key = ?", [key]);
  schedulePersist(db, { immediate: true });

  return {
    removed: true,
    link: mapTrustedLinkRow(existing)
  };
}

async function listModerationWhitelistedUsers() {
  const db = await getDatabase();
  return getRows(
    db,
    `
      SELECT user_id, created_at, created_by
      FROM moderation_whitelist
      ORDER BY created_at ASC, user_id ASC
    `
  ).map(mapModerationWhitelistRow);
}

async function isModerationWhitelistedUser(userId) {
  const id = String(userId || "").trim();
  if (!id) return false;

  const db = await getDatabase();
  return Boolean(getScalarValue(
    db,
    "SELECT 1 FROM moderation_whitelist WHERE user_id = ? LIMIT 1",
    [id]
  ));
}

async function addModerationWhitelistedUser(userId, { createdBy = null } = {}) {
  const id = String(userId || "").trim();
  if (!/^\d{16,22}$/.test(id)) {
    throw new Error("Missing moderation whitelist user id");
  }

  const db = await getDatabase();
  const existing = getRows(
    db,
    `
      SELECT user_id, created_at, created_by
      FROM moderation_whitelist
      WHERE user_id = ?
      LIMIT 1
    `,
    [id]
  )[0];

  if (existing) {
    return {
      added: false,
      user: mapModerationWhitelistRow(existing)
    };
  }

  const row = {
    userId: id,
    createdAt: Date.now(),
    createdBy: createdBy ? String(createdBy) : null
  };

  db.run(
    `
      INSERT INTO moderation_whitelist (
        user_id,
        created_at,
        created_by
      ) VALUES (?, ?, ?)
    `,
    [
      row.userId,
      row.createdAt,
      row.createdBy
    ]
  );
  schedulePersist(db, { immediate: true });

  return {
    added: true,
    user: row
  };
}

async function removeModerationWhitelistedUser(userId) {
  const id = String(userId || "").trim();
  if (!id) {
    throw new Error("Missing moderation whitelist user id");
  }

  const db = await getDatabase();
  const existing = getRows(
    db,
    `
      SELECT user_id, created_at, created_by
      FROM moderation_whitelist
      WHERE user_id = ?
      LIMIT 1
    `,
    [id]
  )[0];

  if (!existing) {
    return {
      removed: false,
      user: null
    };
  }

  db.run("DELETE FROM moderation_whitelist WHERE user_id = ?", [id]);
  schedulePersist(db, { immediate: true });

  return {
    removed: true,
    user: mapModerationWhitelistRow(existing)
  };
}

async function listNicknamePatterns() {
  const db = await getDatabase();
  return getRows(
    db,
    `
      SELECT id, pattern, flags, rename_to, created_at
      FROM nickname_patterns
      ORDER BY created_at ASC, id ASC
    `
  ).map(mapNicknamePatternRow);
}

async function addNicknamePattern({ pattern, flags = "i", renameTo }) {
  const normalizedPattern = String(pattern || "").trim();
  const normalizedFlags = String(flags || "i").trim() || "i";
  const normalizedRenameTo = String(renameTo || "").replace(/\s+/g, " ").trim();
  if (!normalizedPattern || !normalizedRenameTo) {
    throw new Error("Missing nickname pattern or rename target");
  }

  const db = await getDatabase();
  const existing = getRows(
    db,
    `
      SELECT id, pattern, flags, rename_to, created_at
      FROM nickname_patterns
      WHERE pattern = ? AND flags = ?
      LIMIT 1
    `,
    [normalizedPattern, normalizedFlags]
  )[0];

  if (existing) {
    return {
      added: false,
      pattern: mapNicknamePatternRow(existing)
    };
  }

  const now = Date.now();
  db.run(
    `
      INSERT INTO nickname_patterns (
        pattern,
        flags,
        rename_to,
        created_at
      ) VALUES (?, ?, ?, ?)
    `,
    [
      normalizedPattern,
      normalizedFlags,
      normalizedRenameTo,
      now
    ]
  );
  schedulePersist(db, { immediate: true });
  const inserted = getRows(
    db,
    `
      SELECT id, pattern, flags, rename_to, created_at
      FROM nickname_patterns
      WHERE pattern = ? AND flags = ?
      LIMIT 1
    `,
    [normalizedPattern, normalizedFlags]
  )[0];

  return {
    added: true,
    pattern: mapNicknamePatternRow(inserted)
  };
}

async function removeNicknamePatternById(id) {
  const normalizedId = Math.max(0, Math.round(Number(id) || 0));
  if (!normalizedId) {
    throw new Error("Missing nickname pattern id");
  }

  const db = await getDatabase();
  const existing = getRows(
    db,
    `
      SELECT id, pattern, flags, rename_to, created_at
      FROM nickname_patterns
      WHERE id = ?
      LIMIT 1
    `,
    [normalizedId]
  )[0];

  if (!existing) {
    return {
      removed: false,
      pattern: null
    };
  }

  db.run("DELETE FROM nickname_patterns WHERE id = ?", [normalizedId]);
  schedulePersist(db, { immediate: true });

  return {
    removed: true,
    pattern: mapNicknamePatternRow(existing)
  };
}

function trimAuditText(value, max = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function normalizeAuditVerdict(result) {
  if (!result || typeof result.verdict === "undefined") return null;
  if (result.verdict === true) return "true";
  if (result.verdict === false) return "false";
  if (result.verdict === null) return "borderline";
  return null;
}

function normalizeAuditAnswer(result) {
  if (!result) return null;
  if (result.answer) return trimAuditText(result.answer, 80);
  if (result.verdict === true) return "TRUE";
  if (result.verdict === false) return "FALSE";
  if (result.verdict === null) return "BORDERLINE";
  return null;
}

function normalizeAuditNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildModerationActionId() {
  return crypto.randomBytes(9).toString("base64url");
}

async function recordModerationAction(record = {}) {
  const db = await getDatabase();
  const now = Math.max(1, Math.round(Number(record.createdAt) || Date.now()));
  const expiresAt = Math.max(now + 60_000, Math.round(Number(record.expiresAt) || (now + (12 * 60 * 60 * 1000))));
  const id = String(record.id || buildModerationActionId());
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.slice(0, 12).map((reason) => trimAuditText(reason, 260)).filter(Boolean)
    : [];
  const recentMessages = Array.isArray(record.recentMessages)
    ? record.recentMessages.slice(-8).map((entry) => ({
        at: Math.max(0, Math.round(Number(entry?.at) || 0)),
        messageId: entry?.messageId ? String(entry.messageId) : null,
        channelId: entry?.channelId ? String(entry.channelId) : null,
        guildId: entry?.guildId ? String(entry.guildId) : null,
        url: entry?.url ? trimAuditText(entry.url, 300) : null,
        content: trimAuditText(entry?.content, 360),
        repliedToMessage: entry?.repliedToMessage
          ? {
              authorLabel: trimAuditText(entry.repliedToMessage.authorLabel, 120) || "other user",
              authorId: entry.repliedToMessage.authorId ? String(entry.repliedToMessage.authorId) : null,
              content: trimAuditText(entry.repliedToMessage.content, 260)
            }
          : null
      })).filter((entry) => entry.content)
    : [];

  db.run(
    `
      INSERT OR REPLACE INTO moderation_actions (
        id,
        created_at,
        expires_at,
        guild_id,
        channel_id,
        message_id,
        message_url,
        user_id,
        username,
        action_type,
        action_label,
        timeout_ms,
        timeout_applied,
        delete_applied,
        dm_sent,
        message_content,
        recent_messages_json,
        reasons_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      now,
      expiresAt,
      record.guildId ? String(record.guildId) : null,
      record.channelId ? String(record.channelId) : null,
      record.messageId ? String(record.messageId) : null,
      record.messageUrl ? trimAuditText(record.messageUrl, 300) : null,
      record.userId ? String(record.userId) : null,
      record.username ? trimAuditText(record.username, 120) : null,
      trimAuditText(record.actionType || "moderation", 80) || "moderation",
      trimAuditText(record.actionLabel || "Moderation Action", 120) || "Moderation Action",
      Math.max(0, Math.round(Number(record.timeoutMs) || 0)),
      record.timeoutApplied ? 1 : 0,
      record.deleteApplied ? 1 : 0,
      record.dmSent ? 1 : 0,
      trimAuditText(record.messageContent, 900) || null,
      JSON.stringify(recentMessages),
      JSON.stringify(reasons)
    ]
  );
  schedulePersist(db);
  return id;
}

async function getModerationAction(actionId, { now = Date.now(), cleanupExpired = true } = {}) {
  const id = String(actionId || "").trim();
  if (!id) return null;
  const db = await getDatabase();
  const row = getRows(
    db,
    "SELECT * FROM moderation_actions WHERE id = ? LIMIT 1",
    [id]
  )[0];
  if (!row) return null;

  const action = mapModerationActionRow(row);
  if (cleanupExpired && action.expiresAt <= now) {
    db.run("DELETE FROM moderation_actions WHERE id = ?", [id]);
    schedulePersist(db);
    return null;
  }

  return action;
}

async function deleteModerationAction(actionId) {
  const id = String(actionId || "").trim();
  if (!id) return false;
  const db = await getDatabase();
  db.run("DELETE FROM moderation_actions WHERE id = ?", [id]);
  schedulePersist(db);
  return true;
}

async function cleanupExpiredModerationActions({ now = Date.now() } = {}) {
  const db = await getDatabase();
  db.run("DELETE FROM moderation_actions WHERE expires_at <= ?", [
    Math.max(1, Math.round(Number(now) || Date.now()))
  ]);
  schedulePersist(db);
  return true;
}

function normalizeOutageSamplesForPersistence(samples) {
  if (!Array.isArray(samples)) return [];
  return samples
    .slice(0, 32)
    .map((entry) => ({
      at: Math.max(0, Math.round(Number(entry?.at) || 0)),
      userId: entry?.userId ? String(entry.userId) : null,
      userTag: entry?.userTag ? String(entry.userTag) : null,
      channelId: entry?.channelId ? String(entry.channelId) : null,
      messageId: entry?.messageId ? String(entry.messageId) : null,
      url: entry?.url ? String(entry.url).slice(0, 400) : null,
      content: entry?.content ? String(entry.content).slice(0, 500) : "",
      normalized: entry?.normalized ? String(entry.normalized).slice(0, 500) : "",
      confidence:
        entry?.confidence === undefined || entry?.confidence === null
          ? null
          : Number(entry.confidence)
    }));
}

function normalizeOutageLockResultForPersistence(lockResult) {
  if (!lockResult) return null;
  const changed = Array.isArray(lockResult?.result?.changed)
    ? lockResult.result.changed
        .slice(0, 32)
        .map((entry) => ({
          channelId: entry?.channel?.id ? String(entry.channel.id) : null
        }))
    : [];
  const skipped = Array.isArray(lockResult?.result?.skipped)
    ? lockResult.result.skipped
        .slice(0, 32)
        .map((entry) => ({
          channelId: entry?.channel?.id ? String(entry.channel.id) : null
        }))
    : [];
  return {
    ok: Boolean(lockResult.ok),
    error: lockResult.error ? String(lockResult.error).slice(0, 300) : null,
    result: { changed, skipped }
  };
}

function mapOutageReviewRow(row) {
  let samples = [];
  let lockResult = null;
  try {
    const parsedSamples = JSON.parse(row.samples_json || "[]");
    if (Array.isArray(parsedSamples)) samples = parsedSamples;
  } catch {}
  try {
    const parsedLock = JSON.parse(row.lock_result_json || "null");
    if (parsedLock && typeof parsedLock === "object") lockResult = parsedLock;
  } catch {}

  return {
    reviewId: String(row.review_id || ""),
    guildId: row.guild_id ? String(row.guild_id) : null,
    createdAt: Number(row.created_at || 0),
    expiresAt: Number(row.expires_at || 0),
    status: String(row.status || "pending"),
    distinctUsers: Number(row.distinct_users || 0),
    samples,
    lockResult,
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
    resolvedBy:
      row.resolved_by_id || row.resolved_by_label
        ? {
            id: row.resolved_by_id ? String(row.resolved_by_id) : null,
            label: row.resolved_by_label ? String(row.resolved_by_label) : null
          }
        : null,
    resolution: row.resolution ? String(row.resolution) : null
  };
}

async function recordOutageReview(record = {}) {
  const reviewId = String(record.reviewId || "").trim();
  if (!reviewId) throw new Error("Missing outage review id");
  const db = await getDatabase();
  const createdAt = Math.max(1, Math.round(Number(record.createdAt) || Date.now()));
  const expiresAt = Math.max(createdAt + 60_000, Math.round(Number(record.expiresAt) || createdAt + (24 * 60 * 60 * 1000)));

  db.run(
    `INSERT OR REPLACE INTO outage_reviews
      (review_id, guild_id, created_at, expires_at, status, distinct_users, samples_json, lock_result_json,
       resolved_at, resolved_by_id, resolved_by_label, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reviewId,
      record.guildId ? String(record.guildId) : null,
      createdAt,
      expiresAt,
      String(record.status || "pending"),
      Math.max(0, Math.round(Number(record.distinctUsers) || 0)),
      JSON.stringify(normalizeOutageSamplesForPersistence(record.samples)),
      JSON.stringify(normalizeOutageLockResultForPersistence(record.lockResult)),
      record.resolvedAt ? Math.round(Number(record.resolvedAt)) : null,
      record.resolvedBy?.id ? String(record.resolvedBy.id) : null,
      record.resolvedBy?.label ? String(record.resolvedBy.label) : null,
      record.resolution ? String(record.resolution) : null
    ]
  );
  schedulePersist(db, { immediate: true });
  return reviewId;
}

async function updateOutageReviewStatus({
  reviewId,
  status,
  resolvedAt = Date.now(),
  resolvedBy = null,
  resolution = null
} = {}) {
  const id = String(reviewId || "").trim();
  if (!id) return false;
  const db = await getDatabase();
  db.run(
    `UPDATE outage_reviews
       SET status = ?, resolved_at = ?, resolved_by_id = ?, resolved_by_label = ?, resolution = ?
     WHERE review_id = ?`,
    [
      String(status || "pending"),
      Math.round(Number(resolvedAt) || Date.now()),
      resolvedBy?.id ? String(resolvedBy.id) : null,
      resolvedBy?.label ? String(resolvedBy.label) : null,
      resolution ? String(resolution) : null,
      id
    ]
  );
  schedulePersist(db, { immediate: true });
  return true;
}

async function listPendingOutageReviews({ now = Date.now() } = {}) {
  const db = await getDatabase();
  const cutoff = Math.max(1, Math.round(Number(now) || Date.now()));
  const rows = getRows(
    db,
    `SELECT * FROM outage_reviews WHERE status = 'pending' AND expires_at > ? ORDER BY created_at ASC`,
    [cutoff]
  );
  return rows.map(mapOutageReviewRow);
}

async function deleteOutageReview(reviewId) {
  const id = String(reviewId || "").trim();
  if (!id) return false;
  const db = await getDatabase();
  db.run("DELETE FROM outage_reviews WHERE review_id = ?", [id]);
  schedulePersist(db);
  return true;
}

async function deleteOutageReviewsForGuild(guildId) {
  const id = String(guildId || "").trim();
  if (!id) return false;
  const db = await getDatabase();
  db.run("DELETE FROM outage_reviews WHERE guild_id = ? AND status = 'pending'", [id]);
  schedulePersist(db);
  return true;
}

async function cleanupExpiredOutageReviews({ now = Date.now() } = {}) {
  const db = await getDatabase();
  db.run("DELETE FROM outage_reviews WHERE expires_at <= ?", [
    Math.max(1, Math.round(Number(now) || Date.now()))
  ]);
  schedulePersist(db);
  return true;
}

const RUNTIME_STATUS_CURRENT_KEY = "runtime_status_current";
const RUNTIME_STATUS_SINCE_AT_KEY = "runtime_status_since_at";

function mapStatusTransitionRow(row) {
  return {
    id: Number(row.id || 0),
    occurredAt: Number(row.occurred_at || 0),
    fromStatus: row.from_status ? String(row.from_status) : null,
    toStatus: String(row.to_status || ""),
    actorId: row.actor_id ? String(row.actor_id) : null,
    actorLabel: row.actor_label ? String(row.actor_label) : null,
    reason: row.reason ? String(row.reason) : null
  };
}

async function recordStatusTransition({
  occurredAt = Date.now(),
  fromStatus = null,
  toStatus,
  actor = null,
  reason = null
} = {}) {
  if (!toStatus) throw new Error("toStatus is required");
  const db = await getDatabase();
  const at = Math.max(1, Math.round(Number(occurredAt) || Date.now()));
  db.run(
    `INSERT INTO status_transitions (occurred_at, from_status, to_status, actor_id, actor_label, reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      at,
      fromStatus ? String(fromStatus) : null,
      String(toStatus),
      actor?.id ? String(actor.id) : null,
      actor?.label ? String(actor.label).slice(0, 120) : null,
      reason ? String(reason).slice(0, 240) : null
    ]
  );
  setAppConfigValue(db, RUNTIME_STATUS_CURRENT_KEY, String(toStatus));
  setAppConfigValue(db, RUNTIME_STATUS_SINCE_AT_KEY, String(at), { immediate: true });
  return true;
}

async function getPersistedRuntimeStatus() {
  const db = await getDatabase();
  const current = getAppConfigValue(db, RUNTIME_STATUS_CURRENT_KEY);
  const sinceAt = Number(getAppConfigValue(db, RUNTIME_STATUS_SINCE_AT_KEY) || 0);
  return {
    status: current ? String(current) : null,
    sinceAt: Number.isFinite(sinceAt) && sinceAt > 0 ? sinceAt : null
  };
}

async function listStatusTransitionsSince({ sinceAt, limit = 500 } = {}) {
  const db = await getDatabase();
  const cutoff = Math.max(0, Math.round(Number(sinceAt) || 0));
  const cap = Math.max(1, Math.min(5000, Math.round(Number(limit) || 500)));
  const rows = getRows(
    db,
    `SELECT * FROM status_transitions WHERE occurred_at >= ? ORDER BY occurred_at ASC, id ASC LIMIT ?`,
    [cutoff, cap]
  );
  return rows.map(mapStatusTransitionRow);
}

async function getMostRecentStatusTransition({ toStatus = null } = {}) {
  const db = await getDatabase();
  const rows = toStatus
    ? getRows(
        db,
        `SELECT * FROM status_transitions WHERE to_status = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [String(toStatus)]
      )
    : getRows(
        db,
        `SELECT * FROM status_transitions ORDER BY occurred_at DESC, id DESC LIMIT 1`
      );
  return rows.length ? mapStatusTransitionRow(rows[0]) : null;
}

async function clearStatusHistoryForTests() {
  const db = await getDatabase();
  db.exec("DELETE FROM status_transitions;");
  deleteAppConfigValue(db, RUNTIME_STATUS_CURRENT_KEY);
  deleteAppConfigValue(db, RUNTIME_STATUS_SINCE_AT_KEY, { immediate: true });
  return true;
}

async function recordDailyTrackedMessage({
  userId,
  username,
  displayName,
  channelId,
  channelName,
  at = Date.now(),
  localHour = 0,
  trackStaffOnly = false
}) {
  if (!userId || !channelId) {
    throw new Error("Missing daily tracking identifiers");
  }

  const db = await getDatabase();
  const messageAt = Math.max(1, Math.round(Number(at) || Date.now()));
  const safeHour = Math.max(0, Math.min(23, Math.round(Number(localHour) || 0)));

  db.run(
    `
      INSERT INTO daily_user_message_stats (
        user_id,
        username,
        display_name,
        message_count,
        last_message_at,
        last_channel_id,
        last_channel_name
      ) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        message_count = daily_user_message_stats.message_count + 1,
        last_message_at = excluded.last_message_at,
        last_channel_id = excluded.last_channel_id,
        last_channel_name = excluded.last_channel_name
    `,
    [
      String(userId),
      username ? String(username) : null,
      displayName ? String(displayName) : null,
      messageAt,
      String(channelId),
      channelName ? String(channelName) : null
    ]
  );

  db.run(
    `
      INSERT INTO daily_channel_message_stats (
        channel_id,
        channel_name,
        message_count,
        last_message_at
      ) VALUES (?, ?, 1, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        channel_name = excluded.channel_name,
        message_count = daily_channel_message_stats.message_count + 1,
        last_message_at = excluded.last_message_at
    `,
    [
      String(channelId),
      channelName ? String(channelName) : null,
      messageAt
    ]
  );

  db.run(
    `
      INSERT INTO daily_hour_message_stats (
        local_hour,
        message_count
      ) VALUES (?, 1)
      ON CONFLICT(local_hour) DO UPDATE SET
        message_count = daily_hour_message_stats.message_count + 1
    `,
    [safeHour]
  );

  if (trackStaffOnly) {
    db.run(
      `
        INSERT INTO daily_staff_message_stats (
          user_id,
          username,
          display_name,
          message_count,
          last_message_at,
          last_channel_id,
          last_channel_name
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          display_name = excluded.display_name,
          message_count = daily_staff_message_stats.message_count + 1,
          last_message_at = excluded.last_message_at,
          last_channel_id = excluded.last_channel_id,
          last_channel_name = excluded.last_channel_name
      `,
      [
        String(userId),
        username ? String(username) : null,
        displayName ? String(displayName) : null,
        messageAt,
        String(channelId),
        channelName ? String(channelName) : null
      ]
    );
  }

  schedulePersist(db);
  return true;
}

async function recordDailyModerationEvent(eventKey, {
  amount = 1,
  at = Date.now()
} = {}) {
  const key = String(eventKey || "").trim();
  if (!key) {
    throw new Error("Missing moderation event key");
  }

  const db = await getDatabase();
  const safeAmount = Math.max(1, Math.round(Number(amount) || 1));
  const eventAt = Math.max(1, Math.round(Number(at) || Date.now()));

  db.run(
    `
      INSERT INTO daily_moderation_stats (
        event_key,
        event_count,
        last_event_at
      ) VALUES (?, ?, ?)
      ON CONFLICT(event_key) DO UPDATE SET
        event_count = daily_moderation_stats.event_count + excluded.event_count,
        last_event_at = MAX(daily_moderation_stats.last_event_at, excluded.last_event_at)
    `,
    [
      key,
      safeAmount,
      eventAt
    ]
  );

  schedulePersist(db);
  return true;
}

async function getDailyStatsSnapshot() {
  const db = await getDatabase();
  const windowStartedAt = await getDailyStatsWindowStartedAt();
  const users = getRows(
    db,
    `
      SELECT user_id, username, display_name, message_count, last_message_at, last_channel_id, last_channel_name
      FROM daily_user_message_stats
      ORDER BY message_count DESC, last_message_at DESC, display_name ASC, username ASC
    `
  ).map(mapDailyUserRow);
  const channels = getRows(
    db,
    `
      SELECT channel_id, channel_name, message_count, last_message_at
      FROM daily_channel_message_stats
      ORDER BY message_count DESC, last_message_at DESC, channel_name ASC
    `
  ).map(mapDailyChannelRow);
  const hours = getRows(
    db,
    `
      SELECT local_hour, message_count
      FROM daily_hour_message_stats
      ORDER BY message_count DESC, local_hour ASC
    `
  ).map(mapDailyHourRow);
  const staff = getRows(
    db,
    `
      SELECT user_id, username, display_name, message_count, last_message_at, last_channel_id, last_channel_name
      FROM daily_staff_message_stats
      ORDER BY message_count DESC, last_message_at DESC, display_name ASC, username ASC
    `
  ).map(mapDailyStaffRow);
  const moderation = getRows(
    db,
    `
      SELECT event_key, event_count, last_event_at
      FROM daily_moderation_stats
      ORDER BY event_count DESC, last_event_at DESC, event_key ASC
    `
  ).map(mapDailyModerationRow);

  return {
    windowStartedAt,
    users,
    channels,
    hours,
    staff,
    moderation
  };
}

async function clearDailyStatsTracking(newWindowStartedAt = Date.now()) {
  const db = await getDatabase();
  db.exec(`
    DELETE FROM daily_user_message_stats;
    DELETE FROM daily_channel_message_stats;
    DELETE FROM daily_hour_message_stats;
    DELETE FROM daily_staff_message_stats;
    DELETE FROM daily_moderation_stats;
  `);
  setAppConfigValue(db, DAILY_STATS_WINDOW_KEY, Math.max(1, Math.round(Number(newWindowStartedAt) || Date.now())), {
    immediate: true
  });
  return true;
}

async function getRestrictedEmojiDatabaseSnapshot() {
  const db = await getDatabase();
  const emojis = await listRestrictedEmojis();
  const trustedLinks = await listTrustedLinks();
  const moderationWhitelist = await listModerationWhitelistedUsers();
  const nicknamePatterns = await listNicknamePatterns();
  const emojiTimeoutMs = await getEmojiTimeoutMs();
  const dailyStats = await getDailyStatsSnapshot();
  const channelSettings = await listChannelSettings();

  return {
    path: databasePath,
    emojiTimeoutMs,
    emojis,
    trustedLinks,
    moderationWhitelist,
    nicknamePatterns,
    channelSettings,
    dailyStats,
    tableCounts: {
      appConfig: Number(getScalarValue(db, "SELECT COUNT(*) FROM app_config") || 0),
      restrictedEmojis: Number(getScalarValue(db, "SELECT COUNT(*) FROM restricted_emojis") || 0),
      trustedLinks: Number(getScalarValue(db, "SELECT COUNT(*) FROM trusted_links") || 0),
      moderationWhitelist: Number(getScalarValue(db, "SELECT COUNT(*) FROM moderation_whitelist") || 0),
      nicknamePatterns: Number(getScalarValue(db, "SELECT COUNT(*) FROM nickname_patterns") || 0),
      dailyUsers: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_user_message_stats") || 0),
      dailyChannels: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_channel_message_stats") || 0),
      dailyHours: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_hour_message_stats") || 0),
      dailyStaff: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_staff_message_stats") || 0),
      dailyModeration: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_moderation_stats") || 0),
      restrictedEmojiUsage: Number(getScalarValue(db, "SELECT COUNT(*) FROM restricted_emoji_usage") || 0),
      moderationActions: Number(getScalarValue(db, "SELECT COUNT(*) FROM moderation_actions") || 0)
    }
  };
}

async function resetRestrictedEmojiDatabaseForTests(filePath = DEFAULT_DATABASE_PATH) {
  clearPersistTimer();
  databaseDirty = false;

  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    closeDatabase(db);
  }

  dbPromise = null;
  currentDb = null;
  databasePath = filePath;
  resetChannelConfigCache();

  try {
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}.tmp`, { force: true });
  } catch {}
}

module.exports = {
  DEFAULT_DATABASE_PATH,
  DAILY_STATS_WINDOW_KEY,
  buildStoredEmojiKey,
  parseEmojiInput,
  getReactionEmojiRecord,
  matchesStoredEmoji,
  getEmojiTimeoutMs,
  setEmojiTimeoutMs,
  getBotPresenceState,
  setBotPresenceState,
  resetBotPresenceState,
  getPolicyEnforcementEnabled,
  setPolicyEnforcementEnabled,
  hydrateChannelSettings,
  listChannelSettings,
  setChannelSetting,
  resetChannelSetting,
  getDailyStatsWindowStartedAt,
  ensureDailyStatsWindowStartedAt,
  setDailyStatsWindowStartedAt,
  listRestrictedEmojis,
  addRestrictedEmoji,
  removeRestrictedEmojiByKey,
  recordRestrictedEmojiUsage,
  listRestrictedEmojiTopOffenders,
  listRestrictedEmojiTopUsage,
  getRestrictedEmojiCountSince,
  bumpEmojiSpamState,
  cleanupExpiredEmojiSpamState,
  listTrustedLinks,
  addTrustedLink,
  removeTrustedLinkByKey,
  listModerationWhitelistedUsers,
  isModerationWhitelistedUser,
  addModerationWhitelistedUser,
  removeModerationWhitelistedUser,
  listNicknamePatterns,
  addNicknamePattern,
  removeNicknamePatternById,
  cleanupExpiredModerationActions,
  deleteModerationAction,
  getModerationAction,
  recordModerationAction,
  recordOutageReview,
  updateOutageReviewStatus,
  listPendingOutageReviews,
  deleteOutageReview,
  deleteOutageReviewsForGuild,
  cleanupExpiredOutageReviews,
  recordStatusTransition,
  getPersistedRuntimeStatus,
  listStatusTransitionsSince,
  getMostRecentStatusTransition,
  clearStatusHistoryForTests,
  recordDailyTrackedMessage,
  recordDailyModerationEvent,
  getDailyStatsSnapshot,
  clearDailyStatsTracking,
  cleanupRestrictedEmojiDatabaseTempFiles,
  getRestrictedEmojiDatabaseSnapshot,
  flushRestrictedEmojiDatabaseNow,
  resetRestrictedEmojiDatabaseForTests
};
