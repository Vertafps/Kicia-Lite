"use strict";

/**
 * Kicia disrespect classifier with clause-local target attribution.
 *
 * The defining requirement (owner's explicit counter-example):
 *   "kicia is good ue is dogshit" -> ignore
 * because the negative sentiment is attributed to `ue`, NOT `kicia`.
 *
 * Pipeline:
 *   1. Normalize via buildNormalizedTextForms (we use .folded — case-folded,
 *      confusable-mapped — but NOT the leet-normalized form, since leet
 *      mangles "v3"/"v4" tokens).
 *   2. Entity prefilter: must mention some Kicia entity, else short-circuit
 *      to ignore (avoids the embedding call on unrelated chatter).
 *   3. Bypass: staff/whitelisted users always ignore.
 *   4. Constructive veto: feature wishes never count as disrespect.
 *   5. Split into clauses on punctuation + coordinating conjunctions, then
 *      attribute each clause to a subject entity (kicia vs third-party).
 *   6. Sum |polarity| only over kicia-attributed clauses.
 *   7. Semantic delta = max cos(vec, DISRESPECT_BANK) - max cos(vec, NEUTRAL_BANK).
 *   8. Head signal (optional, cold-start safe): logistic regression score.
 *   9. Decision rule per the plan — kiciaSig + semHigh + headHigh -> timeout,
 *      partial overlap -> review, question / sarcasm / construct -> ignore/review.
 *
 * Severity + duration are intentionally NOT decided here. The moderation
 * handler looks up the respect_tier_state and picks tier/duration from the
 * configured `respect.timeout` / `respect.tier2.timeout` / `respect.tier3.timeout`
 * settings.
 */

const { embedText, cosineSim } = require("./embeddings");
const { buildNormalizedTextForms } = require("./text");
const { recordRuntimeEvent } = require("./runtime-health");
const { scoreLogisticHead } = require("./inline-probe");

// ---------------------------------------------------------------------------
// Lazy optional deps. Settings, example-banks, permissions, and the emoji db
// all live in modules that may or may not be loaded yet depending on import
// order — we tolerate any of them missing and fall back to safe defaults.
// ---------------------------------------------------------------------------

let _settingsModule = undefined;
function tryGetSettings() {
  if (_settingsModule === undefined) {
    try {
      _settingsModule = require("./settings");
    } catch {
      _settingsModule = null;
    }
  }
  return _settingsModule;
}

function getSettingOrDefault(key, fallback) {
  const mod = tryGetSettings();
  if (!mod || typeof mod.getSetting !== "function") return fallback;
  try {
    const v = mod.getSetting(key);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

let _banksModule = undefined;
function tryGetBanks() {
  if (_banksModule === undefined) {
    try {
      _banksModule = require("./example-banks");
    } catch {
      _banksModule = null;
    }
  }
  return _banksModule;
}

function getBankVectors(bankName) {
  const mod = tryGetBanks();
  if (!mod || typeof mod.getBank !== "function") return null;
  try {
    const bank = mod.getBank(bankName);
    if (!bank || !Array.isArray(bank) || bank.length === 0) return null;
    return bank;
  } catch {
    return null;
  }
}

let _permissionsModule = undefined;
function tryGetPermissions() {
  if (_permissionsModule === undefined) {
    try {
      _permissionsModule = require("./permissions");
    } catch {
      _permissionsModule = null;
    }
  }
  return _permissionsModule;
}

let _emojiDbModule = undefined;
function tryGetEmojiDb() {
  if (_emojiDbModule === undefined) {
    try {
      _emojiDbModule = require("./restricted-emoji-db");
    } catch {
      _emojiDbModule = null;
    }
  }
  return _emojiDbModule;
}

// ---------------------------------------------------------------------------
// Entity vocabulary
// ---------------------------------------------------------------------------

const FALLBACK_KICIA_ENTITIES = [
  "kicia",
  "kiciahook",
  "hook",
  "v3",
  "v4",
  "kicia hook",
  "kicia v3",
  "kicia v4"
];

const KICIA_ALIAS_RE = /kicia|kiciahook|hook|^v[34]$/i;

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

  // ensure the fallback kicia tokens are always present so the prefilter
  // doesn't miss a bare "kicia" mention even on a stripped KB.
  for (const a of FALLBACK_KICIA_ENTITIES) kicia.add(a);

  // defensive: prevent kicia/tp overlap so a misclassified KB alias can't
  // shadow attribution.
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

// ---------------------------------------------------------------------------
// Lexicons
// ---------------------------------------------------------------------------

const NEG_LEX = new Set([
  "trash", "dogshit", "mid", "ass", "buns", "garbage", "bad", "sucks", "sucked",
  "suck", "shit", "awful", "terrible", "horrible", "broken", "useless", "dead",
  "dying", "cooked", "scam", "fraud", "ripoff", "overrated", "slow", "laggy",
  "buggy", "unstable", "unreliable", "lame", "weak", "aids", "ratio", "fucked",
  "fuckin"
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
const QUESTION_PATTERN_RE = /\?$|^\s*(is|are|does|do|why|how|when|what|can|could|should|will|would)\b/i;
const CONSTRUCTIVE_RE = /\b(wish|hope|should\s+add|could\s+add|would\s+be\s+nice|please\s+add|feature\s+request|suggestion|i'?d\s+love|if\s+it\s+had)\b/i;
const COPULA_RE = /\b(is|are|was|were|feels?|feel|seems?)\b/i;

// ---------------------------------------------------------------------------
// Clause splitting
// ---------------------------------------------------------------------------

function splitClauses(folded) {
  const source = String(folded || "").trim();
  if (!source) return [];

  // primary split on punctuation
  const segments = source
    .split(/[.!?;,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length);

  // secondary split on coordinating conjunctions
  const result = [];
  for (const seg of segments) {
    const subs = seg.split(/\s+(?:but|and|while|yet|though|however|whereas)\s+/i);
    for (const sub of subs) {
      if (sub.trim()) result.push(sub.trim());
    }
  }

  // merge clauses shorter than 3 tokens into the preceding clause — keeps
  // fragments like "but really" from carrying spurious polarity.
  const merged = [];
  for (const clause of result) {
    const tokens = clause.split(/\s+/).filter(Boolean);
    if (tokens.length < 3 && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${clause}`;
    } else {
      merged.push(clause);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Per-clause target attribution
// ---------------------------------------------------------------------------

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

  // both present — pick the subject by looking at the first copula.
  // whichever entity occurs before the copula is the grammatical subject.
  const copulaIdx = lower.search(COPULA_RE);
  if (copulaIdx === -1) {
    // no copula — pick first occurrence
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

  // both or neither before copula — pick the closer to the start
  return kiciaHit.index < tpHit.index
    ? { entity: kiciaHit.match, isKicia: true }
    : { entity: tpHit.match, isKicia: false };
}

// ---------------------------------------------------------------------------
// Clause-local polarity
// ---------------------------------------------------------------------------

function clauseLocalPolarity(clause) {
  // tokenize while preserving apostrophes so contractions like "isn't" stay
  // as single tokens (the NEGATION_RE matches both "isn't" and "isnt").
  const tokens = String(clause || "")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length);

  let negTokens = 0;
  let posTokens = 0;
  const polarityTokenIndices = [];
  for (let i = 0; i < tokens.length; i++) {
    // strip a stray leading/trailing apostrophe so POS_LEX / NEG_LEX lookups
    // still match (apostrophes are kept in the token list only to keep
    // contractions intact for negation detection).
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

  // negation applies if NEGATION_RE matches any of the tokens within 3
  // tokens BEFORE a polarity token. we test each token individually so
  // contractions ("isn't") and bare forms ("not", "never") both match.
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

  // sarcasm hint per the spec formula: the classic inverted form — negation
  // + intensifier over a positive lexicon. routes to review (never auto-
  // timeouts) so staff judges. avoids flagging plain compliments like
  // "kicia is so good" which would happen under a looser definition.
  const sarcasmHint = (negation && intens && posTokens > 0);

  return { polarity, sarcasmHint, posTokens, negTokens, intens, negation };
}

// ---------------------------------------------------------------------------
// Semantic signal
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Trained-head lookup. cached for 60s. db query is best-effort — any failure
// reverts to null so the head signal is simply dropped from the ensemble.
// ---------------------------------------------------------------------------

const HEAD_CACHE_TTL_MS = 60_000;
let _headCache = { value: null, loadedAt: 0, fetching: null };

async function loadRespectHead() {
  const now = Date.now();
  if (_headCache.value !== null && now - _headCache.loadedAt < HEAD_CACHE_TTL_MS) {
    return _headCache.value;
  }
  if (_headCache.fetching) return _headCache.fetching;

  _headCache.fetching = (async () => {
    const emojiDb = tryGetEmojiDb();
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasAnyKiciaEntityInText(text, vocab) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  for (const ent of vocab.kiciaEntities) {
    if (!ent) continue;
    // word-boundary check so "hook" doesn't fire on "hooked", but multi-word
    // entities like "kicia hook" use plain indexOf (already implicitly bounded).
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

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

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
    severity: null,            // tier resolved by moderation handler
    signals,
    durationMs: null,          // duration resolved by moderation handler
    reasonText,
    attributedClauses,
    embedding: embedding || null
  };
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

async function classifyKiciaDisrespect(text, options = {}) {
  const { member = null, userId: providedUserId = null, kb = null, embedding = null } = options || {};

  // build vocabulary from kb if provided, otherwise reuse cached fallback
  const vocab = kb ? buildEntityVocabularyFromKb(kb) : getDefaultVocabulary();

  // normalize. we use .folded (case-folded + confusable-mapped) — not the
  // leet-normalized form, which would mangle "v3"/"v4" entity tokens.
  const forms = buildNormalizedTextForms(text);
  const folded = String(forms.folded || "").toLowerCase().trim();

  if (!folded) return ignoreResult("empty text", null);

  // prefilter: must mention a kicia entity at all (cheap exit, no embed)
  if (!hasAnyKiciaEntityInText(folded, vocab)) {
    return ignoreResult("no kicia entity in text", null);
  }

  // bypass: staff and moderation-whitelisted users always ignore
  const userId = providedUserId || member?.id || member?.user?.id || null;
  const permissions = tryGetPermissions();
  if (permissions && typeof permissions.hasModerationBypassMember === "function") {
    try {
      if (permissions.hasModerationBypassMember(member, userId)) {
        return ignoreResult("member has moderation bypass", null);
      }
    } catch { /* ignore */ }
  }
  const emojiDb = tryGetEmojiDb();
  if (userId && emojiDb && typeof emojiDb.isModerationWhitelistedUser === "function") {
    try {
      if (await emojiDb.isModerationWhitelistedUser(userId)) {
        return ignoreResult("user is moderation-whitelisted", null);
      }
    } catch { /* ignore */ }
  }

  // constructive veto — feature requests / wishes never count as disrespect
  const constructive = CONSTRUCTIVE_RE.test(folded);
  if (constructive) {
    return ignoreResult("constructive criticism / feature request", null);
  }

  // clause-level attribution + polarity
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
  }

  const kiciaNegRatio = kiciaNegMag / (kiciaNegMag + kiciaPosMag + 1e-6);

  // semantic signal — one embed call (reused for head scoring).
  const { semDelta, vec: usedVec } = await computeSemDelta(folded, embedding);

  // head signal — optional. cold-start safe: returns null if no head trained.
  const headScore = await computeHeadScore(usedVec);

  // question detection. a trailing "!" or any "!!" anywhere suppresses the
  // question veto since emphatic exclamations aren't inquiries.
  const trimmedRaw = String(text || "").trim();
  const exclamatory = trimmedRaw.endsWith("!") || trimmedRaw.includes("!!");
  const question = QUESTION_PATTERN_RE.test(folded.trim()) && !exclamatory;

  // thresholds (live owner-tunable)
  const semHighThreshold = numberOrDefault(getSettingOrDefault("respect.semantic.high", 0.20), 0.20);
  const semMedThreshold = numberOrDefault(getSettingOrDefault("respect.semantic.med", 0.10), 0.10);
  const headThreshold = numberOrDefault(getSettingOrDefault("respect.head.threshold", 0.78), 0.78);

  const kiciaSig = (kiciaNegMag >= 1) && (kiciaNegRatio >= 0.7);
  const semHigh = semDelta >= semHighThreshold;
  const semMed = semDelta >= semMedThreshold && semDelta < semHighThreshold;
  const headHigh = headScore !== null && headScore >= headThreshold;

  // confidence per the plan: weighted sum of signal contributions, clamped 0..1.
  let confidence =
    (kiciaSig ? 0.4 : 0) +
    (semHigh ? 0.3 : (semMed ? 0.15 : 0)) +
    (headHigh ? 0.2 : ((headScore ?? 0) * 0.2)) +
    (kiciaNegRatio >= 0.8 ? 0.1 : 0);
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

  // decision rule — order matters. questions and sarcasm veto auto-timeout
  // even if other signals fire; constructive was handled earlier.
  //
  // question veto: simple inquiry forms ("is v3 bad now?") should not
  // surface even when a single negative lexicon hit gives kiciaSig. require
  // BOTH pattern AND semantic to converge before letting question-form
  // disrespect ("why is kicia such absolute trash garbage?") through.
  if (question && !(kiciaSig && semHigh)) {
    return finalize("ignore", signals, attributedClauses, usedVec, "question form without converging signals");
  }
  if (sarcasm) {
    return finalize("review", signals, attributedClauses, usedVec, "sarcasm hint — never auto-timeout");
  }
  if (kiciaSig && semHigh && headHigh) {
    return finalize("timeout", signals, attributedClauses, usedVec, "all three signals high");
  }
  if (kiciaSig && semHigh) {
    return finalize("review", signals, attributedClauses, usedVec, "pattern + semantic high (no head)");
  }
  if (kiciaSig || semHigh) {
    return finalize(
      "review",
      signals,
      attributedClauses,
      usedVec,
      kiciaSig ? "pattern high alone" : "semantic high alone"
    );
  }
  if (semMed && kiciaNegMag >= 0.5) {
    return finalize("review", signals, attributedClauses, usedVec, "semantic medium + some pattern");
  }
  return finalize("ignore", signals, attributedClauses, usedVec, "no signals converged");
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

function __resetForTests() {
  _settingsModule = undefined;
  _banksModule = undefined;
  _permissionsModule = undefined;
  _emojiDbModule = undefined;
  _defaultVocab = null;
  _headCache = { value: null, loadedAt: 0, fetching: null };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  classifyKiciaDisrespect,
  buildEntityVocabularyFromKb,
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
    FALLBACK_KICIA_ENTITIES,
    KICIA_ALIAS_RE
  }
};
