"use strict";

// One-off verification script — exercises the head-driven branches added to
// classifyKiciaDisrespect by mocking the trained-head loader and the example
// banks. Not part of the test suite; safe to delete.
//
// Usage: node scripts/verify-head-classifier.js

process.env.DISCORD_TOKEN = "test-token";
process.env.KB_URL = "https://example.com/kb.json";

const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// 1. Stub permissions + settings (defaults will be used).
// ---------------------------------------------------------------------------
function stubRequire(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports
  };
}

stubRequire("../src/permissions", {});

// ---------------------------------------------------------------------------
// 2. Stub the restricted-emoji-db module — its getDatabase() drives
//    loadRespectHead(). We hand back a fake DB that synthesizes whatever
//    head weights / bias the test wants.
// ---------------------------------------------------------------------------
//
// scoreLogisticHead(vec, head) returns sigmoid(vec·head.W + head.b). We craft
// W such that vec·W + b lands at a specific sigmoid value for the test vector.
//
// Embedder is stubbed to return a constant unit vector v[i]=sin(i*0.13)/||..||.
// We pick W = alpha * v so vec·W = alpha (||v||² = 1), and tune (alpha, b) to
// hit a desired sigmoid score.
//
// HEAD_SCORE controls the head probability.
let HEAD_SCORE = 0.0;

function makeFakeDb(headScore) {
  // sigmoid⁻¹(p) = ln(p/(1-p))
  const z = Math.log(headScore / (1 - headScore));
  const N = 384;
  // unit vec from the stubbed embedder
  const u = new Float32Array(N);
  for (let i = 0; i < N; i++) u[i] = Math.sin(i * 0.13);
  let norm = 0;
  for (let i = 0; i < N; i++) norm += u[i] * u[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < N; i++) u[i] /= norm;
  // W = z * u → vec·W + 0 = z → sigmoid = headScore
  const W = Array.from(u, (x) => x * z);
  const head = { W, b: 0 };
  const raw = JSON.stringify(head);

  return {
    prepare() {
      return {
        bind() {},
        step() { return true; },
        get() { return [raw]; },
        free() {}
      };
    }
  };
}

const fakeEmojiDb = {
  async getDatabase() {
    return makeFakeDb(HEAD_SCORE);
  }
};
stubRequire("../src/restricted-emoji-db", fakeEmojiDb);

// ---------------------------------------------------------------------------
// 3. Stub the embedder. embedText pulls .data and renormalizes — give it a
//    raw sin vector and let it do the normalization.
// ---------------------------------------------------------------------------
const embeddings = require("../src/embeddings");
embeddings.__setEmbedderForTests(async () => {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.13);
  return { data: v };
});

// ---------------------------------------------------------------------------
// 4. Stub the banks. SEM_DELTA controls disrespectMax - neutralMax.
//    We hand back two single-entry banks. The entry's vector is u or its
//    negation, scaled to achieve the desired cosine.
// ---------------------------------------------------------------------------
let SEM_DELTA = 0.0;

const exampleBanks = require("../src/example-banks");
exampleBanks.getBank = function (name) {
  // u is the test embedding (unit norm). Bank entries return cosineSim with u.
  // We want maxCos(disrespectBank) = SEM_DELTA, maxCos(neutralBank) = 0.
  const u = new Float32Array(384);
  for (let i = 0; i < 384; i++) u[i] = Math.sin(i * 0.13);
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += u[i] * u[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) u[i] /= norm;

  if (name === "respect-disrespect") {
    // unit vector aligned with u, scaled cosine = SEM_DELTA via partial alignment
    // simpler: pick a vector w = SEM_DELTA*u + sqrt(1-SEM_DELTA²)*orth(u). cos = SEM_DELTA.
    const w = new Float32Array(384);
    // orth: any vector not parallel to u; we use e0 then subtract its projection on u
    const e = new Float32Array(384);
    e[0] = 1;
    const dot = u[0]; // since e=(1,0,...,0), dot = u[0]
    for (let i = 0; i < 384; i++) e[i] -= dot * u[i];
    let en = 0;
    for (let i = 0; i < 384; i++) en += e[i] * e[i];
    en = Math.sqrt(en) || 1;
    for (let i = 0; i < 384; i++) e[i] /= en;
    const beta = Math.sqrt(Math.max(0, 1 - SEM_DELTA * SEM_DELTA));
    for (let i = 0; i < 384; i++) w[i] = SEM_DELTA * u[i] + beta * e[i];
    return [{ vector: w }];
  }
  if (name === "respect-neutral") {
    // orthogonal to u → cosine 0
    const e = new Float32Array(384);
    e[0] = 1;
    const dot = u[0];
    for (let i = 0; i < 384; i++) e[i] -= dot * u[i];
    let en = 0;
    for (let i = 0; i < 384; i++) en += e[i] * e[i];
    en = Math.sqrt(en) || 1;
    for (let i = 0; i < 384; i++) e[i] /= en;
    return [{ vector: e }];
  }
  return null;
};

// ---------------------------------------------------------------------------
// 5. Now require the classifier.
// ---------------------------------------------------------------------------
const {
  classifyKiciaDisrespect,
  resetHeadCache,
  __internals
} = require("../src/kicia-disrespect");
const { comparativeNegBoost } = __internals;

// ---------------------------------------------------------------------------
// 6. Run cases.
// ---------------------------------------------------------------------------
async function run(label, text, expectedNonIgnore, opts = {}) {
  HEAD_SCORE = opts.headScore ?? 0.85;
  SEM_DELTA = opts.semDelta ?? 0.05;
  resetHeadCache();
  const result = await classifyKiciaDisrespect(text);
  const ok = expectedNonIgnore
    ? result.verdict !== "ignore"
    : result.verdict === "ignore";
  const status = ok ? "PASS" : "FAIL";
  console.log(
    `${status} [${label}] "${text}" → ${result.verdict} ` +
    `(conf=${result.signals.confidence.toFixed(2)} ` +
    `head=${result.signals.headScore?.toFixed(2) ?? "n/a"} ` +
    `semDelta=${result.signals.semDisrespect.toFixed(2)} ` +
    `negMag=${result.signals.kiciaNegMag.toFixed(2)} ` +
    `reason="${result.reasonText}")`
  );
  return ok;
}

(async () => {
  const fails = [];

  // -----------------------------------------------------------------------
  // MUST FLAG (non-ignore) when head probe is confident (>= 0.65)
  // -----------------------------------------------------------------------
  console.log("\n=== must-flag (head=0.85, semDelta=0.05 → head-only path) ===");
  const flagCases = [
    "v3 worse than v2 fr",
    "ue mogs kicia hard",
    "v3 is bottom barrel",
    "kicia hasnt worked since launch",
    "v3 makes me regret paying",
    "v3 is npc",
    "kicia is rizzless",
    "v3 garbage tier exec"
  ];
  for (const t of flagCases) {
    const ok = await run("must-flag", t, true, { headScore: 0.85, semDelta: 0.05 });
    if (!ok) fails.push(t);
  }

  // -----------------------------------------------------------------------
  // MUST IGNORE — head is low (0.30), no other signals.
  // -----------------------------------------------------------------------
  console.log("\n=== must-ignore (head=0.30, semDelta=0.05) ===");
  const ignoreLowHead = [
    "kicia is good ue is dogshit",         // counter-example: kicia-positive
    "kicia mogs every other exec",         // kicia is mogging, not being mogged
    "v3 has a frame drop issue",
    "kicia could use a darkmode",
    "i wish kicia had auto-execute",
    "kicia v3 update came out"
  ];
  for (const t of ignoreLowHead) {
    const ok = await run("must-ignore", t, false, { headScore: 0.30, semDelta: 0.05 });
    if (!ok) fails.push(t);
  }

  // -----------------------------------------------------------------------
  // Even with a HIGH head score, true constructive language must still be
  // ignored by the CONSTRUCTIVE_RE prefilter that runs before the head.
  // The wish/hope/feature-request shape catches the most common asks.
  // -----------------------------------------------------------------------
  console.log("\n=== must-ignore even with high head (CONSTRUCTIVE_RE prefilter) ===");
  const ignoreHighHead = [
    ["i wish kicia had auto-execute", "wish — short-circuits before head"],
    ["i hope kicia adds a darkmode",   "hope — short-circuits before head"]
  ];
  for (const [t, label] of ignoreHighHead) {
    const ok = await run(label, t, false, { headScore: 0.85, semDelta: 0.05 });
    if (!ok) fails.push(`${t} (high-head): ${label}`);
  }

  // Note: in production, "kicia could use a darkmode" and "kicia v3 update
  // came out" remain ignore because the trained head (P=78.7%, R=93.0%) does
  // NOT score them high — they aren't in the disrespect corpus. We can't
  // emulate that in cold-start since we force the head value. Real-server
  // behavior is verified via the live retrained-head test results in the
  // task description (the 8 must-flag cases were the original misses).

  // -----------------------------------------------------------------------
  // comparativeNegBoost direct probe
  // -----------------------------------------------------------------------
  console.log("\n=== comparativeNegBoost direct ===");
  const vocab = require("../src/kicia-disrespect").buildEntityVocabularyFromKb({
    executorAliasIndex: { ue: {}, fluxus: {} }
  });
  const probes = [
    ["ue mogs kicia hard", 1],                    // kicia is object → +1
    ["kicia mogs every other exec", 0],           // kicia is subject → 0
    ["v3 worse than v2 fr", 0.5],                 // kicia + comp-neg in same clause → +0.5
    ["v3 is bottom barrel", 0.5],                 // comp-neg phrase → +0.5
    ["v3 makes me regret paying", 0],             // no comp-neg in text — falls outside this detector
    ["kicia is good", 0]                          // pure positive
  ];
  for (const [t, expected] of probes) {
    const boost = comparativeNegBoost(t, vocab);
    const ok = Math.abs(boost - expected) < 1e-6;
    const status = ok ? "PASS" : "FAIL";
    console.log(`${status} comparativeNegBoost("${t}") = ${boost} (expected ${expected})`);
    if (!ok) fails.push(`comp-boost: ${t}`);
  }

  console.log(`\n${fails.length === 0 ? "ALL CHECKS PASSED" : "FAILURES: " + fails.length}`);
  for (const f of fails) console.log("  - " + f);
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(2);
});
