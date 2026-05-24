const { embedText, cosineSim } = require("./embeddings");
const { getBank } = require("./example-banks");
const { buildNormalizedTextForms } = require("./text");
const { scoreLogisticHead } = require("./inline-probe");
const { recordRuntimeEvent } = require("./runtime-health");

const PRICE_OR_PAYMENT_RE = /\b(?:\$\s*\d+|\d+\s*(?:usd|eur|gbp|dollars?|bucks?|robux|rbx)|cashapp|paypal|crypto|btc|eth|ltc|gift\s*card|venmo|zelle)\b/i;
const SELLER_RE = /\b(sell(?:ing|s)?|sold|wts|for\s+sale|taking\s+offers?|vendor|plug|trade|trading|swap(?:ping)?|exchange|exchanging|lf\s*(?:trade|swap))\b/i;
const BUYER_RE = /\b(buy(?:ing|s)?|bought|wtb|lf|looking\s+(?:to\s+buy|for)|where.{0,20}(?:buy|get|purchase|find|download)|how.{0,15}(?:much|to\s+(?:buy|get)|do\s+i\s+(?:buy|get)))\b/i;
const DM_RE = /\b(dm\s*me|pm\s*me|msg\s*me|message\s*me|go\s+private|in\s+dms?|hmu)\b/i;
const KICIA_TOPIC_RE = /\b(kicia|kiciahook|hook|v[23]|configs?|keys?|licenses?|lifetimes?|premiums?|subs?|subscriptions?|cracked\s+kicia)\b/i;
const META_OR_WARNING_RE = /\b(?:do\s+not|don't|dont|stop|avoid|warning|warn|report|reported|allowed|against\s+rules?|not\s+allowed|is\s+this|is\s+that|someone|somebody|user|person|people|they|he|she)\b.{0,80}\b(?:sell|selling|buy|buying|trade|trading|scam|prohibited|illegal)\b/i;

const DEFAULTS = {
  firstOffenseConfidence: 0.92,
  semanticDelta: 0.18,
  headThreshold: 0.78,
  newAccountBump: 0.05,
  lightTimeoutMs: 60 * 60 * 1000,
  mediumTimeoutMs: 12 * 60 * 60 * 1000,
  severeTimeoutMs: 24 * 60 * 60 * 1000,
  newAccountDays: 30,
  newMemberDays: 7
};

let _settingsModule = null;
let _settingsResolved = false;

function getSettingsModule() {
  if (_settingsResolved) return _settingsModule;
  _settingsResolved = true;
  try {
    _settingsModule = require("./settings");
  } catch {
    _settingsModule = null;
  }
  return _settingsModule;
}

function readSetting(key, fallback) {
  const mod = getSettingsModule();
  if (!mod || typeof mod.getSetting !== "function") return fallback;
  try {
    const value = mod.getSetting(key);
    return value == null ? fallback : value;
  } catch {
    return fallback;
  }
}

const HEAD_CACHE_TTL_MS = 60_000;
let _head = null;
let _headLoadedAt = 0;
let _headAttempted = false;

function readAppConfigValue(db, key) {
  if (!db || typeof db.prepare !== "function") return null;
  let stmt;
  try {
    stmt = db.prepare("SELECT value FROM app_config WHERE key = ?");
  } catch {
    return null;
  }
  try {
    stmt.bind([key]);
    if (!stmt.step()) return null;
    const row = stmt.get();
    return row && row.length ? row[0] : null;
  } catch {
    return null;
  } finally {
    try { stmt.free(); } catch {}
  }
}

async function getScamHead() {
  const now = Date.now();
  if (_headAttempted && now - _headLoadedAt < HEAD_CACHE_TTL_MS) return _head;
  _headAttempted = true;
  _headLoadedAt = now;

  let dbModule;
  try {
    dbModule = require("./restricted-emoji-db");
  } catch (err) {
    recordRuntimeEvent("warn", "scam-head", `db require failed - ${err?.message || err}`);
    _head = null;
    return null;
  }

  if (typeof dbModule.getDatabase !== "function") {
    _head = null;
    return null;
  }

  let db;
  try {
    db = await dbModule.getDatabase();
  } catch (err) {
    recordRuntimeEvent("warn", "scam-head", `db open failed - ${err?.message || err}`);
    _head = null;
    return null;
  }

  const raw = readAppConfigValue(db, "classifier.scam.head_v1");
  if (!raw) {
    _head = null;
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    recordRuntimeEvent("warn", "scam-head", `parse failed - ${err?.message || err}`);
    _head = null;
    return null;
  }

  if (!parsed || !Array.isArray(parsed.W) || typeof parsed.b !== "number") {
    _head = null;
    return null;
  }

  _head = {
    W: parsed.W.map((v) => Number(v) || 0),
    b: Number(parsed.b) || 0,
    version: parsed.version || null,
    trainedAt: parsed.trainedAt || null,
    n: parsed.n || null
  };
  return _head;
}

function computeDirectionScore(text) {
  const sellerHit = SELLER_RE.exec(text);
  const buyerHit = BUYER_RE.exec(text);
  const topicHit = KICIA_TOPIC_RE.exec(text);
  if (sellerHit && topicHit && Math.abs(sellerHit.index - topicHit.index) <= 40) return +2;
  if (sellerHit && topicHit) return +1;
  if (buyerHit && !sellerHit) return -2;
  return 0;
}

function maxCosine(vec, bank) {
  if (!vec || !Array.isArray(bank) || !bank.length) return null;
  let best = -1;
  for (const entry of bank) {
    if (!entry || !entry.vector) continue;
    const c = cosineSim(vec, entry.vector);
    if (c > best) best = c;
  }
  return best === -1 ? null : best;
}

function computeSemDelta(vec) {
  const sellBank = getBank("scam-sell");
  const buyBank = getBank("scam-buy");
  if (!vec || !sellBank || !buyBank) {
    return { semDelta: 0, available: false, semSell: null, semBuy: null };
  }
  const semSell = maxCosine(vec, sellBank);
  const semBuy = maxCosine(vec, buyBank);
  if (semSell == null || semBuy == null) {
    return { semDelta: 0, available: false, semSell, semBuy };
  }
  return {
    semDelta: semSell - semBuy,
    available: true,
    semSell,
    semBuy
  };
}

function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function normalizeSemDelta(semDelta) {
  const clamped = clamp(semDelta, -1, 1);
  return (clamped + 1) / 2;
}

function computeConfidence({ H, semDelta, headScore }) {
  const hComponent = clamp(H / 5, 0, 1) * 0.7;
  const semComponent = normalizeSemDelta(semDelta) * 0.15;
  const headComponent = (headScore == null ? 0.5 : clamp(headScore, 0, 1)) * 0.15;
  return clamp(hComponent + semComponent + headComponent, 0, 1);
}

function pickSeverity(H, confidence, priceHit, dmHit) {
  if (H >= 4 && confidence >= 0.98 && priceHit && dmHit) return "severe";
  if (H >= 4 && confidence >= 0.95 && confidence < 0.98) return "medium";
  if (H === 3 && confidence >= 0.92 && confidence < 0.95) return "light";
  // boundary fallback: keep the lightest legal tier if no exact tier matched
  if (H === 3 && confidence >= 0.92) return "light";
  if (H >= 4 && confidence >= 0.92 && confidence < 0.95) return "light";
  return null;
}

function severityTimeoutMs(severity) {
  if (severity === "light") {
    return Number(readSetting("scam.severity.light.timeout", DEFAULTS.lightTimeoutMs)) || DEFAULTS.lightTimeoutMs;
  }
  if (severity === "medium") {
    return Number(readSetting("scam.severity.medium.timeout", DEFAULTS.mediumTimeoutMs)) || DEFAULTS.mediumTimeoutMs;
  }
  if (severity === "severe") {
    return Number(readSetting("scam.severity.severe.timeout", DEFAULTS.severeTimeoutMs)) || DEFAULTS.severeTimeoutMs;
  }
  return null;
}

function buildReasonText({
  verdict,
  severity,
  directionScore,
  priceHit,
  dmHit,
  topicHit,
  semDelta,
  semAvailable,
  headScore,
  H,
  confidence,
  bankCold
}) {
  const parts = [];
  if (verdict === "timeout") {
    parts.push(`auto-timeout (${severity}) - H=${H} - conf=${confidence.toFixed(2)}`);
  } else if (verdict === "review") {
    parts.push(`review (training-channel) - H=${H} - conf=${confidence.toFixed(2)}`);
  } else {
    parts.push(`ignore - H=${H} - conf=${confidence.toFixed(2)}`);
  }
  parts.push(`direction=${directionScore >= 0 ? "+" : ""}${directionScore}`);
  if (priceHit) parts.push("price/payment");
  if (dmHit) parts.push("dm-solicit");
  if (topicHit) parts.push("kicia-topical");
  if (semAvailable) {
    parts.push(`sem=${semDelta >= 0 ? "+" : ""}${semDelta.toFixed(3)}`);
  } else if (bankCold) {
    parts.push("sem=cold");
  }
  if (headScore != null) parts.push(`head=${headScore.toFixed(3)}`);
  return parts.join(" - ");
}

function emptySignals() {
  return {
    directionScore: 0,
    patternScore: 0,
    priceHit: false,
    dmHit: false,
    topicHit: false,
    semDelta: 0,
    headScore: null,
    confidence: 0,
    H: 0
  };
}

function buildResult({ verdict, severity, signals, durationMs, reasonText, embedding }) {
  return {
    classifier: "scam",
    verdict,
    severity,
    signals,
    durationMs,
    reasonText,
    embedding: embedding || null
  };
}

function buildIgnore({ reasonText, signals, embedding }) {
  return buildResult({
    verdict: "ignore",
    severity: null,
    signals,
    durationMs: null,
    reasonText,
    embedding: embedding || null
  });
}

const NOOP_RESULT = Object.freeze({
  classifier: "scam",
  verdict: "ignore",
  severity: null,
  signals: Object.freeze({
    directionScore: 0,
    patternScore: 0,
    priceHit: false,
    dmHit: false,
    topicHit: false,
    semDelta: 0,
    headScore: null,
    confidence: 0,
    H: 0
  }),
  durationMs: null,
  reasonText: "ignore - empty text",
  embedding: null
});

async function classifyScamTrade(text, options = {}) {
  const raw = String(text || "");
  if (!raw.trim()) return NOOP_RESULT;

  const forms = buildNormalizedTextForms(raw);
  const folded = forms.folded || raw;

  if (META_OR_WARNING_RE.test(folded)) {
    return buildIgnore({
      reasonText: "ignore - meta/warning",
      signals: emptySignals(),
      embedding: options.embedding || null
    });
  }

  const directionScore = computeDirectionScore(folded);
  const priceHit = PRICE_OR_PAYMENT_RE.test(folded);
  const dmHit = DM_RE.test(folded);
  const topicHit = KICIA_TOPIC_RE.test(folded);
  const buyerVeto = directionScore <= -1;

  if (!topicHit) {
    return buildIgnore({
      reasonText: "ignore - not kicia-topical",
      signals: {
        directionScore,
        patternScore: 0,
        priceHit,
        dmHit,
        topicHit: false,
        semDelta: 0,
        headScore: null,
        confidence: 0,
        H: 0
      },
      embedding: options.embedding || null
    });
  }

  if (buyerVeto) {
    return buildIgnore({
      reasonText: "ignore - buyer veto",
      signals: {
        directionScore,
        patternScore: 0,
        priceHit,
        dmHit,
        topicHit,
        semDelta: 0,
        headScore: null,
        confidence: 0,
        H: 0
      },
      embedding: options.embedding || null
    });
  }

  let vec = options.embedding || null;
  const sellBank = getBank("scam-sell");
  const buyBank = getBank("scam-buy");
  const banksWarm = Boolean(sellBank && buyBank);

  if (banksWarm && !vec) {
    try {
      vec = await embedText(forms.normalized || folded);
    } catch (err) {
      recordRuntimeEvent("warn", "scam-embed", err?.message || err);
      vec = null;
    }
  }

  const sem = banksWarm && vec
    ? computeSemDelta(vec)
    : { semDelta: 0, available: false, semSell: null, semBuy: null };

  let semDelta = sem.semDelta;
  if (sem.available) {
    const newAccountBump = Number(readSetting("scam.newaccount.bump", DEFAULTS.newAccountBump)) || 0;
    if (newAccountBump > 0) {
      const newAccountDays = Number(readSetting("link.new-account.days", DEFAULTS.newAccountDays)) || DEFAULTS.newAccountDays;
      const newAccountMs = newAccountDays * 86_400_000;
      if (Number.isFinite(options.accountAgeMs) && options.accountAgeMs >= 0
          && options.accountAgeMs < newAccountMs) {
        semDelta += newAccountBump;
      }
      const newMemberDays = Number(readSetting("link.new-member.days", DEFAULTS.newMemberDays)) || DEFAULTS.newMemberDays;
      const newMemberMs = newMemberDays * 86_400_000;
      if (Number.isFinite(options.memberAgeMs) && options.memberAgeMs >= 0
          && options.memberAgeMs < newMemberMs) {
        semDelta += newAccountBump;
      }
    }
  }

  // head is trained on minilm embeddings, only meaningful when we have a vector
  const head = vec ? await getScamHead() : null;
  let headScore = null;
  if (vec && head) {
    try {
      headScore = scoreLogisticHead(vec, head);
    } catch (err) {
      recordRuntimeEvent("warn", "scam-head-score", err?.message || err);
      headScore = null;
    }
  }

  const semanticDeltaThreshold = Number(readSetting("scam.semantic.delta", DEFAULTS.semanticDelta));
  const headThreshold = Number(readSetting("scam.head.threshold", DEFAULTS.headThreshold));

  const sigDirection = directionScore >= 2 ? 1 : 0;
  const sigPrice = priceHit ? 1 : 0;
  const sigDm = dmHit ? 1 : 0;
  const sigSem = sem.available && semDelta >= semanticDeltaThreshold ? 1 : 0;
  const sigHead = headScore != null && headScore >= headThreshold ? 1 : 0;

  const H = sigDirection + sigPrice + sigDm + sigSem + sigHead;
  const patternScore = sigDirection + sigPrice + sigDm + (topicHit ? 1 : 0);
  const confidence = computeConfidence({ H, semDelta, headScore });

  const signals = {
    directionScore,
    patternScore,
    priceHit,
    dmHit,
    topicHit,
    semDelta: sem.available ? semDelta : 0,
    headScore,
    confidence,
    H
  };

  const firstOffenseConfidence = Number(readSetting(
    "scam.firstoffense.confidence",
    DEFAULTS.firstOffenseConfidence
  ));

  if (H >= 3 && directionScore >= 2 && confidence >= firstOffenseConfidence) {
    const severity = pickSeverity(H, confidence, priceHit, dmHit);
    if (severity) {
      const durationMs = severityTimeoutMs(severity);
      return buildResult({
        verdict: "timeout",
        severity,
        signals,
        durationMs,
        reasonText: buildReasonText({
          verdict: "timeout",
          severity,
          directionScore,
          priceHit,
          dmHit,
          topicHit,
          semDelta,
          semAvailable: sem.available,
          headScore,
          H,
          confidence,
          bankCold: !banksWarm
        }),
        embedding: vec
      });
    }
  }

  if (H >= 2 && topicHit) {
    return buildResult({
      verdict: "review",
      severity: null,
      signals,
      durationMs: null,
      reasonText: buildReasonText({
        verdict: "review",
        severity: null,
        directionScore,
        priceHit,
        dmHit,
        topicHit,
        semDelta,
        semAvailable: sem.available,
        headScore,
        H,
        confidence,
        bankCold: !banksWarm
      }),
      embedding: vec
    });
  }

  if (H === 1 && directionScore >= 1) {
    return buildResult({
      verdict: "review",
      severity: null,
      signals,
      durationMs: null,
      reasonText: buildReasonText({
        verdict: "review",
        severity: null,
        directionScore,
        priceHit,
        dmHit,
        topicHit,
        semDelta,
        semAvailable: sem.available,
        headScore,
        H,
        confidence,
        bankCold: !banksWarm
      }),
      embedding: vec
    });
  }

  return buildResult({
    verdict: "ignore",
    severity: null,
    signals,
    durationMs: null,
    reasonText: buildReasonText({
      verdict: "ignore",
      severity: null,
      directionScore,
      priceHit,
      dmHit,
      topicHit,
      semDelta,
      semAvailable: sem.available,
      headScore,
      H,
      confidence,
      bankCold: !banksWarm
    }),
    embedding: vec
  });
}

function __resetForTests() {
  _head = null;
  _headLoadedAt = 0;
  _headAttempted = false;
  _settingsModule = null;
  _settingsResolved = false;
}

module.exports = {
  classifyScamTrade,
  __resetForTests,
  __internals: {
    computeDirectionScore,
    computeSemDelta,
    computeConfidence,
    pickSeverity,
    severityTimeoutMs,
    normalizeSemDelta,
    getScamHead,
    readSetting,
    DEFAULTS,
    SELLER_RE,
    BUYER_RE,
    KICIA_TOPIC_RE,
    DM_RE,
    PRICE_OR_PAYMENT_RE,
    META_OR_WARNING_RE
  }
};
