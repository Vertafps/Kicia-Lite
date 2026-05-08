process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const embedModule = require("../src/scam-embeddings-classifier");
const {
  buildCacheHash,
  classifyScamContextWithEmbeddings,
  buildPrototypeIndex,
  isEmbedderReady,
  __setEmbedderForTests,
  __setPrototypeIndexForTests,
  resetScamEmbedStateForTests
} = embedModule;

const { classifyScamContextLocallyAsync } = require("../src/scam-local-classifier");

const DIM = 384;

function seededVec(seed) {
  let s = seed >>> 0;
  const vec = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    vec[i] = ((s & 0xffff) / 0xffff) * 2 - 1;
  }
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

function hashSeed(text) {
  const h = crypto.createHash("sha256").update(String(text)).digest();
  return h.readUInt32LE(0);
}

function deterministicVec(text) {
  return seededVec(hashSeed(text));
}

function makeMockEmbedder() {
  return async function mockPipeline(text) {
    const vec = deterministicVec(text);
    return { tolist: () => Array.from(vec) };
  };
}

async function buildAndSetIndex(samples) {
  __setEmbedderForTests(makeMockEmbedder());
  const index = await buildPrototypeIndex({ samples });
  __setPrototypeIndexForTests(index);
  return index;
}

test("cache hash changes when SCAM_SAMPLES change", () => {
  const base = buildCacheHash("model-a", ["sell configs dm"], ["how to buy kicia"], "empty");
  const changed = buildCacheHash("model-a", ["sell configs dm", "NEW ENTRY"], ["how to buy kicia"], "empty");
  assert.notEqual(base, changed);
});

test("cache hash changes when SAFE_SAMPLES change", () => {
  const base = buildCacheHash("model-a", ["sell configs dm"], ["how to buy kicia"], "empty");
  const changed = buildCacheHash("model-a", ["sell configs dm"], ["how to buy kicia", "new safe entry"], "empty");
  assert.notEqual(base, changed);
});

test("cache hash changes when model ID changes", () => {
  const a = buildCacheHash("model-a", ["sell"], ["safe"], "empty");
  const b = buildCacheHash("model-b", ["sell"], ["safe"], "empty");
  assert.notEqual(a, b);
});

test("cache hash changes when harvested signature changes", () => {
  const a = buildCacheHash("model-a", ["sell"], ["safe"], "sig1");
  const b = buildCacheHash("model-a", ["sell"], ["safe"], "sig2");
  assert.notEqual(a, b);
});

test("cache hash is deterministic", () => {
  const a = buildCacheHash("model-a", ["sell configs dm"], ["how to buy kicia"], "empty");
  const b = buildCacheHash("model-a", ["sell configs dm"], ["how to buy kicia"], "empty");
  assert.equal(a, b);
});

test("isEmbedderReady returns true after __setEmbedderForTests", () => {
  __setEmbedderForTests(makeMockEmbedder());
  assert.equal(isEmbedderReady(), true);
});

test("classifyScamContextWithEmbeddings returns localVerdict shape", async () => {
  await buildAndSetIndex([
    { text: "selling configs cheap dm me", label: 1 },
    { text: "trading account for nitro", label: 1 },
    { text: "how to buy kicia", label: -1 },
    { text: "where to download kicia", label: -1 }
  ]);

  const result = await classifyScamContextWithEmbeddings({
    userMessages: ["selling configs dm me cheap"]
  });

  assert.ok(Object.prototype.hasOwnProperty.call(result, "verdict"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "confidence"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "score"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "reason"));
  assert.equal(result.stage, "embeddings");
  assert.equal(result.model, "local-kicia-embed-v1");
  assert.ok(Number.isFinite(result.score));
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.ok(Number.isFinite(result.confidence));
});

test("KNN score is near 0.5 when query is equidistant from scam and safe", async () => {
  const scamVec = new Float32Array(DIM);
  scamVec[0] = 1;
  const safeVec = new Float32Array(DIM);
  safeVec[1] = 1;
  const queryVec = new Float32Array(DIM);
  queryVec[0] = Math.SQRT1_2;
  queryVec[1] = Math.SQRT1_2;

  async function symmetricEmbedder(text) {
    if (text === "scam-proto") return { tolist: () => Array.from(scamVec) };
    if (text === "safe-proto") return { tolist: () => Array.from(safeVec) };
    return { tolist: () => Array.from(queryVec) };
  }

  __setEmbedderForTests(symmetricEmbedder);
  const index = await buildPrototypeIndex({
    samples: [
      { text: "scam-proto", label: 1 },
      { text: "safe-proto", label: -1 }
    ]
  });
  __setPrototypeIndexForTests(index);

  const result = await classifyScamContextWithEmbeddings({ userMessages: ["query text"] });
  assert.ok(result.score > 0.35 && result.score < 0.65, `Expected score near 0.5, got ${result.score}`);
  assert.equal(result.verdict, null);
});

test("KNN score >= 0.78 with clear margin produces verdict: true", async () => {
  const scamVec = new Float32Array(DIM);
  scamVec[0] = 1;
  const safeVec = new Float32Array(DIM);
  safeVec[1] = 1;
  const queryVec = new Float32Array(DIM);
  queryVec[0] = 0.9999;
  queryVec[2] = Math.sqrt(1 - 0.9999 * 0.9999);

  async function scamBiasedEmbedder(text) {
    if (text.startsWith("scam-")) return { tolist: () => Array.from(scamVec) };
    if (text.startsWith("safe-")) return { tolist: () => Array.from(safeVec) };
    return { tolist: () => Array.from(queryVec) };
  }

  __setEmbedderForTests(scamBiasedEmbedder);
  const index = await buildPrototypeIndex({
    samples: [
      { text: "scam-a", label: 1 },
      { text: "scam-b", label: 1 },
      { text: "scam-c", label: 1 },
      { text: "safe-a", label: -1 },
      { text: "safe-b", label: -1 }
    ]
  });
  __setPrototypeIndexForTests(index);

  const result = await classifyScamContextWithEmbeddings({ userMessages: ["very scammy message"] });
  assert.equal(result.verdict, true, `Expected verdict true, got ${result.verdict} (score=${result.score})`);
  assert.ok(result.confidence > 0);
});

test("KNN score <= 0.22 with clear margin produces verdict: false", async () => {
  const scamVec = new Float32Array(DIM);
  scamVec[0] = 1;
  const safeVec = new Float32Array(DIM);
  safeVec[1] = 1;
  const queryVec = new Float32Array(DIM);
  queryVec[1] = 0.9999;
  queryVec[2] = Math.sqrt(1 - 0.9999 * 0.9999);

  async function safeBiasedEmbedder(text) {
    if (text.startsWith("scam-")) return { tolist: () => Array.from(scamVec) };
    if (text.startsWith("safe-")) return { tolist: () => Array.from(safeVec) };
    return { tolist: () => Array.from(queryVec) };
  }

  __setEmbedderForTests(safeBiasedEmbedder);
  const index = await buildPrototypeIndex({
    samples: [
      { text: "scam-a", label: 1 },
      { text: "scam-b", label: 1 },
      { text: "safe-a", label: -1 },
      { text: "safe-b", label: -1 },
      { text: "safe-c", label: -1 }
    ]
  });
  __setPrototypeIndexForTests(index);

  const result = await classifyScamContextWithEmbeddings({ userMessages: ["totally safe message"] });
  assert.equal(result.verdict, false, `Expected verdict false, got ${result.verdict} (score=${result.score})`);
  assert.ok(result.confidence > 0);
});

test("graceful fallback when embedder throws during classify", async () => {
  await buildAndSetIndex([
    { text: "selling configs dm", label: 1 },
    { text: "how to download kicia", label: -1 }
  ]);

  async function throwingEmbedder() {
    throw new Error("model exploded");
  }
  __setEmbedderForTests(throwingEmbedder);

  const result = await classifyScamContextWithEmbeddings({
    userMessages: ["selling configs dm me"]
  });

  assert.ok(Object.prototype.hasOwnProperty.call(result, "verdict"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "score"));
  assert.equal(result.stage, "embeddings");
});

test("empty context produces verdict: null", async () => {
  __setEmbedderForTests(makeMockEmbedder());
  __setPrototypeIndexForTests({
    vectors: [deterministicVec("scam")],
    labels: [1],
    texts: ["scam"]
  });

  const result = await classifyScamContextWithEmbeddings({});
  assert.equal(result.verdict, null);
  assert.equal(result.stage, "embeddings");
});

test("reason field is a non-empty string for all verdict types", async () => {
  const scamVec = new Float32Array(DIM);
  scamVec[0] = 1;
  const safeVec = new Float32Array(DIM);
  safeVec[1] = 1;

  async function polarEmbedder(text) {
    if (text.startsWith("scam-")) return { tolist: () => Array.from(scamVec) };
    if (text.startsWith("safe-")) return { tolist: () => Array.from(safeVec) };
    if (text === "query-scam") return { tolist: () => { const v = new Float32Array(DIM); v[0] = 0.9999; v[2] = Math.sqrt(1 - 0.9999 * 0.9999); return Array.from(v); } };
    const v = new Float32Array(DIM); v[1] = 0.9999; v[2] = Math.sqrt(1 - 0.9999 * 0.9999); return { tolist: () => Array.from(v) };
  }

  __setEmbedderForTests(polarEmbedder);
  const index = await buildPrototypeIndex({
    samples: [
      { text: "scam-1", label: 1 },
      { text: "scam-2", label: 1 },
      { text: "scam-3", label: 1 },
      { text: "safe-1", label: -1 },
      { text: "safe-2", label: -1 },
      { text: "safe-3", label: -1 }
    ]
  });
  __setPrototypeIndexForTests(index);

  const scamResult = await classifyScamContextWithEmbeddings({ userMessages: ["query-scam"] });
  const safeResult = await classifyScamContextWithEmbeddings({ userMessages: ["query-safe"] });

  assert.ok(typeof scamResult.reason === "string" && scamResult.reason.length > 0);
  assert.ok(typeof safeResult.reason === "string" && safeResult.reason.length > 0);
});

test("classifyScamContextLocallyAsync returns sync verdict true without embedder for clear scam", async () => {
  resetScamEmbedStateForTests();

  const result = await classifyScamContextLocallyAsync({
    userMessages: ["selling kicia config cheap dm me"]
  });

  assert.equal(result.verdict, true);
  assert.ok(result.confidence > 0);
});

test("classifyScamContextLocallyAsync does not flag antivirus support as scam", async () => {
  resetScamEmbedStateForTests();

  const result = await classifyScamContextLocallyAsync({
    userMessages: ["how do i disable windows defender for kicia"]
  });

  assert.notEqual(result.verdict, true);
});

test("classifyScamContextLocallyAsync falls back to NB result when embedder is absent", async () => {
  resetScamEmbedStateForTests();

  const result = await classifyScamContextLocallyAsync({
    userMessages: ["wave executor isnt loading anymore"]
  });

  assert.ok(Object.prototype.hasOwnProperty.call(result, "verdict"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "confidence"));
  assert.notEqual(result.verdict, true);
});
