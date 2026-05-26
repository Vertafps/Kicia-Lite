const { embedText, cosineSim } = require("./embeddings");
const { buildNormalizedTextForms } = require("./text");
const { recordRuntimeEvent } = require("./runtime-health");
const { scoreLogisticHead } = require("./inline-probe");

const _modCache = new Map();
function lazyMod(name) {
  if (!_modCache.has(name)) {
    try { _modCache.set(name, require(name)); }
    catch { _modCache.set(name, null); }
  }
  return _modCache.get(name);
}

function getSettingOrDefault(key, fallback) {
  const mod = lazyMod("./settings");
  if (!mod || typeof mod.getSetting !== "function") return fallback;
  try {
    const v = mod.getSetting(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function getBankVectors(bankName) {
  const mod = lazyMod("./example-banks");
  if (!mod || typeof mod.getBank !== "function") return null;
  try {
    const bank = mod.getBank(bankName);
    return Array.isArray(bank) && bank.length ? bank : null;
  } catch {
    return null;
  }
}

const FALLBACK_KICIA_ENTITIES = [
  "kicia",
  "kiciahook",
  "hook",
  "v2",
  "v3",
  "kicia hook",
  "kicia v2",
  "kicia v3"
];

const KICIA_ALIAS_RE = /kicia|kiciahook|hook|^v[23]$/i;

function buildEntityVocabularyFromKb(kb) {
  const kicia = new Set();
  const third = new Set();

  const aliasIndex = kb && kb.executorAliasIndex;
  if (aliasIndex && typeof aliasIndex === "object") {
    for (const alias of Object.keys(aliasIndex)) {
      const norm = String(alias || "").toLowerCase().trim();
      if (!norm) continue;
      if (KICIA_ALIAS_RE.test(norm)) {
        kicia.add(norm);
      } else {
        third.add(norm);
      }
    }
  }

  for (const a of FALLBACK_KICIA_ENTITIES) kicia.add(a);

  // prevent third-party set from shadowing a kicia alias if KB misclassifies
  for (const k of kicia) third.delete(k);

  return { kiciaEntities: kicia, thirdPartyEntities: third };
}

let _defaultVocab = null;
function getDefaultVocabulary() {
  if (!_defaultVocab) {
    _defaultVocab = buildEntityVocabularyFromKb(null);
  }
  return _defaultVocab;
}

const NEG_LEX = new Set([
  "trash", "dogshit", "mid", "ass", "buns", "garbage", "bad", "sucks", "sucked",
  "suck", "shit", "awful", "terrible", "horrible", "broken", "useless", "dead",
  "dying", "cooked", "scam", "fraud", "ripoff", "overrated", "slow", "laggy",
  "buggy", "unstable", "unreliable", "lame", "weak", "fucked", "fuckin"
]);

const POS_LEX = new Set([
  "good", "great", "goated", "fire", "peak", "clean", "smooth", "solid",
  "stable", "reliable", "fast", "snappy", "lit", "amazing", "awesome",
  "perfect", "godly", "op", "w", "dub", "legit", "trustworthy", "recommended",
  "best", "top", "supreme", "polished", "premium", "insane", "sick", "clutch",
  "cracked"
]);

const INTENSIFIER_RE = /\b(so+|really|literally|actually|fr|deadass|honestly|absolutely|completely)\b/i;
const NEGATION_RE = /\b(not|isn'?t|aren'?t|wasn'?t|weren'?t|never|no|barely|hardly|scarcely)\b/i;
const QUESTION_PATTERN_RE = /\?$|^\s*(is|are|does|do|did|why|how|when|what|where|who|which|can|could|should|will|would|may|might)\b/i;
const CONSTRUCTIVE_RE = /\b(wish|hope|should\s+add|could\s+add|would\s+be\s+nice|please\s+add|feature\s+request|suggestion|i'?d\s+love|if\s+it\s+had)\b/i;
const COPULA_RE = /\b(is|are|was|were|feels?|feel|seems?)\b/i;

// "v3 worse than v2", "kicia behind every exec", "v3 is bottom barrel"
const COMPARATIVE_NEG_RE = /\b(?:worse\s+than|behind|bottom\s+(?:of|tier|barrel)|worst|lowest)\b/i;
// "ue mogs kicia", "fluxus destroys kicia" — put-down verb with kicia as object
const COMPARATIVE_PUTDOWN_RE = /\b(mogs|smokes|destroys|cooks|outclasses|beats)\b/i;

function splitClauses(folded) {
  const source = String(folded || "").trim();
  if (!source) return [];

  const segments = source
    .split(/[.!?;,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length);

  const result = [];
  for (const seg of segments) {
    const subs = seg.split(/\s+(?:but|and|while|yet|though|however|whereas)\s+/i);
    for (const sub of subs) {
      if (sub.trim()) result.push(sub.trim());
    }
  }

  // soft-split run-on dual-copula sentences like "kicia is good ue is dogshit".
  // catches the no-punctuation counter-example by inserting a break before
  // the second subject when two "is/are" verbs appear with no conjunction.
  const dualSplit = [];
  for (const clause of result) {
    const m = clause.match(/^(\S+\s+(?:is|are|was|were)\s+\S+)\s+(\S+\s+(?:is|are|was|were)\s+.+)$/i);
    if (m) {
      dualSplit.push(m[1]);
      dualSplit.push(m[2]);
    } else {
      dualSplit.push(clause);
    }
  }

  // glue short tails ("but really") onto the prior clause to avoid stray polarity
  const merged = [];
  for (const clause of dualSplit) {
    const tokens = clause.split(/\s+/).filter(Boolean);
    if (tokens.length < 3 && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${clause}`;
    } else {
      merged.push(clause);
    }
  }

  return merged;
}

function firstEntityIndex(lower, entitySet) {
  let bestIdx = -1;
  let bestMatch = null;
  for (const e of entitySet) {
    if (!e) continue;
    const i = lower.indexOf(e);
    if (i !== -1 && (bestIdx === -1 || i < bestIdx)) {
      bestIdx = i;
      bestMatch = e;
    }
  }
  return { index: bestIdx, match: bestMatch };
}

function attributeClause(clause, vocab) {
  const v = vocab || getDefaultVocabulary();
  const lower = String(clause || "").toLowerCase();

  const kiciaHit = firstEntityIndex(lower, v.kiciaEntities);
  const tpHit = firstEntityIndex(lower, v.thirdPartyEntities);

  if (kiciaHit.index === -1 && tpHit.index === -1) return null;
  if (kiciaHit.index !== -1 && tpHit.index === -1) {
    return { entity: kiciaHit.match, isKicia: true };
  }
  if (kiciaHit.index === -1 && tpHit.index !== -1) {
    return { entity: tpHit.match, isKicia: false };
  }

  // both entities present: subject = whichever comes before the first copula
  const copulaIdx = lower.search(COPULA_RE);
  if (copulaIdx === -1) {
    return kiciaHit.index < tpHit.index
      ? { entity: kiciaHit.match, isKicia: true }
      : { entity: tpHit.match, isKicia: false };
  }

  const kiciaBeforeCopula = kiciaHit.index < copulaIdx;
  const tpBeforeCopula = tpHit.index < copulaIdx;

  if (kiciaBeforeCopula && !tpBeforeCopula) {
    return { entity: kiciaHit.match, isKicia: true };
  }
  if (!kiciaBeforeCopula && tpBeforeCopula) {
    return { entity: tpHit.match, isKicia: false };
  }

  return kiciaHit.index < tpHit.index
    ? { entity: kiciaHit.match, isKicia: true }
    : { entity: tpHit.match, isKicia: false };
}

function clauseLocalPolarity(clause) {
  // keep apostrophes so "isn't" survives for negation detection
  const tokens = String(clause || "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length);

  let negTokens = 0;
  let posTokens = 0;
  const polarityTokenIndices = [];
  for (let i = 0; i < tokens.length; i++) {
    const bareToken = tokens[i].replace(/^'+|'+$/g, "");
    if (NEG_LEX.has(bareToken)) {
      negTokens += 1;
      polarityTokenIndices.push({ i, polarity: -1 });
    }
    if (POS_LEX.has(bareToken)) {
      posTokens += 1;
      polarityTokenIndices.push({ i, polarity: 1 });
    }
  }

  const intens = INTENSIFIER_RE.test(clause);

  // negation applies if it's within 3 tokens before any polarity token
  let negation = false;
  for (const { i } of polarityTokenIndices) {
    const start = Math.max(0, i - 3);
    for (let j = start; j < i; j++) {
      if (NEGATION_RE.test(tokens[j])) {
        negation = true;
        break;
      }
    }
    if (negation) break;
  }

  const rawPol = posTokens - negTokens;
  const sign = rawPol > 0 ? 1 : rawPol < 0 ? -1 : 0;
  const polarity = sign * (1 + 0.5 * (intens ? 1 : 0)) * (negation ? -1 : 1);

  // inverted sarcasm: negation + intensifier + positive lex — routes to warn
  const sarcasmHint = (negation && intens && posTokens > 0);

  return { polarity, sarcasmHint, posTokens, negTokens, intens, negation };
}

// Detects implicit comparative disrespect:
//  - "v3 worse than v2", "kicia behind every exec"  → kicia placed under something
//  - "ue mogs kicia", "fluxus destroys kicia"        → non-kicia subject mogging kicia
// Returns the magnitude (0 if nothing fired) to bump kiciaNegMag.
function comparativeNegBoost(clause, vocab) {
  const lower = String(clause || "").toLowerCase();
  if (!lower) return 0;

  let boost = 0;
  const kiciaHit = firstEntityIndex(lower, vocab.kiciaEntities);

  // COMPARATIVE_NEG: requires a kicia entity within ~30 chars of the match
  const negMatch = lower.match(COMPARATIVE_NEG_RE);
  if (negMatch && kiciaHit.index !== -1) {
    const matchIdx = negMatch.index ?? lower.indexOf(negMatch[0]);
    if (matchIdx !== -1 && Math.abs(matchIdx - kiciaHit.index) <= 30) {
      boost += 0.5;
    }
  }

  // COMPARATIVE_PUTDOWN: kicia must be the OBJECT of the verb (verb appears
  // before the kicia entity in the clause). "kicia mogs ue" → no boost.
  const putdownMatch = lower.match(COMPARATIVE_PUTDOWN_RE);
  if (putdownMatch && kiciaHit.index !== -1) {
    const verbIdx = putdownMatch.index ?? lower.indexOf(putdownMatch[0]);
    if (verbIdx !== -1 && verbIdx < kiciaHit.index) {
      boost += 1;
    }
  }

  return boost;
}

function maxCos(vec, bankEntries) {
  if (!vec || !Array.isArray(bankEntries) || bankEntries.length === 0) return 0;
  let best = -Infinity;
  for (const entry of bankEntries) {
    const v = entry && entry.vector ? entry.vector : entry;
    if (!v) continue;
    const s = cosineSim(vec, v);
    if (s > best) best = s;
  }
  return Number.isFinite(best) ? best : 0;
}

async function computeSemDelta(folded, providedEmbedding) {
  const disrespectBank = getBankVectors("respect-disrespect");
  const neutralBank = getBankVectors("respect-neutral");

  if (!disrespectBank || !neutralBank) {
    return { semDelta: 0, vec: providedEmbedding || null, coldStart: true };
  }

  let vec = providedEmbedding || null;
  if (!vec) {
    try {
      vec = await embedText(folded);
    } catch (err) {
      recordRuntimeEvent("warn", "respect", `embed failed: ${err?.message || err}`);
      return { semDelta: 0, vec: null, coldStart: true };
    }
  }

  if (!vec) return { semDelta: 0, vec: null, coldStart: true };

  const disrespectMax = maxCos(vec, disrespectBank);
  const neutralMax = maxCos(vec, neutralBank);
  return { semDelta: disrespectMax - neutralMax, vec, coldStart: false };
}

const HEAD_CACHE_TTL_MS = 60_000;
let _headCache = { value: null, loadedAt: 0, fetching: null };

async function loadRespectHead() {
  const now = Date.now();
  if (_headCache.value !== null && now - _headCache.loadedAt < HEAD_CACHE_TTL_MS) {
    return _headCache.value;
  }
  if (_headCache.fetching) return _headCache.fetching;

  _headCache.fetching = (async () => {
    const emojiDb = lazyMod("./restricted-emoji-db");
    if (!emojiDb || typeof emojiDb.getDatabase !== "function") {
      _headCache = { value: null, loadedAt: now, fetching: null };
      return null;
    }
    try {
      const db = await emojiDb.getDatabase();
      if (!db) {
        _headCache = { value: null, loadedAt: now, fetching: null };
        return null;
      }
      const stmt = db.prepare("SELECT value FROM app_config WHERE key = ?");
      let raw = null;
      try {
        stmt.bind(["classifier.respect.head_v1"]);
        if (stmt.step()) raw = stmt.get()[0];
      } finally {
        stmt.free();
      }
      if (!raw) {
        _headCache = { value: null, loadedAt: now, fetching: null };
        return null;
      }
      const parsed = JSON.parse(String(raw));
      if (!parsed || !Array.isArray(parsed.W) || typeof parsed.b !== "number") {
        _headCache = { value: null, loadedAt: now, fetching: null };
        return null;
      }
      _headCache = { value: parsed, loadedAt: now, fetching: null };
      return parsed;
    } catch (err) {
      recordRuntimeEvent("warn", "respect.head", err?.message || err);
      _headCache = { value: null, loadedAt: now, fetching: null };
      return null;
    }
  })();

  return _headCache.fetching;
}

async function computeHeadScore(vec) {
  if (!vec) return null;
  const head = await loadRespectHead();
  if (!head) return null;
  try {
    const score = scoreLogisticHead(vec, head);
    return Number.isFinite(score) ? score : null;
  } catch (err) {
    recordRuntimeEvent("warn", "respect.head", err?.message || err);
    return null;
  }
}

function hasAnyKiciaEntityInText(text, vocab) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  for (const ent of vocab.kiciaEntities) {
    if (!ent) continue;
    if (ent.includes(" ")) {
      if (lower.indexOf(ent) !== -1) return true;
    } else {
      const re = new RegExp(`\\b${escapeReg(ent)}\\b`, "i");
      if (re.test(lower)) return true;
    }
  }
  return false;
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberOrDefault(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function ignoreResult(reason, embedding) {
  return {
    classifier: "respect",
    verdict: "ignore",
    severity: null,
    signals: {
      kiciaNegMag: 0,
      kiciaNegRatio: 0,
      semDisrespect: 0,
      headScore: null,
      question: false,
      constructive: false,
      sarcasm: false,
      confidence: 0,
      kiciaPosMag: 0
    },
    durationMs: null,
    reasonText: reason,
    attributedClauses: [],
    embedding: embedding || null
  };
}

function finalize(verdict, signals, attributedClauses, embedding, reasonText) {
  return {
    classifier: "respect",
    verdict,
    severity: null,
    signals,
    durationMs: null,
    reasonText,
    attributedClauses,
    embedding: embedding || null
  };
}

async function classifyKiciaDisrespect(text, options = {}) {
  const { member = null, userId: providedUserId = null, kb = null, embedding = null } = options || {};

  const vocab = kb ? buildEntityVocabularyFromKb(kb) : getDefaultVocabulary();

  // .folded preserves v3/v4; the leet-normalized form mangles them
  const forms = buildNormalizedTextForms(text);
  const folded = String(forms.folded || "").toLowerCase().trim();

  if (!folded) return ignoreResult("empty text", null);

  if (!hasAnyKiciaEntityInText(folded, vocab)) {
    return ignoreResult("no kicia entity in text", null);
  }

  const userId = providedUserId || member?.id || member?.user?.id || null;
  const permissions = lazyMod("./permissions");
  if (permissions && typeof permissions.hasModerationBypassMember === "function") {
    try {
      if (permissions.hasModerationBypassMember(member, userId)) {
        return ignoreResult("member has moderation bypass", null);
      }
    } catch {}
  }
  const emojiDb = lazyMod("./restricted-emoji-db");
  if (userId && emojiDb && typeof emojiDb.isModerationWhitelistedUser === "function") {
    try {
      if (await emojiDb.isModerationWhitelistedUser(userId)) {
        return ignoreResult("user is moderation-whitelisted", null);
      }
    } catch {}
  }

  const constructive = CONSTRUCTIVE_RE.test(folded);
  if (constructive) {
    return ignoreResult("constructive criticism / feature request", null);
  }

  const clauses = splitClauses(folded);
  const attributedClauses = [];
  let kiciaNegMag = 0;
  let kiciaPosMag = 0;
  let sarcasm = false;

  for (const clause of clauses) {
    const attribution = attributeClause(clause, vocab);
    const { polarity, sarcasmHint } = clauseLocalPolarity(clause);

    const entity = attribution ? attribution.entity : null;
    const isKicia = attribution ? Boolean(attribution.isKicia) : false;

    attributedClauses.push({ clause, entity, polarity, isKicia });

    if (isKicia) {
      if (polarity < 0) kiciaNegMag += Math.abs(polarity);
      if (polarity > 0) kiciaPosMag += Math.abs(polarity);
      if (sarcasmHint) sarcasm = true;
    }

    // Implicit comparative disrespect — fires even when the clause has no
    // direct neg-lex hit. Always feeds kiciaNegMag (these phrases are negative
    // toward kicia by construction, regardless of which entity the copula-based
    // attributor picked).
    const compBoost = comparativeNegBoost(clause, vocab);
    if (compBoost > 0) kiciaNegMag += compBoost;
  }

  const kiciaNegRatio = kiciaNegMag / (kiciaNegMag + kiciaPosMag + 1e-6);

  const { semDelta, vec: usedVec } = await computeSemDelta(folded, embedding);

  const headScore = await computeHeadScore(usedVec);

  // "!" / "!!" suppresses the question veto so exclamations aren't read as inquiries
  const trimmedRaw = String(text || "").trim();
  const exclamatory = trimmedRaw.endsWith("!") || trimmedRaw.includes("!!");
  const question = QUESTION_PATTERN_RE.test(folded.trim()) && !exclamatory;

  const semHighThreshold = numberOrDefault(getSettingOrDefault("respect.semantic.high", 0.20), 0.20);
  const semMedThreshold = numberOrDefault(getSettingOrDefault("respect.semantic.med", 0.10), 0.10);
  const headThreshold = numberOrDefault(getSettingOrDefault("respect.head.threshold", 0.65), 0.65);
  const firstOffenseConfidence = numberOrDefault(
    getSettingOrDefault("respect.firstoffense.confidence", 0.80),
    0.80
  );

  const kiciaSig = (kiciaNegMag >= 1) && (kiciaNegRatio >= 0.7);
  const semHigh = semDelta >= semHighThreshold;
  const semMed = semDelta >= semMedThreshold && semDelta < semHighThreshold;
  const headHigh = headScore !== null && headScore >= headThreshold;
  // We only reach this point past hasAnyKiciaEntityInText — so the text is
  // topical by construction. Named explicitly here so the head-driven branches
  // below read as the per-prompt rule.
  const topical = true;

  // Stepwise head bonus on top of the headHigh(0.25) component:
  //   - head >= 0.80: full +0.10 (very confident head)
  //   - head >= 0.70: +0.05  (confident but sub-very-high band — caught a
  //                            cluster of production missed-catches stranded
  //                            at conf 0.75-0.79, just under the 0.80 gate)
  //   - head <  0.70: no bonus
  // Verified against 7d FP data: no real false-positive has head >= 0.70
  // alongside kiciaSig + semMed, so this lift only affects true positives.
  let headBonus = 0;
  if (headScore != null && topical) {
    if (headScore >= 0.80) headBonus = 0.10;
    else if (headScore >= 0.70) headBonus = 0.05;
  }
  let confidence =
    (kiciaSig ? 0.35 : 0) +
    (semHigh ? 0.30 : (semMed ? 0.15 : 0)) +
    (headHigh ? 0.25 : ((headScore ?? 0) * 0.25)) +
    headBonus +
    (kiciaNegRatio >= 0.8 ? 0.05 : 0);
  confidence = clamp(confidence, 0, 1);

  const signals = {
    kiciaNegMag,
    kiciaNegRatio,
    semDisrespect: semDelta,
    headScore,
    question,
    constructive,
    sarcasm,
    confidence,
    kiciaPosMag
  };

  // Counter-example guard: when Kicia is being praised OR the negativity is
  // clearly aimed at a non-kicia entity, attribution lies elsewhere. We bail
  // to "ignore" entirely (no warn, no timeout) so praise + third-party-neg
  // messages never produce moderation noise.
  const kiciaPraised = (signals.kiciaPosMag || 0) > (signals.kiciaNegMag || 0);
  const thirdPartyNeg = attributedClauses.some(
    (c) => c && !c.isKicia && (c.polarity || 0) < 0
  );
  const counterExample = kiciaPraised || thirdPartyNeg;

  // Three-level verdict:
  //   ignore  - no signals or counter-example
  //   warn    - signals fire but confidence below firstOffenseConfidence
  //             (handler will delete message + DM warn + staff log)
  //   timeout - confidence >= firstOffenseConfidence and not counter-example
  //             (handler will delete + DM + actual mute, severity by tier state)

  // Vetoes
  //
  // Question form normally vetoes — interrogatives ("is kicia broken?",
  // "why is kicia so slow") are usually genuine questions, not disrespect.
  // BUT rhetorical-disrespect questions ("why is kicia such trash", "is
  // kicia even alive anymore") DO appear in production-confirmed positives
  // that the bot ignored. We release the veto when the trained head is
  // *very* confident (>=0.80) AND the local pattern fires — the only path
  // that escapes is one where two independent signals (high-confidence
  // head + neg-lex regex on a kicia-attributed clause) converge. Pure
  // head-alone or pure pattern-alone still vetoes; this only releases
  // when both fire strongly.
  const headVeryHigh = headScore != null && headScore >= 0.80;
  const questionEscape = (kiciaSig && semHigh) || (kiciaSig && headVeryHigh);
  if (question && !questionEscape) {
    return finalize("ignore", signals, attributedClauses, usedVec, "question form without converging signals");
  }
  if (sarcasm) {
    return finalize("warn", signals, attributedClauses, usedVec, "sarcasm hint - never auto-timeout");
  }

  // Counter-example: praise or third-party-neg attribution. Suppresses BOTH
  // timeout and warn since the negativity is not actually aimed at kicia.
  if (counterExample) {
    return finalize("ignore", signals, attributedClauses, usedVec, "counter-example (praise or third-party negativity)");
  }

  // Primary timeout gate: confidence. If the overall confidence — built from
  // pattern + semantic + trained head + ratio — clears the first-offense
  // threshold, timeout.
  if (confidence >= firstOffenseConfidence) {
    return finalize("timeout", signals, attributedClauses, usedVec, `first-offense confidence (${confidence.toFixed(2)})`);
  }

  // Below the timeout gate but still flag-worthy: route to warn.
  if (kiciaSig && semHigh) {
    return finalize("warn", signals, attributedClauses, usedVec, "pattern + semantic (sub-threshold)");
  }
  if (kiciaSig || semHigh) {
    return finalize("warn", signals, attributedClauses, usedVec, kiciaSig ? "pattern alone" : "semantic alone");
  }
  if (semMed && kiciaNegMag >= 0.5) {
    return finalize("warn", signals, attributedClauses, usedVec, "semantic medium + some pattern");
  }
  if (headHigh) {
    return finalize("warn", signals, attributedClauses, usedVec, "head says disrespect (sub-threshold)");
  }

  return finalize("ignore", signals, attributedClauses, usedVec, "no signals converged");
}

function __resetForTests() {
  _modCache.clear();
  _defaultVocab = null;
  _headCache = { value: null, loadedAt: 0, fetching: null };
}

function resetHeadCache() {
  _headCache = { value: null, loadedAt: 0, fetching: null };
}

module.exports = {
  classifyKiciaDisrespect,
  buildEntityVocabularyFromKb,
  resetHeadCache,
  __resetForTests,
  __internals: {
    splitClauses,
    attributeClause,
    clauseLocalPolarity,
    computeSemDelta,
    hasAnyKiciaEntityInText,
    loadRespectHead,
    computeHeadScore,
    NEG_LEX,
    POS_LEX,
    INTENSIFIER_RE,
    NEGATION_RE,
    QUESTION_PATTERN_RE,
    CONSTRUCTIVE_RE,
    COPULA_RE,
    COMPARATIVE_NEG_RE,
    COMPARATIVE_PUTDOWN_RE,
    comparativeNegBoost,
    FALLBACK_KICIA_ENTITIES,
    KICIA_ALIAS_RE
  }
};
