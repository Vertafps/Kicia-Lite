"use strict";

/**
 * Custom timeout patterns — owner-defined phrases that trigger auto-timeout
 * when a future message is semantically similar enough.
 *
 * Pipeline:
 *   1. owner runs `$pattern add 1h v2 is better than v3` — phrase is normalized
 *      via buildNormalizedTextForms().folded (defuses leet + confusables),
 *      embedded to a 384-dim unit vector via MiniLM, persisted as JSON in
 *      `custom_timeout_patterns`, and cached in-memory.
 *   2. every message routes through matchMessage(text) — text is normalized
 *      the same way, embedded once, then cosine-compared against every cached
 *      pattern vector. best score above its pattern's threshold wins.
 *   3. moderation handler fires the timeout + deletes the message; no DM is
 *      ever sent. staff log captures the match.
 *
 * Vector storage is JSON.stringify(Array.from(Float32Array)) — ~6KB per
 * pattern. fine for under ~500 patterns. if it grows past that, migrate to
 * a sibling table with BLOB column.
 */

const { embedText, cosineSim } = require("./embeddings");
const { buildNormalizedTextForms } = require("./text");
const { recordRuntimeEvent } = require("./runtime-health");

// in-memory cache: id -> { phrase, vector, timeoutMs, threshold, createdAt,
// createdBy, normalizedPhrase }
const cache = new Map();
let hydrated = false;

const DEFAULT_THRESHOLD = 0.80;
const MIN_THRESHOLD = 0.5;
const MAX_THRESHOLD = 0.99;
const MIN_TIMEOUT_MS = 60_000;                  // 1m floor
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // discord cap (~28d)
const MAX_PHRASE_LEN = 512;

function clampThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD;
  return Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, n));
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return MIN_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(n)));
}

function normalizePhrase(phrase) {
  const forms = buildNormalizedTextForms(String(phrase || ""));
  // .folded keeps the words intact (no aggressive char-stripping) but defuses
  // confusables/invisibles. for embeddings this is the right level — MiniLM
  // does its own subword tokenization, so we don't want normalized's space-
  // separated bag-of-words shape.
  return String(forms.folded || "").trim();
}

function lazyGetDb() {
  // lazy require to avoid circular dep — restricted-emoji-db imports settings,
  // which may transitively pull this module.
  const mod = require("./restricted-emoji-db");
  if (!mod || typeof mod.getDatabase !== "function") return null;
  return mod;
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

function vectorToJson(vec) {
  return JSON.stringify(Array.from(vec));
}

function vectorFromJson(json) {
  if (!json) return null;
  try {
    const arr = JSON.parse(String(json));
    if (!Array.isArray(arr) || !arr.length) return null;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = Number(arr[i]) || 0;
    return out;
  } catch {
    return null;
  }
}

function mapRowToCacheEntry(row) {
  return {
    id: Number(row.id || 0),
    phrase: String(row.phrase || ""),
    normalizedPhrase: String(row.normalized_phrase || ""),
    timeoutMs: clampTimeout(Number(row.timeout_ms || 0)),
    threshold: clampThreshold(Number(row.threshold || DEFAULT_THRESHOLD)),
    vector: vectorFromJson(row.vector_json),
    createdAt: Number(row.created_at || 0),
    createdBy: row.created_by ? String(row.created_by) : null
  };
}

function cacheEntryToPublic(entry) {
  if (!entry) return null;
  return {
    id: entry.id,
    phrase: entry.phrase,
    timeoutMs: entry.timeoutMs,
    threshold: entry.threshold,
    createdAt: entry.createdAt,
    createdBy: entry.createdBy
  };
}

async function hydrateCustomPatterns() {
  if (hydrated) return cache.size;
  const dbModule = lazyGetDb();
  if (!dbModule) {
    // tests / cold env — mark hydrated so subsequent calls don't re-attempt
    hydrated = true;
    return 0;
  }

  let db;
  try {
    db = await dbModule.getDatabase();
  } catch (err) {
    recordRuntimeEvent("warn", "custom-patterns-hydrate-db", err?.message || err);
    hydrated = true;
    return 0;
  }

  let rows;
  try {
    rows = getRows(
      db,
      "SELECT id, phrase, normalized_phrase, timeout_ms, threshold, vector_json, created_by, created_at FROM custom_timeout_patterns ORDER BY id ASC"
    );
  } catch (err) {
    // table doesn't exist yet — schema migration hasn't fired. fine.
    recordRuntimeEvent("warn", "custom-patterns-hydrate-rows", err?.message || err);
    hydrated = true;
    return 0;
  }

  cache.clear();
  for (const row of rows) {
    const entry = mapRowToCacheEntry(row);
    if (!entry.vector) {
      // missing vector — re-embed and persist
      try {
        const vec = await embedText(entry.normalizedPhrase || entry.phrase);
        entry.vector = vec;
        db.run(
          "UPDATE custom_timeout_patterns SET vector_json = ? WHERE id = ?",
          [vectorToJson(vec), entry.id]
        );
        dbModule.schedulePersist?.(db);
      } catch (err) {
        recordRuntimeEvent("warn", "custom-patterns-hydrate-embed", err?.message || err);
        // skip — without a vector this entry can't be matched
        continue;
      }
    }
    cache.set(entry.id, entry);
  }

  hydrated = true;
  return cache.size;
}

async function ensureHydrated() {
  if (!hydrated) await hydrateCustomPatterns();
}

async function addPattern({ phrase, timeoutMs, threshold = DEFAULT_THRESHOLD, createdBy = null } = {}) {
  const phraseStr = String(phrase || "").trim();
  if (!phraseStr) throw new Error("phrase required");
  if (phraseStr.length > MAX_PHRASE_LEN) throw new Error(`phrase too long (max ${MAX_PHRASE_LEN})`);

  const normalized = normalizePhrase(phraseStr);
  if (!normalized) throw new Error("phrase normalized to empty");

  const finalTimeout = clampTimeout(timeoutMs);
  const finalThreshold = clampThreshold(threshold);

  // embed first — fail fast if MiniLM is dead.
  const vec = await embedText(normalized);
  if (!vec || !vec.length) throw new Error("embedder returned empty vector");

  const dbModule = lazyGetDb();
  if (!dbModule) throw new Error("database unavailable");
  const db = await dbModule.getDatabase();

  await ensureHydrated();

  const createdAt = Date.now();
  db.run(
    `INSERT INTO custom_timeout_patterns
       (phrase, normalized_phrase, timeout_ms, threshold, vector_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      phraseStr.slice(0, MAX_PHRASE_LEN),
      normalized.slice(0, MAX_PHRASE_LEN),
      finalTimeout,
      finalThreshold,
      vectorToJson(vec),
      createdBy ? String(createdBy) : null,
      createdAt
    ]
  );

  const id = Number(getScalarValue(db, "SELECT last_insert_rowid()") || 0);
  if (!id) throw new Error("insert did not return an id");

  cache.set(id, {
    id,
    phrase: phraseStr,
    normalizedPhrase: normalized,
    timeoutMs: finalTimeout,
    threshold: finalThreshold,
    vector: vec,
    createdAt,
    createdBy: createdBy ? String(createdBy) : null
  });

  dbModule.schedulePersist?.(db, { immediate: true });
  return id;
}

async function removePattern(id) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId) || numericId <= 0) return false;

  const dbModule = lazyGetDb();
  if (!dbModule) return false;
  const db = await dbModule.getDatabase();

  await ensureHydrated();

  const had = cache.has(numericId);
  db.run("DELETE FROM custom_timeout_patterns WHERE id = ?", [numericId]);
  cache.delete(numericId);
  dbModule.schedulePersist?.(db, { immediate: true });
  return had;
}

async function setThreshold(id, value) {
  const numericId = Number(id);
  if (!Number.isFinite(numericId) || numericId <= 0) return false;

  const finalThreshold = clampThreshold(value);

  const dbModule = lazyGetDb();
  if (!dbModule) return false;
  const db = await dbModule.getDatabase();

  await ensureHydrated();

  const entry = cache.get(numericId);
  if (!entry) return false;

  db.run(
    "UPDATE custom_timeout_patterns SET threshold = ? WHERE id = ?",
    [finalThreshold, numericId]
  );
  entry.threshold = finalThreshold;
  dbModule.schedulePersist?.(db, { immediate: true });
  return true;
}

async function listPatterns() {
  await ensureHydrated();
  const list = [...cache.values()]
    .map(cacheEntryToPublic)
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
  return list;
}

async function matchMessage(text, { minThreshold = null } = {}) {
  const raw = String(text || "");
  if (!raw.trim()) return { matched: false, bestScore: 0 };

  await ensureHydrated();
  if (!cache.size) return { matched: false, bestScore: 0 };

  const normalized = normalizePhrase(raw);
  if (!normalized) return { matched: false, bestScore: 0 };

  let vec;
  try {
    vec = await embedText(normalized);
  } catch (err) {
    recordRuntimeEvent("warn", "custom-patterns-embed", err?.message || err);
    return { matched: false, bestScore: 0 };
  }
  if (!vec || !vec.length) return { matched: false, bestScore: 0 };

  let bestEntry = null;
  let bestScore = -1;
  for (const entry of cache.values()) {
    if (!entry.vector) continue;
    const score = cosineSim(vec, entry.vector);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  if (!bestEntry) return { matched: false, bestScore: 0 };

  const gate = minThreshold != null
    ? Math.max(MIN_THRESHOLD, Math.min(MAX_THRESHOLD, Number(minThreshold)))
    : bestEntry.threshold;

  if (bestScore >= gate && bestScore >= bestEntry.threshold) {
    return {
      matched: true,
      patternId: bestEntry.id,
      score: bestScore,
      pattern: cacheEntryToPublic(bestEntry),
      bestScore
    };
  }

  // for $pattern test: when caller provides a lower minThreshold than the
  // pattern's own, surface the best score even if it didn't fire.
  if (minThreshold != null && bestScore >= gate) {
    return {
      matched: false,
      bestScore,
      bestPatternId: bestEntry.id,
      bestPattern: cacheEntryToPublic(bestEntry)
    };
  }

  return { matched: false, bestScore };
}

function __resetForTests() {
  cache.clear();
  hydrated = false;
}

function __setHydratedForTests(value) {
  hydrated = Boolean(value);
}

function __seedCacheForTests(entry) {
  cache.set(entry.id, entry);
  hydrated = true;
}

module.exports = {
  DEFAULT_THRESHOLD,
  MIN_THRESHOLD,
  MAX_THRESHOLD,
  addPattern,
  removePattern,
  setThreshold,
  listPatterns,
  matchMessage,
  hydrateCustomPatterns,
  __resetForTests,
  __setHydratedForTests,
  __seedCacheForTests
};
