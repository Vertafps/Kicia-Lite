const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");
const { DEFAULT_EMOJI_TIMEOUT_MS } = require("./config");
const { clampDurationMs } = require("./duration");
const { recordRuntimeEvent } = require("./runtime-health");

const CUSTOM_EMOJI_RE = /^<(a?):([A-Za-z0-9_]+):(\d+)>$/;
const DEFAULT_DATABASE_PATH = path.join(__dirname, "..", "data", "restricted-reactions.sqlite");
const SQL_JS_DIST_DIR = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));

let sqlPromise = null;
let dbPromise = null;
let databasePath = DEFAULT_DATABASE_PATH;

function ensureDatabaseDirectory(filePath = databasePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function getLocateFilePath(file) {
  return path.join(SQL_JS_DIST_DIR, file);
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
  try {
    db?.close?.();
  } catch {}
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

function persistDatabase(db) {
  ensureDatabaseDirectory();
  const exportBuffer = Buffer.from(db.export());
  const tempPath = `${databasePath}.tmp`;
  fs.writeFileSync(tempPath, exportBuffer);
  fs.renameSync(tempPath, databasePath);
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

async function loadDatabase() {
  ensureDatabaseDirectory();
  const SQL = await getSql();

  try {
    const db = fs.existsSync(databasePath)
      ? new SQL.Database(fs.readFileSync(databasePath))
      : new SQL.Database();

    createSchema(db);
    ensureDefaultConfig(db);
    persistDatabase(db);
    return db;
  } catch (err) {
    recordRuntimeEvent("error", "emoji-db-load", err?.message || err);

    try {
      if (fs.existsSync(databasePath)) {
        fs.renameSync(databasePath, `${databasePath}.broken-${Date.now()}`);
      }
    } catch {}

    const db = new SQL.Database();
    createSchema(db);
    ensureDefaultConfig(db);
    persistDatabase(db);
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
    throw err;
  }
}

async function getEmojiTimeoutMs() {
  const db = await getDatabase();
  const stored = getScalarValue(db, "SELECT value FROM app_config WHERE key = ?", [
    "emoji_timeout_ms"
  ]);
  return clampDurationMs(Number(stored || DEFAULT_EMOJI_TIMEOUT_MS));
}

async function setEmojiTimeoutMs(durationMs) {
  const db = await getDatabase();
  const normalized = clampDurationMs(durationMs);

  db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)", [
    "emoji_timeout_ms",
    String(normalized)
  ]);
  persistDatabase(db);
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
  persistDatabase(db);

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
  persistDatabase(db);

  return {
    removed: true,
    emoji: mapEmojiRow(existing)
  };
}

async function getRestrictedEmojiDatabaseSnapshot() {
  const db = await getDatabase();
  const emojis = await listRestrictedEmojis();
  const emojiTimeoutMs = await getEmojiTimeoutMs();

  return {
    path: databasePath,
    emojiTimeoutMs,
    emojis,
    tableCounts: {
      appConfig: Number(getScalarValue(db, "SELECT COUNT(*) FROM app_config") || 0),
      restrictedEmojis: Number(getScalarValue(db, "SELECT COUNT(*) FROM restricted_emojis") || 0)
    }
  };
}

async function resetRestrictedEmojiDatabaseForTests(filePath = DEFAULT_DATABASE_PATH) {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    closeDatabase(db);
  }
  dbPromise = null;
  databasePath = filePath;
}

module.exports = {
  DEFAULT_DATABASE_PATH,
  buildStoredEmojiKey,
  parseEmojiInput,
  getReactionEmojiRecord,
  matchesStoredEmoji,
  getEmojiTimeoutMs,
  setEmojiTimeoutMs,
  listRestrictedEmojis,
  addRestrictedEmoji,
  removeRestrictedEmojiByKey,
  getRestrictedEmojiDatabaseSnapshot,
  resetRestrictedEmojiDatabaseForTests
};
