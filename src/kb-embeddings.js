"use strict";

/**
 * Semantic KB index — reuses the MiniLM pipeline already loaded for scam
 * classification to give the KB matcher a free semantic-similarity signal.
 *
 * Strategy:
 *   - On startup (or when the KB JSON changes), embed every issue title +
 *     match phrases, every executor name + aliases. Cache to disk by hash.
 *   - At query time, embed the user message and cosine-similarity it against
 *     the index. The lexical scorer in `kb.js` blends this in.
 *
 * Cache layout mirrors `scam-embeddings-cache.json` for consistency.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  ENABLE_KB_EMBED_INDEX,
  KB_EMBED_MODEL_ID,
  KB_EMBED_CACHE_PATH
} = require("./config");
const { embedText, loadEmbedder } = require("./embeddings");
const { recordRuntimeEvent } = require("./runtime-health");

let _index = null;
let _indexHash = null;
let _buildPromise = null;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildIssueText(issue) {
  const phrases = Array.isArray(issue._matchPhrases) ? issue._matchPhrases.slice(0, 3) : [];
  return [issue.title, ...phrases].filter(Boolean).join(" — ").slice(0, 400);
}

function buildExecutorText(executor) {
  const aliases = Array.isArray(executor.aliases) ? executor.aliases.slice(0, 6) : [];
  return [executor.name, ...aliases].filter(Boolean).join(" ").slice(0, 200);
}

function computeKbHash(kb) {
  const issues = (kb.issues || []).map((i) => `i:${i.title}|${(i._matchPhrases || []).join(",")}`);
  const execs = [];
  for (const status of Object.keys(kb.executorsByStatus || {})) {
    for (const e of kb.executorsByStatus[status] || []) {
      execs.push(`e:${status}:${e.name}|${(e.aliases || []).join(",")}`);
    }
  }
  return sha256(KB_EMBED_MODEL_ID + "|" + issues.join("\n") + "|" + execs.join("\n"));
}

function resolveCachePath() {
  return path.isAbsolute(KB_EMBED_CACHE_PATH)
    ? KB_EMBED_CACHE_PATH
    : path.resolve(__dirname, "..", KB_EMBED_CACHE_PATH);
}

function loadFromDisk(expectedHash) {
  try {
    const raw = JSON.parse(fs.readFileSync(resolveCachePath(), "utf8"));
    if (raw.hash !== expectedHash || !Array.isArray(raw.entries)) return null;
    const entries = raw.entries.map((e) => ({
      kind: e.kind,
      key: e.key,
      text: e.text,
      vector: new Float32Array(e.vector)
    }));
    return { hash: expectedHash, entries };
  } catch {
    return null;
  }
}

function persistToDisk(index) {
  try {
    const cachePath = resolveCachePath();
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      hash: index.hash,
      modelId: KB_EMBED_MODEL_ID,
      entries: index.entries.map((e) => ({
        kind: e.kind,
        key: e.key,
        text: e.text,
        vector: Array.from(e.vector)
      }))
    }), "utf8");
  } catch (err) {
    recordRuntimeEvent("warn", "kb-embed-cache-write", err?.message || err);
  }
}

async function buildIndex(kb) {
  await loadEmbedder();
  const hash = computeKbHash(kb);
  const cached = loadFromDisk(hash);
  if (cached) return cached;

  const entries = [];
  for (const issue of kb.issues || []) {
    const text = buildIssueText(issue);
    if (!text) continue;
    try {
      const vector = await embedText(text);
      entries.push({ kind: "issue", key: issue.title, text, vector });
    } catch (err) {
      recordRuntimeEvent("warn", "kb-embed-issue", err?.message || err);
    }
  }
  for (const status of Object.keys(kb.executorsByStatus || {})) {
    for (const executor of kb.executorsByStatus[status] || []) {
      const text = buildExecutorText(executor);
      if (!text) continue;
      try {
        const vector = await embedText(text);
        entries.push({ kind: `executor:${status}`, key: executor.name, text, vector });
      } catch (err) {
        recordRuntimeEvent("warn", "kb-embed-executor", err?.message || err);
      }
    }
  }

  const index = { hash, entries };
  persistToDisk(index);
  return index;
}

async function loadOrBuildKbCache(kb) {
  if (!ENABLE_KB_EMBED_INDEX) return null;
  if (!kb || !Array.isArray(kb.issues)) return null;

  const hash = computeKbHash(kb);
  if (_index && _indexHash === hash) return _index;

  if (_buildPromise) return _buildPromise;
  _buildPromise = buildIndex(kb)
    .then((index) => {
      _index = index;
      _indexHash = index.hash;
      _buildPromise = null;
      recordRuntimeEvent("info", "kb-embed-cache", `index ready · ${index.entries.length} entries`);
      return index;
    })
    .catch((err) => {
      _buildPromise = null;
      recordRuntimeEvent("warn", "kb-embed-cache", err?.message || err);
      return null;
    });
  return _buildPromise;
}

function cosine(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

async function findSemanticMatches(text, { kind = "issue", k = 5 } = {}) {
  if (!_index || !_index.entries.length) return [];
  if (!text || !String(text).trim()) return [];
  let queryVec;
  try {
    queryVec = await embedText(String(text).slice(0, 500));
  } catch {
    return [];
  }
  const scored = _index.entries
    .filter((e) => kind === "*" || e.kind === kind || e.kind.startsWith(kind))
    .map((e) => ({ key: e.key, kind: e.kind, similarity: cosine(queryVec, e.vector) }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

function getIndexHash() {
  return _indexHash;
}

function isReady() {
  return Boolean(_index && _index.entries.length);
}

function __resetForTests() {
  _index = null;
  _indexHash = null;
  _buildPromise = null;
}

module.exports = {
  loadOrBuildKbCache,
  findSemanticMatches,
  getIndexHash,
  isReady,
  __resetForTests
};
