const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");
const { DEFAULT_EMOJI_TIMEOUT_MS } = require("./config");
const { clampDurationMs } = require("./duration");
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

function ensureDefaultConfig(db) {
  db.run("INSERT OR IGNORE INTO app_config (key, value) VALUES (?, ?)", [
    "emoji_timeout_ms",
    String(DEFAULT_EMOJI_TIMEOUT_MS)
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
  const emojiTimeoutMs = await getEmojiTimeoutMs();
  const dailyStats = await getDailyStatsSnapshot();

  return {
    path: databasePath,
    emojiTimeoutMs,
    emojis,
    trustedLinks,
    moderationWhitelist,
    dailyStats,
    tableCounts: {
      appConfig: Number(getScalarValue(db, "SELECT COUNT(*) FROM app_config") || 0),
      restrictedEmojis: Number(getScalarValue(db, "SELECT COUNT(*) FROM restricted_emojis") || 0),
      trustedLinks: Number(getScalarValue(db, "SELECT COUNT(*) FROM trusted_links") || 0),
      moderationWhitelist: Number(getScalarValue(db, "SELECT COUNT(*) FROM moderation_whitelist") || 0),
      dailyUsers: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_user_message_stats") || 0),
      dailyChannels: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_channel_message_stats") || 0),
      dailyHours: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_hour_message_stats") || 0),
      dailyStaff: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_staff_message_stats") || 0),
      dailyModeration: Number(getScalarValue(db, "SELECT COUNT(*) FROM daily_moderation_stats") || 0)
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
  getDailyStatsWindowStartedAt,
  ensureDailyStatsWindowStartedAt,
  setDailyStatsWindowStartedAt,
  listRestrictedEmojis,
  addRestrictedEmoji,
  removeRestrictedEmojiByKey,
  listTrustedLinks,
  addTrustedLink,
  removeTrustedLinkByKey,
  listModerationWhitelistedUsers,
  isModerationWhitelistedUser,
  addModerationWhitelistedUser,
  removeModerationWhitelistedUser,
  recordDailyTrackedMessage,
  recordDailyModerationEvent,
  getDailyStatsSnapshot,
  clearDailyStatsTracking,
  getRestrictedEmojiDatabaseSnapshot,
  flushRestrictedEmojiDatabaseNow,
  resetRestrictedEmojiDatabaseForTests
};
