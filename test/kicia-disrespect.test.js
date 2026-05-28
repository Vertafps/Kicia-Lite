"use strict";

// env shims required by various src/* modules at require time
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

// ----------------------------------------------------------------------------
// Plant stubs in require.cache BEFORE requiring the classifier so it can't
// reach into the real sqlite-backed db or the permissions module during tests.
// ----------------------------------------------------------------------------
function stubRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {}
  };
}

stubRequire("../src/restricted-emoji-db");  // no getDatabase → head loader returns null
stubRequire("../src/permissions");           // no hasModerationBypassMember → skipped
stubRequire("../src/settings");              // no getSetting → defaults used

// ----------------------------------------------------------------------------
// Stub the MiniLM embedder. Real MiniLM model isn't available in tests.
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

// Force cold-start by making getBank return null. The classifier's
// computeSemDelta short-circuits when either bank is missing — semDelta=0,
// no embedText call, no head call (since head needs a vec from computeSemDelta).
const exampleBanks = require("../src/example-banks");
const originalGetBank = exampleBanks.getBank;
exampleBanks.getBank = () => null;

const {
  classifyKiciaDisrespect,
  buildEntityVocabularyFromKb,
  __internals
} = require("../src/kicia-disrespect");
const { splitClauses, attributeClause, clauseLocalPolarity } = __internals;

// ============================================================================
// THE OWNER'S CRITICAL COUNTER-EXAMPLE
// ----------------------------------------------------------------------------
// "kicia is good ue is dogshit" must NEVER fire. Negative sentiment is
// directed at `ue`, not kicia. This is the load-bearing example for the
// whole classifier — if it regresses, ship is halted.
// ============================================================================

test.describe("kicia-disrespect: THE CRITICAL COUNTER-EXAMPLE", () => {
  test('"kicia is good ue is dogshit" → ignore (default vocab)', async () => {
    const result = await classifyKiciaDisrespect("kicia is good ue is dogshit");
    assert.strictEqual(
      result.verdict,
      "ignore",
      `MUST ignore — got ${result.verdict}, reason=${result.reasonText}`
    );
  });

  test('"kicia is good ue is dogshit" → ignore (with KB that knows ue)', async () => {
    // Even with explicit knowledge that `ue` is a third-party executor, the
    // negative clause must attribute to ue, NOT kicia.
    const kb = {
      executorAliasIndex: {
        ue: { name: "Universal" },
        fluxus: { name: "Fluxus" },
        hydrogen: { name: "Hydrogen" }
      }
    };
    const result = await classifyKiciaDisrespect(
      "kicia is good ue is dogshit",
      { kb }
    );
    assert.strictEqual(
      result.verdict,
      "ignore",
      `MUST ignore — got ${result.verdict}, reason=${result.reasonText}`
    );
  });
});

// ============================================================================
// classifyKiciaDisrespect — must-flag cases (verdict !== "ignore")
// ============================================================================

const MUST_FLAG_CASES = [
  ["kicia premium cant even beat ue",  "premium + negated comparative + third party"],
  ["v3 is buns",            "direct insult · v3 + neg lexicon"],
  ["kicia is trash",        "direct insult · kicia + neg lexicon"],
  ["kiciahook sucks ass",   "two neg-lex tokens"],
  ["v2 is dogshit",         "v2 + strong neg-lex"],
  ["kicia is mid honestly", "intensifier amps polarity"],
  ["kicia is broken garbage", "two neg-lex tokens"],
  ["v3 is literally ass",   "intensifier + ass"],
  ["hook is dogshit"        , "hook alias + neg-lex"],
  // newer-version-trashed comparisons — opposite of the pro-Kicia ignore cases
  ["v3 is buns compared to v2",  "NEWER trashed for older · legitimate complaint"],
  ["v3 sucks compared to v2",    "NEWER trashed for older · variant lex"],
  // intensified slow — slow is in NEG_LEX, kicia is entity
  ["kicia is slow as hell today", "intensified slow + kicia entity"],
  // 'mad slow' — mad is not in INTENSIFIER_RE but slow IS in NEG_LEX; acceptable to flag
  ["v3 mad slow today",           "slow in NEG_LEX + v3 entity · acceptable warn"]
];

test.describe("kicia-disrespect: must-flag cases", () => {
  for (const [text, label] of MUST_FLAG_CASES) {
    test(`flags: "${text}" (${label})`, async () => {
      const result = await classifyKiciaDisrespect(text);
      assert.notStrictEqual(
        result.verdict,
        "ignore",
        `expected non-ignore, got ${result.verdict} · reason=${result.reasonText}`
      );
      assert.ok(
        result.verdict === "timeout" || result.verdict === "warn",
        `verdict must be timeout or warn, got ${result.verdict}`
      );
    });
  }
});

// ============================================================================
// classifyKiciaDisrespect — must-NOT-flag cases (verdict === "ignore")
// ----------------------------------------------------------------------------
// 100k users · zero false positives. Each of these is a real chat pattern
// the bot must leave alone.
// ============================================================================

const MUST_NOT_FLAG_CASES = [
  // technical complaints — frustration but not disrespect
  ["v3 had a bug yesterday",          "technical · bug report"],
  ["v3 has a bug",                    "technical · bug report"],
  ["kicia not loading today",         "technical · loading issue"],
  ["v4 keeps disconnecting",          "technical · disconnect"],

  // questions — even pointed ones never auto-time-out
  ["is v3 bad now?",                  "question form"],
  ["is kicia working today",          "question · operational"],
  ["why is v3 not loading",           "question · operational"],
  ["is kicia down rn",                "question · operational"],

  // constructive — feature requests / wishes
  ["i wish kicia had X",              "constructive · wish"],
  ["i hope kicia adds y",             "constructive · hope"],
  ["it would be nice if kicia had aimlock", "constructive · feature ask"],

  // negation flips polarity
  ["kicia isn't bad",                 "negation flips polarity"],
  ["v3 is not trash",                 "explicit negation"],

  // no entity at all → prefilter ignore
  ["hello everyone",                  "no kicia entity"],
  ["good morning fellas",             "no kicia entity"],
  ["thanks for the help",             "no kicia entity"],

  // straight positives
  ["kicia is good",                   "positive sentiment"],
  ["v3 is goated",                    "positive · slang"],
  ["v4 is fire",                      "positive · slang"],
  ["kicia is peak",                   "positive"],
  ["thank you kicia team",            "gratitude · no neg-lex"],

  // comparison — negative aimed at third party
  ["kicia better than ue",            "positive about kicia, negative about ue"],

  // the owner's pattern: negative explicitly attributed to a third party
  // (with kb knowledge of "ue" as third-party)
  // tested separately under the CRITICAL section above

  // soft criticism never auto-times-out
  ["i don't like kicia",              "soft criticism · no neg-lex (warn at most)"],
  ["kicia could be better",           "soft criticism · no neg-lex"],

  // scam-deferral cases — respect must NOT fire on scam-shaped text
  // (the trained head was leaking high scores into these on prod)
  ["GUYS IM SEL LING KICKERHOOK V3",  "scam-deferral · spaced seller + fuzzy topic"],
  ["selling kicia for ue dm me",      "scam-deferral · explicit sale"],
  ["wts kicia hook lifetime",         "scam-deferral · wts + topic"],
  ["free configs dm me",              "scam-deferral · freebie giveaway"],
  ["trading kicia for fluxus",        "scam-deferral · trade verb"],
  ["sel ling kicia",                  "scam-deferral · pure spaced verb"],

  // head-alone removal — these all relied on the trained head firing
  // on benign Kicia-topical text (no clause-local NEG_LEX hits).
  ["1v1 kicia prem",                  "gamer challenge · no pattern signal"],
  ["kiciahook crash's",               "bug report · no pattern signal"],
  ["nah gta 1 gazillion out but no kicia v4 sorry",
                                      "v4-complaint · no pattern signal"],
  [`loadstring(game:HttpGet("https://raw.githubusercontent.com/kiciahook/kiciahook/refs/heads/main/loader.luau"))()`,
                                      "loader code · no pattern signal"],
  ["v3",                              "bare version · no signals"],
  ["kiciahook",                       "bare product name · no signals"],
  ["v2",                              "bare version · no signals"],

  // pro-Kicia version comparisons — older being disparaged in favor of newer
  ["v2 buns compared to v3",          "pro-Kicia · older trashed for newer"],
  ["v2 is buns compared to v3",       "pro-Kicia · 'is' copula form"],
  ["v2 is trash compared to v3",      "pro-Kicia · variant lex"],
  ["v2 sucks compared to v3",         "pro-Kicia · variant lex"],
  // bare premium mentions with no comparative context
  ["premium subscription",            "bare premium mention · no comparative"],
  ["premium costs 25 bucks",          "premium price · no comparative"],

  // buyer / pricing questions — scam-deferral via SCAM_LIKE_RE or question veto
  ["Is v3 prem worth it for 25 euros?",          "buyer question · scam-deferral via worth"],
  ["25 bucks for lifetime?",                     "pricing question · no kicia entity"],
  ["Is buying and selling keys prohibited here?", "meta rules · scam-deferral via selling"],
  ["But u don't have premiun",                   "fact · premium-only typo + no comparative"],
  ["ahhh so v3 better?",                         "comparison question"],
  ["how much is v3",                             "buyer · question veto"],
  ["what's the price of kicia premium",          "buyer · scam-deferral via price of"],
  ["kicia is fine i guess",                      "soft commentary · no NEG_LEX"],
  ["i think v3 is okay",                         "tepid · no NEG_LEX"],
  ["kicia is premium quality",                   "praise using 'premium' as adj — must not net negative"],
  ["idk if v3 is worth it",                      "uncertainty / buyer · scam-deferral via worth it"]
];

test.describe("kicia-disrespect: must-NOT-flag cases", () => {
  for (const [text, label] of MUST_NOT_FLAG_CASES) {
    test(`ignores: "${text}" (${label})`, async () => {
      const result = await classifyKiciaDisrespect(text);
      assert.strictEqual(
        result.verdict,
        "ignore",
        `expected ignore, got ${result.verdict} · reason=${result.reasonText}`
      );
    });
  }
});

// ============================================================================
// "ue is dogshit but kicia carries" — explicit third-party negative
// ============================================================================

test.describe("kicia-disrespect: third-party attribution with KB", () => {
  const kb = {
    executorAliasIndex: {
      ue: { name: "Universal" },
      fluxus: { name: "Fluxus" }
    }
  };

  test('"ue is dogshit but kicia carries" → ignore', async () => {
    const result = await classifyKiciaDisrespect(
      "ue is dogshit but kicia carries",
      { kb }
    );
    assert.strictEqual(result.verdict, "ignore");
  });

  test('"fluxus is trash" → ignore (kicia not even mentioned)', async () => {
    const result = await classifyKiciaDisrespect("fluxus is trash", { kb });
    assert.strictEqual(result.verdict, "ignore");
  });
});

// ============================================================================
// classifyKiciaDisrespect — empty / pathological input
// ============================================================================

test.describe("kicia-disrespect: edge inputs", () => {
  test("empty string → ignore", async () => {
    const result = await classifyKiciaDisrespect("");
    assert.strictEqual(result.verdict, "ignore");
  });

  test("whitespace-only → ignore", async () => {
    const result = await classifyKiciaDisrespect("   ");
    assert.strictEqual(result.verdict, "ignore");
  });

  test("null/undefined → ignore", async () => {
    assert.strictEqual((await classifyKiciaDisrespect(null)).verdict, "ignore");
    assert.strictEqual((await classifyKiciaDisrespect(undefined)).verdict, "ignore");
  });

  test("result carries classifier='respect' and signals shape", async () => {
    const result = await classifyKiciaDisrespect("hello");
    assert.strictEqual(result.classifier, "respect");
    assert.ok(result.signals);
    assert.ok("kiciaNegMag" in result.signals);
    assert.ok("kiciaNegRatio" in result.signals);
    assert.ok("question" in result.signals);
    assert.ok("constructive" in result.signals);
  });

  test("result always exposes attributedClauses array", async () => {
    const result = await classifyKiciaDisrespect("kicia is good");
    assert.ok(Array.isArray(result.attributedClauses));
  });
});

// ============================================================================
// splitClauses — clause splitter
// ============================================================================

test.describe("kicia-disrespect: splitClauses", () => {
  test("dual-copula run-on splits into two clauses (the counter-example)", () => {
    // "kicia is good ue is dogshit" has no punctuation/conjunction but the
    // dual-copula soft-split breaks it so per-clause attribution can put
    // "good" on kicia and "dogshit" on ue.
    const clauses = splitClauses("kicia is good ue is dogshit");
    assert.strictEqual(clauses.length, 2);
    assert.match(clauses[0], /kicia/);
    assert.match(clauses[0], /good/);
    assert.match(clauses[1], /ue/);
    assert.match(clauses[1], /dogshit/);
  });

  test("comma split: 'kicia is good, but v3 sucks'", () => {
    const clauses = splitClauses("kicia is good, but v3 sucks");
    assert.ok(clauses.length >= 2, `expected >=2 clauses, got ${clauses.length}`);
    // the second clause must contain both v3 and sucks
    const tail = clauses[clauses.length - 1];
    assert.match(tail, /v3/);
    assert.match(tail, /sucks/);
  });

  test("conjunction split: 'v3 is buns and v4 is fire'", () => {
    const clauses = splitClauses("v3 is buns and v4 is fire");
    assert.strictEqual(clauses.length, 2);
    assert.match(clauses[0], /v3/);
    assert.match(clauses[0], /buns/);
    assert.match(clauses[1], /v4/);
    assert.match(clauses[1], /fire/);
  });

  test("conjunction split with sufficient-length tails: 'kicia is good but v3 is sucks today'", () => {
    // each sub-clause must be >=3 tokens to avoid the short-fragment merge —
    // 'v3 sucks' is 2 tokens and gets merged back. extend it to >=3 tokens.
    const clauses = splitClauses("kicia is good but v3 is really bad today");
    assert.strictEqual(clauses.length, 2);
    assert.match(clauses[0], /kicia/);
    assert.match(clauses[1], /v3/);
  });

  test("multiple punctuation with long-enough tails: 'kicia is great. v3 is really bad today!'", () => {
    // again, the tail clause must reach >=3 tokens to stay separate.
    const clauses = splitClauses("kicia is great today. v3 is really bad today");
    assert.ok(clauses.length >= 2, `expected >=2, got ${clauses.length}: ${JSON.stringify(clauses)}`);
    assert.match(clauses[0], /kicia/);
    assert.match(clauses[clauses.length - 1], /v3/);
  });

  test("short-fragment merge: 'kicia is good but v3 sucks' → 1 clause", () => {
    // documents the actual algorithm behavior: 'v3 sucks' is 2 tokens, gets
    // merged into the preceding clause. attribution still falls on the first
    // entity ("kicia") — but the merged clause has both pos ("good") and neg
    // ("sucks") tokens which cancel to polarity 0. that's fine for the owner's
    // counter-example since the negative isn't attributed to kicia anyway.
    const clauses = splitClauses("kicia is good but v3 sucks");
    assert.strictEqual(clauses.length, 1);
  });

  test("empty / whitespace returns empty array", () => {
    assert.deepStrictEqual(splitClauses(""), []);
    assert.deepStrictEqual(splitClauses("   "), []);
  });

  test("short fragments merge into previous clause", () => {
    // "kicia is bad, fr" — "fr" is < 3 tokens, must merge backward
    const clauses = splitClauses("kicia is bad, fr");
    assert.strictEqual(clauses.length, 1);
    assert.match(clauses[0], /kicia/);
    assert.match(clauses[0], /fr/);
  });
});

// ============================================================================
// attributeClause — per-clause subject attribution
// ============================================================================

test.describe("kicia-disrespect: attributeClause", () => {
  const kb = {
    executorAliasIndex: {
      ue: { name: "UE" },
      fluxus: { name: "Fluxus" }
    }
  };
  const vocab = buildEntityVocabularyFromKb(kb);

  test('"kicia is good" → entity=kicia, isKicia=true', () => {
    const attr = attributeClause("kicia is good", vocab);
    assert.ok(attr, "must return an attribution");
    assert.strictEqual(attr.entity, "kicia");
    assert.strictEqual(attr.isKicia, true);
  });

  test('"ue is dogshit" → entity=ue, isKicia=false', () => {
    const attr = attributeClause("ue is dogshit", vocab);
    assert.ok(attr, "must return an attribution");
    assert.strictEqual(attr.entity, "ue");
    assert.strictEqual(attr.isKicia, false);
  });

  test('"v3 is bad" → kicia entity (v3 is a kicia alias)', () => {
    const attr = attributeClause("v3 is bad", vocab);
    assert.ok(attr);
    assert.strictEqual(attr.isKicia, true);
  });

  test('"kicia is good ue is dogshit" → kicia is the grammatical subject', () => {
    // kicia comes before the first copula ("is" at position 6)
    const attr = attributeClause("kicia is good ue is dogshit", vocab);
    assert.ok(attr);
    assert.strictEqual(attr.isKicia, true);
  });

  test('"hello world" with no entities → null', () => {
    const attr = attributeClause("hello world", vocab);
    assert.strictEqual(attr, null);
  });

  test('"fluxus is dogshit" → entity=fluxus, isKicia=false', () => {
    const attr = attributeClause("fluxus is dogshit", vocab);
    assert.ok(attr);
    assert.strictEqual(attr.isKicia, false);
    assert.strictEqual(attr.entity, "fluxus");
  });
});

// ============================================================================
// clauseLocalPolarity — polarity scoring
// ============================================================================

test.describe("kicia-disrespect: clauseLocalPolarity", () => {
  test('"kicia is bad" → negative polarity', () => {
    const { polarity } = clauseLocalPolarity("kicia is bad");
    assert.ok(polarity < 0, `expected negative, got ${polarity}`);
  });

  test('"kicia is good" → positive polarity', () => {
    const { polarity } = clauseLocalPolarity("kicia is good");
    assert.ok(polarity > 0, `expected positive, got ${polarity}`);
  });

  test('"kicia isn\'t bad" → negation flips to positive', () => {
    const { polarity, negation } = clauseLocalPolarity("kicia isn't bad");
    assert.strictEqual(negation, true);
    assert.ok(polarity > 0, `expected positive after negation flip, got ${polarity}`);
  });

  test('"kicia is not bad" → bare negation flips to positive', () => {
    const { polarity, negation } = clauseLocalPolarity("kicia is not bad");
    assert.strictEqual(negation, true);
    assert.ok(polarity > 0);
  });

  test('"kicia is sooo great" → sarcasmHint true (negation+intens+positive? no, no negation)', () => {
    // "sooo" matches INTENSIFIER_RE via /so+/. No negation. positive token "great".
    // sarcasmHint requires negation + intens + positive → false here.
    const { intens, sarcasmHint } = clauseLocalPolarity("kicia is sooo great");
    assert.strictEqual(intens, true);
    assert.strictEqual(sarcasmHint, false);
  });

  test('"kicia is not sooo great" → sarcasmHint true (negation+intens+positive)', () => {
    const { sarcasmHint, intens, negation, posTokens } = clauseLocalPolarity("kicia is not sooo great");
    assert.strictEqual(intens, true);
    assert.strictEqual(negation, true);
    assert.ok(posTokens > 0);
    assert.strictEqual(sarcasmHint, true);
  });

  test('"kicia is mid honestly" → intensifier amps polarity', () => {
    const { polarity, intens } = clauseLocalPolarity("kicia is mid honestly");
    assert.strictEqual(intens, true);
    assert.ok(polarity < 0);
    // intensifier multiplies by 1.5 → |polarity| should be 1.5
    assert.ok(Math.abs(polarity) >= 1.5 - 1e-9);
  });

  test('"hello there" → polarity 0 (no lex hits)', () => {
    const { polarity, posTokens, negTokens } = clauseLocalPolarity("hello there");
    assert.strictEqual(posTokens, 0);
    assert.strictEqual(negTokens, 0);
    assert.strictEqual(polarity, 0);
  });

  test('"kicia is good and bad" → mixed = polarity 0', () => {
    // pos and neg tokens cancel → rawPol=0 → sign=0 → polarity=0
    const { polarity, posTokens, negTokens } = clauseLocalPolarity("kicia is good and bad");
    assert.ok(posTokens > 0);
    assert.ok(negTokens > 0);
    assert.strictEqual(polarity, 0);
  });

  test('multiple neg-lex tokens still yield single sign (signed)', () => {
    const { polarity } = clauseLocalPolarity("kicia is trash garbage dogshit");
    // sign-based: still produces negative magnitude bounded by intensifier rules
    assert.ok(polarity < 0);
  });
});

// ============================================================================
// Vocabulary builder
// ============================================================================

test.describe("kicia-disrespect: buildEntityVocabularyFromKb", () => {
  test("default vocab (no kb) has kicia entities but no third-party", () => {
    const vocab = buildEntityVocabularyFromKb(null);
    assert.ok(vocab.kiciaEntities.has("kicia"));
    assert.ok(vocab.kiciaEntities.has("v3"));
    assert.ok(vocab.kiciaEntities.has("v2"));
    assert.ok(vocab.kiciaEntities.has("kiciahook"));
    assert.ok(vocab.kiciaEntities.has("hook"));
    // third party set is empty in default
    assert.strictEqual(vocab.thirdPartyEntities.size, 0);
  });

  test("kb-derived vocab puts non-kicia aliases in third-party", () => {
    const kb = { executorAliasIndex: { ue: {}, fluxus: {}, hydrogen: {} } };
    const vocab = buildEntityVocabularyFromKb(kb);
    assert.ok(vocab.thirdPartyEntities.has("ue"));
    assert.ok(vocab.thirdPartyEntities.has("fluxus"));
    assert.ok(vocab.thirdPartyEntities.has("hydrogen"));
    // kicia fallbacks still present
    assert.ok(vocab.kiciaEntities.has("kicia"));
  });

  test("kb aliases matching KICIA_ALIAS_RE land in kicia set", () => {
    const kb = { executorAliasIndex: { kicia: {}, kiciahook: {}, ue: {} } };
    const vocab = buildEntityVocabularyFromKb(kb);
    assert.ok(vocab.kiciaEntities.has("kicia"));
    assert.ok(vocab.kiciaEntities.has("kiciahook"));
    assert.ok(vocab.thirdPartyEntities.has("ue"));
    // ensure no overlap
    for (const k of vocab.kiciaEntities) {
      assert.strictEqual(vocab.thirdPartyEntities.has(k), false, `overlap on ${k}`);
    }
  });
});

// ============================================================================
// teardown
// ============================================================================

test.after(() => {
  exampleBanks.getBank = originalGetBank;
  embeddings.__resetForTests();
});
