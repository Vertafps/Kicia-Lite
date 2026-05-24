"use strict";

// env shims required by various src/* modules at require time
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

// ----------------------------------------------------------------------------
// Plant a stub for `restricted-emoji-db` BEFORE requiring the classifier so
// the head loader short-circuits (no sqlite open, no file I/O). The classifier
// guards with `typeof dbModule.getDatabase !== "function"` — an empty exports
// object satisfies that and returns head=null.
// ----------------------------------------------------------------------------
{
  const resolved = require.resolve("../src/restricted-emoji-db");
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {}
  };
}

// ----------------------------------------------------------------------------
// Stub the MiniLM embedder so we never hit the network even if a code path
// changes and tries to embed. Returns a deterministic unit vector.
// ----------------------------------------------------------------------------
const embeddings = require("../src/embeddings");
embeddings.__setEmbedderForTests(async () => {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = Math.sin(i * 0.13);
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 384; i++) v[i] /= norm;
  return v;
});

// Force the cold-start path by making getBank always return null. This drops
// semantic + head signals from H — the rest of the decision rule still runs.
const exampleBanks = require("../src/example-banks");
const originalGetBank = exampleBanks.getBank;
exampleBanks.getBank = () => null;

const { classifyScamTrade, __internals } = require("../src/scam-trade");
const { computeDirectionScore, pickSeverity, normalizeSemDelta, computeConfidence } = __internals;

// ============================================================================
// classifyScamTrade — must-flag cases (verdict !== "ignore")
// ----------------------------------------------------------------------------
// In cold-start mode (no banks) we lose the semantic signal entirely, so a
// message that would TIMEOUT with warm banks may degrade to REVIEW. The owner
// only cares that the message escapes "ignore" — staff handles review.
// ============================================================================

const MUST_FLAG_CASES = [
  // [text, label]
  ["selling kicia for ue dm me",        "explicit sale + dm solicitation"],
  ["wts kicia hook lifetime $10",       "wts + topic + price"],
  ["trading kicia for fluxus, hmu",     "trading verb + topic + dm slang (hmu)"],
  ["selling my kicia key cheap",        "selling + topic (no price hit)"],
  ["wts v3 lifetime, paypal only",      "wts + v3 topic + payment processor"],
  ["kicia for sale, dm me",             "for-sale phrasing + dm"],
  ["sold my kicia, who wants v3 trade", "sold/trade verbs near v3"],
  ["selling kicia + ue 5usd dm me",     "explicit sale + price + dm"],
  // ecosystem-noun cases — user reported "Im selling configs" was missed
  ["im selling configs",                "selling + configs (no kicia word)"],
  ["wts configs cheap dm me",           "wts + configs + dm"],
  ["selling lifetime $10 paypal",       "selling + lifetime + price + payment"],
  ["selling my keys dm me",             "selling + keys + dm"],
  ["selling premium configs hmu",       "selling + premium + configs + dm slang"]
];

test.describe("scam-trade: must-flag cases", () => {
  for (const [text, label] of MUST_FLAG_CASES) {
    test(`flags: "${text}" (${label})`, async () => {
      const result = await classifyScamTrade(text);
      assert.notStrictEqual(
        result.verdict,
        "ignore",
        `expected non-ignore, got ${result.verdict} · reason=${result.reasonText}`
      );
      assert.ok(
        result.verdict === "timeout" || result.verdict === "review",
        `verdict must be timeout or review, got ${result.verdict}`
      );
    });
  }
});

// ============================================================================
// classifyScamTrade — must-NOT-flag cases (verdict === "ignore")
// ----------------------------------------------------------------------------
// Zero false positives on a 100k-user server is the explicit bar. Every line
// below is a real category of legitimate chatter that must never auto-action.
// ============================================================================

const MUST_NOT_FLAG_CASES = [
  // buyer side — support / shopping inquiries
  ["where can i buy kicia",                        "buyer · explicit purchase intent"],
  ["how much is kicia",                            "buyer · pricing inquiry"],
  ["is kicia free or paid",                        "buyer · pricing inquiry"],
  ["is kicia worth buying",                        "buyer · purchase consideration"],
  ["how do i get kicia",                           "buyer · acquisition question"],
  ["should i buy kicia",                           "buyer · purchase consideration"],
  ["is there a kicia trial",                       "buyer · trial inquiry"],

  // off-topic — no kicia mention at all (topical gate)
  ["hello, how is everyone",                       "no topic"],
  ["some random message about gaming",             "no topic"],
  ["i'm just chilling in the lobby",               "no topic"],

  // kicia-topical but no commerce
  ["i wish kicia had X feature",                   "feature wish · no commerce"],
  ["thanks for the help with kicia",               "gratitude · no commerce"],
  ["kicia helped me hit silver today",             "praise · no commerce"],

  // meta / warning / report-about-someone-else
  ["someone is selling kicia in dms — should i report",  "meta · warning"],
  ["don't buy kicia from randoms",                       "meta · negative imperative"],
  ["is this allowed: selling kicia?",                    "meta · rules question"],
  ["people are scamming with kicia keys, be careful",    "meta · scam warning"],
  ["staff banned a user for selling kicia yesterday",    "meta · third-person report"],
  ["report anyone selling kicia",                        "meta · explicit report"]
];

test.describe("scam-trade: must-NOT-flag cases", () => {
  for (const [text, label] of MUST_NOT_FLAG_CASES) {
    test(`ignores: "${text}" (${label})`, async () => {
      const result = await classifyScamTrade(text);
      assert.strictEqual(
        result.verdict,
        "ignore",
        `expected ignore, got ${result.verdict} · reason=${result.reasonText}`
      );
      assert.strictEqual(result.severity, null);
      assert.strictEqual(result.durationMs, null);
    });
  }
});

// ============================================================================
// classifyScamTrade — empty / pathological input
// ============================================================================

test.describe("scam-trade: edge inputs", () => {
  test("empty string returns NOOP ignore", async () => {
    const result = await classifyScamTrade("");
    assert.strictEqual(result.verdict, "ignore");
    assert.strictEqual(result.severity, null);
  });

  test("whitespace-only returns NOOP ignore", async () => {
    const result = await classifyScamTrade("   \t\n   ");
    assert.strictEqual(result.verdict, "ignore");
  });

  test("null input returns NOOP ignore (defensive)", async () => {
    const result = await classifyScamTrade(null);
    assert.strictEqual(result.verdict, "ignore");
  });

  test("undefined input returns NOOP ignore (defensive)", async () => {
    const result = await classifyScamTrade(undefined);
    assert.strictEqual(result.verdict, "ignore");
  });

  test("very long message stays safe", async () => {
    const text = "i love using kicia ".repeat(80);
    const result = await classifyScamTrade(text);
    // no commerce signals at all
    assert.strictEqual(result.verdict, "ignore");
  });

  test("result always carries classifier + signals shape", async () => {
    const result = await classifyScamTrade("hello there");
    assert.strictEqual(result.classifier, "scam");
    assert.ok(result.signals);
    assert.ok("directionScore" in result.signals);
    assert.ok("priceHit" in result.signals);
    assert.ok("dmHit" in result.signals);
    assert.ok("topicHit" in result.signals);
    assert.ok("H" in result.signals);
    assert.ok("confidence" in result.signals);
  });
});

// ============================================================================
// computeDirectionScore — regex direction detection
// ============================================================================

test.describe("scam-trade: computeDirectionScore", () => {
  test("seller + topic within 40 chars → +2", () => {
    assert.strictEqual(computeDirectionScore("selling kicia"), 2);
    assert.strictEqual(computeDirectionScore("wts kicia hook"), 2);
    assert.strictEqual(computeDirectionScore("kicia for sale"), 2);
    assert.strictEqual(computeDirectionScore("trade kicia for ue"), 2);
    assert.strictEqual(computeDirectionScore("swapping v3 for fluxus"), 2);
  });

  test("seller + topic far apart (>40 chars) → +1", () => {
    // Construct a string with seller hit at index 0 and topic past index 40.
    // "selling " is 8 chars; pad to push topic past 40 chars from start.
    const padding = "x".repeat(45);
    const text = `selling ${padding} kicia stuff`;
    // sanity: seller at 0, topic at 8+45+1 = 54
    assert.strictEqual(computeDirectionScore(text), 1);
  });

  test("buyer without seller → -2", () => {
    assert.strictEqual(computeDirectionScore("where can i buy kicia"), -2);
    assert.strictEqual(computeDirectionScore("how much is kicia"), -2);
    assert.strictEqual(computeDirectionScore("wtb kicia premium"), -2);
    assert.strictEqual(computeDirectionScore("looking to buy kicia"), -2);
    assert.strictEqual(computeDirectionScore("how do i get kicia"), -2);
  });

  test("no seller, no buyer, no topic → 0", () => {
    assert.strictEqual(computeDirectionScore("hello there"), 0);
    assert.strictEqual(computeDirectionScore("good morning"), 0);
    assert.strictEqual(computeDirectionScore(""), 0);
  });

  test("seller without topic → 0", () => {
    // SELLER_RE hits "selling" but no kicia/hook/v3/v4 anywhere
    assert.strictEqual(computeDirectionScore("selling cookies at the bake sale"), 0);
  });

  test("buyer AND seller present → +2 wins (seller takes priority when near topic)", () => {
    // "wtb" is buyer, but seller verb "selling" comes WITH topic nearby
    const score = computeDirectionScore("wtb robux, selling kicia dm");
    // seller-near-topic gives +2; buyer-without-seller would be -2, but
    // sellerHit is truthy so the buyer-veto branch isn't taken.
    assert.strictEqual(score, 2);
  });

  test("kicia variants all count as topic", () => {
    assert.strictEqual(computeDirectionScore("selling kiciahook"), 2);
    assert.strictEqual(computeDirectionScore("selling hook"), 2);
    assert.strictEqual(computeDirectionScore("selling v3"), 2);
    assert.strictEqual(computeDirectionScore("selling v2"), 2);
  });
});

// ============================================================================
// pickSeverity — severity tier picking
// ============================================================================

test.describe("scam-trade: pickSeverity", () => {
  test("H=3 confidence 0.93 price/no-dm → light", () => {
    assert.strictEqual(pickSeverity(3, 0.93, true, false), "light");
  });

  test("H=3 confidence 0.92 (boundary) → light", () => {
    assert.strictEqual(pickSeverity(3, 0.92, true, true), "light");
  });

  test("H=4 confidence 0.96 → medium", () => {
    assert.strictEqual(pickSeverity(4, 0.96, true, true), "medium");
  });

  test("H=4 confidence 0.95 (boundary) → medium", () => {
    assert.strictEqual(pickSeverity(4, 0.95, true, true), "medium");
  });

  test("H=5 confidence 0.99 + price + dm → severe", () => {
    assert.strictEqual(pickSeverity(5, 0.99, true, true), "severe");
  });

  test("H=4 confidence 0.98 + price + dm → severe", () => {
    assert.strictEqual(pickSeverity(4, 0.98, true, true), "severe");
  });

  test("H=4 confidence 0.99 but missing price → not severe (falls to medium-or-below)", () => {
    // confidence 0.99 doesn't meet medium (which is [0.95, 0.98)), so it falls
    // through the defensive guards. Verify it returns a legal tier rather than
    // escalating to severe without price/dm.
    const tier = pickSeverity(4, 0.99, false, true);
    assert.notStrictEqual(tier, "severe");
    // legal tier or null — both acceptable here, just not severe
  });

  test("H=4 confidence 0.99 but missing dm → not severe", () => {
    const tier = pickSeverity(4, 0.99, true, false);
    assert.notStrictEqual(tier, "severe");
  });

  test("H=2 confidence anything → null (under-threshold)", () => {
    assert.strictEqual(pickSeverity(2, 0.92, true, true), null);
    assert.strictEqual(pickSeverity(2, 0.99, true, true), null);
  });

  test("H=3 confidence below 0.92 → null", () => {
    assert.strictEqual(pickSeverity(3, 0.91, true, true), null);
    assert.strictEqual(pickSeverity(3, 0.50, true, true), null);
  });

  test("H=0 confidence 0.99 → null", () => {
    assert.strictEqual(pickSeverity(0, 0.99, true, true), null);
  });
});

// ============================================================================
// confidence / normalization helpers
// ============================================================================

test.describe("scam-trade: confidence math", () => {
  test("normalizeSemDelta maps [-1, 1] to [0, 1]", () => {
    assert.strictEqual(normalizeSemDelta(-1), 0);
    assert.strictEqual(normalizeSemDelta(0), 0.5);
    assert.strictEqual(normalizeSemDelta(1), 1);
    // clamping
    assert.strictEqual(normalizeSemDelta(-5), 0);
    assert.strictEqual(normalizeSemDelta(5), 1);
  });

  test("computeConfidence is monotonic in H", () => {
    const lo = computeConfidence({ H: 0, semDelta: 0, headScore: null });
    const mid = computeConfidence({ H: 3, semDelta: 0, headScore: null });
    const hi = computeConfidence({ H: 5, semDelta: 0, headScore: null });
    assert.ok(lo < mid && mid < hi);
  });

  test("computeConfidence stays in [0, 1]", () => {
    const c = computeConfidence({ H: 999, semDelta: 999, headScore: 999 });
    assert.ok(c >= 0 && c <= 1);
    const c2 = computeConfidence({ H: -999, semDelta: -999, headScore: -999 });
    assert.ok(c2 >= 0 && c2 <= 1);
  });

  test("headScore null defaults to 0.5 weighting (not zero)", () => {
    const withNull = computeConfidence({ H: 3, semDelta: 0, headScore: null });
    const withHalf = computeConfidence({ H: 3, semDelta: 0, headScore: 0.5 });
    assert.strictEqual(withNull, withHalf);
  });
});

// ============================================================================
// META_OR_WARNING_RE — defense against false positives on discussions/reports
// ============================================================================

test.describe("scam-trade: meta/warning veto", () => {
  const META_TEXTS = [
    "someone is selling kicia in dms",
    "don't buy kicia from randoms",
    "is this allowed: selling kicia?",
    "people are trading kicia keys, be aware",
    "warning: a user was selling kicia yesterday",
    "report him, he's selling kicia"
  ];

  for (const text of META_TEXTS) {
    test(`meta: "${text}" → ignore`, async () => {
      const result = await classifyScamTrade(text);
      assert.strictEqual(result.verdict, "ignore");
      assert.match(result.reasonText, /meta|warning/i);
    });
  }
});

// ============================================================================
// Topical gate — non-kicia messages never reach the decision branch
// ============================================================================

test.describe("scam-trade: topical gate", () => {
  test("'selling fluxus dm me' → ignore (no kicia topic)", async () => {
    const result = await classifyScamTrade("selling fluxus dm me");
    assert.strictEqual(result.verdict, "ignore");
    assert.match(result.reasonText, /not.*topical|topic/i);
  });

  test("'wts hydrogen lifetime $5' → review (lifetime is ecosystem-noun topical)", async () => {
    // "lifetime" intentionally matches the broadened topic gate because on this
    // server it usually means a Kicia license. Selling ANY lifetime here is
    // commerce the staff want to see, so it goes to the training channel.
    const result = await classifyScamTrade("wts hydrogen lifetime $5");
    assert.notStrictEqual(result.verdict, "ignore");
  });
});

// ============================================================================
// teardown — restore original module state so other tests aren't affected
// ============================================================================

test.after(() => {
  exampleBanks.getBank = originalGetBank;
  embeddings.__resetForTests();
});
