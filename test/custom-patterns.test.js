"use strict";

// env shims required by various src/* modules at require time
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

// ----------------------------------------------------------------------------
// Build a fake in-memory db that mimics the sql.js surface custom-patterns.js
// uses (db.run, db.prepare → stmt.bind/step/get/getAsObject/free). The shape
// the module needs is narrow, so the fake is small.
// ----------------------------------------------------------------------------

let nextRowId = 0;
const rows = []; // { id, phrase, normalized_phrase, timeout_ms, threshold, vector_json, created_by, created_at }
let lastInsertId = 0;

function resetFakeDb() {
  nextRowId = 0;
  rows.length = 0;
  lastInsertId = 0;
}

function makeStmtForInsert(values) {
  // INSERT INTO custom_timeout_patterns (...) VALUES (?, ?, ?, ?, ?, ?, ?)
  // values order matches the module: phrase, normalized_phrase, timeout_ms,
  // threshold, vector_json, created_by, created_at.
  return {
    bind() {},
    step() { return false; },
    get() { return []; },
    getAsObject() { return {}; },
    free() {}
  };
}

const fakeDb = {
  run(sql, params = []) {
    const trimmed = String(sql || "").trim();
    if (/^INSERT INTO custom_timeout_patterns/i.test(trimmed)) {
      nextRowId += 1;
      lastInsertId = nextRowId;
      rows.push({
        id: nextRowId,
        phrase: params[0],
        normalized_phrase: params[1],
        timeout_ms: params[2],
        threshold: params[3],
        vector_json: params[4],
        created_by: params[5],
        created_at: params[6]
      });
      return;
    }
    if (/^UPDATE custom_timeout_patterns SET threshold/i.test(trimmed)) {
      const [thresh, id] = params;
      const row = rows.find((r) => Number(r.id) === Number(id));
      if (row) row.threshold = thresh;
      return;
    }
    if (/^UPDATE custom_timeout_patterns SET vector_json/i.test(trimmed)) {
      const [vecJson, id] = params;
      const row = rows.find((r) => Number(r.id) === Number(id));
      if (row) row.vector_json = vecJson;
      return;
    }
    if (/^DELETE FROM custom_timeout_patterns/i.test(trimmed)) {
      const [id] = params;
      const idx = rows.findIndex((r) => Number(r.id) === Number(id));
      if (idx >= 0) rows.splice(idx, 1);
      return;
    }
  },
  prepare(sql) {
    const trimmed = String(sql || "").trim();

    if (/last_insert_rowid/i.test(trimmed)) {
      let stepped = false;
      return {
        bind() {},
        step() {
          if (stepped) return false;
          stepped = true;
          return true;
        },
        get() { return [lastInsertId]; },
        getAsObject() { return { "last_insert_rowid()": lastInsertId }; },
        free() {}
      };
    }

    if (/^SELECT id, phrase/i.test(trimmed)) {
      let idx = 0;
      return {
        bind() {},
        step() {
          return idx < rows.length;
        },
        get() {
          const r = rows[idx];
          idx += 1;
          return r;
        },
        getAsObject() {
          const r = rows[idx];
          idx += 1;
          return { ...r };
        },
        free() {}
      };
    }

    return makeStmtForInsert();
  }
};

// Stub `restricted-emoji-db` BEFORE we require custom-patterns so it picks up
// our fake instead of the real sqlite-backed one.
{
  const resolved = require.resolve("../src/restricted-emoji-db");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {
      getDatabase: async () => fakeDb,
      schedulePersist: () => {}
    }
  };
}

// ----------------------------------------------------------------------------
// Stub the MiniLM embedder so test runs don't hit the network. We need
// controllable cosine distances — deterministic vector keyed off the input
// string. Strategy: hash the text → seed a small RNG → fill a 384-dim vector,
// then normalize. Similar texts that are exactly equal embed identically
// (cos = 1); different texts get different vectors with low cos. To simulate
// "similar paraphrases match" we add an explicit override table mapping
// specific test inputs to engineered nearby vectors.
// ----------------------------------------------------------------------------

const embeddings = require("../src/embeddings");

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandomVec(seed) {
  const rng = mulberry32(seed);
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = rng() * 2 - 1;
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}

function blendVecs(a, b, alpha) {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = a[i] * (1 - alpha) + b[i] * alpha;
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
}

// engineer specific cluster vectors
// - cluster A (v2-better-than-v3 family): seed phrase + variants close to it
// - cluster B (opposite polarity v3>v2): far from A
// - cluster C (unrelated): far from both
const SEED_A = makeRandomVec(101);
const SEED_B = makeRandomVec(202);
const SEED_C = makeRandomVec(303);

const OVERRIDE_MAP = new Map();
function setOverride(text, vec) {
  // store under the normalized (.folded) form the module will request — but
  // since our normalizePhrase does NFKD+confusable-fold, plain ASCII text
  // passes through unchanged. so we just key on the raw lowercase.
  OVERRIDE_MAP.set(text, vec);
}

// seed/variants — engineered to be very close to SEED_A
setOverride("v2 is better than v3", SEED_A);
setOverride("kicia v2 is wayyy better than v3", blendVecs(SEED_A, SEED_C, 0.04));
setOverride("v22222222 is ebeettterr than v3", blendVecs(SEED_A, SEED_C, 0.06));
setOverride("v2 way better than v3 imo", blendVecs(SEED_A, SEED_C, 0.05));

// medium-similarity paraphrase — sits in ~[0.65, 0.85] cosine range. used by
// the strict-threshold test to confirm best-candidate surfacing.
setOverride("v2 kinda beats v3 sometimes", blendVecs(SEED_A, SEED_C, 0.35));

// opposite polarity — far from A
setOverride("v3 is better than v2", SEED_B);

// unrelated — far from A
setOverride("hello world", SEED_C);
setOverride("kicia is good", blendVecs(SEED_C, SEED_B, 0.5));
setOverride("what's the difference between v2 and v3", blendVecs(SEED_C, SEED_B, 0.3));

function vecForText(text) {
  const override = OVERRIDE_MAP.get(text);
  if (override) return override;
  // fallback — deterministic random by hash, far from A by construction
  return makeRandomVec(hashString(text) + 100000);
}

// Embedder stub returns a plain Array so that embeddings.embedText's
// `Array.isArray(output)` branch picks it up (Float32Array isn't an Array).
// The Float32Array gets reconstructed + re-normalized inside embedText.
embeddings.__setEmbedderForTests(async (text) => {
  const s = String(text || "");
  const vec = vecForText(s);
  return Array.from(vec);
});

// Now require the module under test (after stubs are planted).
const patterns = require("../src/custom-patterns");

test.beforeEach(() => {
  patterns.__resetForTests();
  resetFakeDb();
});

// ============================================================================
// addPattern / listPatterns / removePattern
// ============================================================================

test.describe("custom-patterns: basic CRUD", () => {
  test("addPattern returns an id and persists the row", async () => {
    const id = await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80,
      createdBy: "owner-123"
    });
    assert.ok(Number.isFinite(id) && id > 0, "expected a positive numeric id");

    const list = await patterns.listPatterns();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, id);
    assert.strictEqual(list[0].phrase, "v2 is better than v3");
    assert.strictEqual(list[0].timeoutMs, 60 * 60 * 1000);
    assert.strictEqual(list[0].threshold, 0.80);
    assert.strictEqual(list[0].createdBy, "owner-123");
  });

  test("addPattern rejects empty phrase", async () => {
    await assert.rejects(
      () => patterns.addPattern({ phrase: "", timeoutMs: 60_000 }),
      /required/i
    );
  });

  test("addPattern clamps tiny timeoutMs up to the 1m floor", async () => {
    const id = await patterns.addPattern({
      phrase: "tiny pattern",
      timeoutMs: 100,
      threshold: 0.80
    });
    const list = await patterns.listPatterns();
    const entry = list.find((p) => p.id === id);
    assert.ok(entry);
    assert.strictEqual(entry.timeoutMs, 60_000);
  });

  test("addPattern clamps threshold into [0.5, 0.99]", async () => {
    const lowId = await patterns.addPattern({ phrase: "low t", timeoutMs: 60_000, threshold: 0.1 });
    const highId = await patterns.addPattern({ phrase: "high t", timeoutMs: 60_000, threshold: 9.9 });
    const list = await patterns.listPatterns();
    const low = list.find((p) => p.id === lowId);
    const high = list.find((p) => p.id === highId);
    assert.strictEqual(low.threshold, 0.5);
    assert.strictEqual(high.threshold, 0.99);
  });

  test("removePattern drops the row + cache entry", async () => {
    const id = await patterns.addPattern({
      phrase: "remove me",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    assert.strictEqual((await patterns.listPatterns()).length, 1);

    const removed = await patterns.removePattern(id);
    assert.strictEqual(removed, true);
    assert.strictEqual((await patterns.listPatterns()).length, 0);
  });

  test("removePattern returns false for an id that was never added", async () => {
    const removed = await patterns.removePattern(99999);
    assert.strictEqual(removed, false);
  });

  test("setThreshold updates an existing pattern's threshold", async () => {
    const id = await patterns.addPattern({
      phrase: "tunable",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    const ok = await patterns.setThreshold(id, 0.93);
    assert.strictEqual(ok, true);
    const list = await patterns.listPatterns();
    assert.strictEqual(list[0].threshold, 0.93);
  });

  test("setThreshold returns false for unknown id", async () => {
    const ok = await patterns.setThreshold(99999, 0.85);
    assert.strictEqual(ok, false);
  });
});

// ============================================================================
// matchMessage — semantic matching against the cached cluster
// ============================================================================

test.describe("custom-patterns: matchMessage", () => {
  test("exact phrase against itself → matched, score ~1", async () => {
    await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    const result = await patterns.matchMessage("v2 is better than v3");
    assert.strictEqual(result.matched, true);
    assert.ok(result.score >= 0.99, `expected near-1 cosine, got ${result.score}`);
  });

  test("close paraphrase matches the seed pattern", async () => {
    await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    const result = await patterns.matchMessage("kicia v2 is wayyy better than v3");
    assert.strictEqual(result.matched, true, `score was ${result.score}, expected match`);
    assert.ok(result.score >= 0.80);
  });

  test("leet-ish obfuscation still matches", async () => {
    await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    const result = await patterns.matchMessage("v22222222 is ebeettterr than v3");
    assert.strictEqual(result.matched, true, `score was ${result.score}, expected match`);
  });

  test("opposite polarity ('v3 is better than v2') does NOT match", async () => {
    await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    const result = await patterns.matchMessage("v3 is better than v2");
    assert.strictEqual(result.matched, false, `should not match opposite polarity, score=${result.bestScore}`);
  });

  test("totally unrelated text does NOT match", async () => {
    await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    const result = await patterns.matchMessage("hello world");
    assert.strictEqual(result.matched, false);
  });

  test("empty / whitespace input returns matched=false", async () => {
    await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    const r1 = await patterns.matchMessage("");
    const r2 = await patterns.matchMessage("   \t\n   ");
    const r3 = await patterns.matchMessage(null);
    assert.strictEqual(r1.matched, false);
    assert.strictEqual(r2.matched, false);
    assert.strictEqual(r3.matched, false);
  });

  test("with no patterns registered, matchMessage returns matched=false", async () => {
    const result = await patterns.matchMessage("anything");
    assert.strictEqual(result.matched, false);
  });

  test("$pattern test minThreshold surfaces best candidate even if below pattern threshold", async () => {
    await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.95 // strict — medium-paraphrase falls under it but above 0.5
    });
    const result = await patterns.matchMessage("v2 kinda beats v3 sometimes", { minThreshold: 0.5 });
    assert.strictEqual(result.matched, false, `expected no match, got score=${result.score}`);
    // we still want the caller to see what we DID find
    assert.ok(result.bestPatternId, "expected bestPatternId in test-mode response");
    assert.ok(result.bestScore > 0.5, `expected bestScore > 0.5, got ${result.bestScore}`);
    assert.ok(result.bestScore < 0.95, `expected bestScore < 0.95 (under threshold), got ${result.bestScore}`);
  });

  test("after removing the only pattern, matchMessage returns matched=false", async () => {
    const id = await patterns.addPattern({
      phrase: "v2 is better than v3",
      timeoutMs: 60 * 60 * 1000,
      threshold: 0.80
    });
    await patterns.removePattern(id);
    const result = await patterns.matchMessage("v2 is better than v3");
    assert.strictEqual(result.matched, false);
  });
});

// ============================================================================
// teardown — restore embedder so other tests aren't affected
// ============================================================================

test.after(() => {
  embeddings.__resetForTests();
});
