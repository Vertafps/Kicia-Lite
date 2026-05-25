const { embedText, cosineSim } = require("./embeddings");
const { getBank } = require("./example-banks");
const { buildNormalizedTextForms } = require("./text");
const { scoreLogisticHead } = require("./inline-probe");
const { recordRuntimeEvent } = require("./runtime-health");

const PRICE_OR_PAYMENT_RE = /\b(?:\$\s*\d+|\d+\s*(?:usd|eur|gbp|dollars?|bucks?|robux|rbx)|cashapp|paypal|crypto|btc|eth|ltc|usdt|solana|sol|bnb|xrp|gift\s*card|steam\s*g(?:ift\s*card|c)|amazon\s*gc|roblox\s*gc|nitro|venmo|zelle|western\s*union|\bwu\b|moneygram)\b/i;
const CASHAPP_TAG_RE = /\bcashapp\b[\s\S]{0,20}\$\w+|\$\w+[\s\S]{0,20}\bcashapp\b/i;
const SELLER_RE = /\b(sell(?:ing|s)?|sold|wts|for\s+sale|taking\s+offers?|vendor|plug|trade|trading|swap(?:ping)?|exchange|exchanging|lf\s*(?:trade|swap)|vouch(?:es|ed)?|going\s+first|gf\s+(?:only|rep)|tos\s+(?:first|required)|t\.?o\.?s\.?\s+first)\b/i;
const TRUSTED_SELLER_RE = /\btrusted(?:\s+seller)?\b/i;
const MIDDLEMAN_RE = /\b(?:middleman|mm)\b/i;
const BUYER_RE = /\b(buy(?:ing|s)?|bought|wtb|lf|looking\s+(?:to\s+buy|for)|where.{0,20}(?:buy|get|purchase|find|download)|how.{0,15}(?:much|to\s+(?:buy|get)|do\s+i\s+(?:buy|get)))\b/i;
const DM_RE = /\b(dm\s*me|pm\s*me|msg\s*me|message\s*me|go\s+private|in\s+dms?|hmu|slide\s+in(?:to)?\s+(?:my\s+)?dms?|msg\s+me\s+asap|pm\s+asap|dm\s+urgent|inbox\s+me)\b/i;
const KICIA_TOPIC_RE = /\b(kicia|kiciahook|hook|v[23]|configs?|keys?|licenses?|lifetimes?|premiums?|subs?|subscriptions?|cracked\s+kicia)\b/i;
const META_OR_WARNING_RE = /\b(?:do\s+not|don't|dont|stop|avoid|warning|warn|report|reported|allowed|against\s+rules?|not\s+allowed|is\s+this|is\s+that|someone|somebody|user|person|people|they|he|she)\b.{0,80}\b(?:sell|selling|buy|buying|trade|trading|scam|prohibited|illegal)\b/i;
const JOKE_RE = /\b(?:\/s|\/jk|jk|jking|joking|kidding|kiddin|not\s+srs|not\s+serious|sarcasm|sarcastic)\b|\(jk\)|\(joking\)|\(kidding\)|\blmao\b/i;

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

const NEW_ACCOUNT_MS = 7 * 24 * 3600_000;
const NEW_MEMBER_MS = 24 * 3600_000;

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

// collapse spaced-letter runs like "s e l l i n g" into "selling". Requires
// 4+ consecutive single-char tokens so natural text ("a b test") never matches.
function densifyObfuscated(text) {
  return String(text || "").replace(/\b\w(?:\s+\w\b){3,}/g, (match) => match.replace(/\s+/g, ""));
}

// substring topic check for the densified form — word boundaries don't survive
// the collapse so we look for kicia-ecosystem nouns inside concatenated runs.
const TOPIC_SUBSTRINGS = ["kicia", "kiciahook", "config", "license", "lifetime", "premium", "subscription", "cracked"];

function topicHitInDense(dense) {
  if (!dense) return false;
  for (const needle of TOPIC_SUBSTRINGS) {
    if (dense.includes(needle)) return true;
  }
  return false;
}

function anyHit(re, folded, dense) {
  if (re.test(folded)) return { hit: true, viaDense: false };
  if (dense && dense !== folded && re.test(dense)) return { hit: true, viaDense: true };
  return { hit: false, viaDense: false };
}

function commerceContext(folded, dense) {
  return PRICE_OR_PAYMENT_RE.test(folded) || PRICE_OR_PAYMENT_RE.test(dense)
    || CASHAPP_TAG_RE.test(folded) || CASHAPP_TAG_RE.test(dense)
    || DM_RE.test(folded) || DM_RE.test(dense);
}

function sellerSignal(folded, dense) {
  const direct = anyHit(SELLER_RE, folded, dense);
  if (direct.hit) return direct;
  // "trusted" / "middleman" / "mm" only count as seller signals when there's
  // commerce context nearby — bare words are too noisy in normal chat.
  const hasCommerce = commerceContext(folded, dense);
  if (!hasCommerce) return { hit: false, viaDense: false };
  if (TRUSTED_SELLER_RE.test(folded)) return { hit: true, viaDense: false };
  if (TRUSTED_SELLER_RE.test(dense)) return { hit: true, viaDense: true };
  if (MIDDLEMAN_RE.test(folded)) return { hit: true, viaDense: false };
  if (MIDDLEMAN_RE.test(dense)) return { hit: true, viaDense: true };
  return { hit: false, viaDense: false };
}

function detectJokeMarker(folded, dense) {
  if (JOKE_RE.test(folded)) return true;
  if (dense && dense !== folded && JOKE_RE.test(dense)) return true;
  return false;
}

function isNewAccount(accountAgeMs) {
  return Number.isFinite(accountAgeMs) && accountAgeMs >= 0 && accountAgeMs < NEW_ACCOUNT_MS;
}

function isNewMember(memberAgeMs) {
  return Number.isFinite(memberAgeMs) && memberAgeMs >= 0 && memberAgeMs < NEW_MEMBER_MS;
}

function computeDirectionScore(text, denseText) {
  const dense = denseText == null ? densifyObfuscated(text) : denseText;
  const seller = sellerSignal(text, dense);
  const buyerHit = BUYER_RE.exec(text);
  let topicHit = KICIA_TOPIC_RE.exec(text);
  if (!topicHit && dense !== text) topicHit = KICIA_TOPIC_RE.exec(dense);
  // dense substring fallback — word boundaries don't survive run collapse
  if (!topicHit && dense !== text && topicHitInDense(dense)) {
    topicHit = { index: 0 };
  }
  if (seller.hit && topicHit) {
    const sellerRef = SELLER_RE.exec(text)
      || (dense !== text ? SELLER_RE.exec(dense) : null)
      || TRUSTED_SELLER_RE.exec(text)
      || MIDDLEMAN_RE.exec(text);
    if (sellerRef && Math.abs(sellerRef.index - topicHit.index) <= 40) return +2;
    return +1;
  }
  if (buyerHit && !seller.hit) return -2;
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

const SEVERITY_LADDER = [null, "light", "medium", "severe"];

function bumpSeverity(severity, steps) {
  if (!steps) return severity;
  const idx = SEVERITY_LADDER.indexOf(severity);
  if (idx < 0) return severity;
  const next = Math.min(SEVERITY_LADDER.length - 1, Math.max(0, idx + steps));
  return SEVERITY_LADDER[next];
}

function pickSeverity(H, confidence, signalsOrPriceHit, dmHitOrOptions, maybeOptions) {
  // legacy: pickSeverity(H, conf, priceHit, dmHit) — keep the old confidence
  // ladder so existing tests + callers that haven't migrated still work.
  if (typeof signalsOrPriceHit === "boolean") {
    const priceHit = !!signalsOrPriceHit;
    const dmHit = !!dmHitOrOptions;
    const opts = maybeOptions || {};
    const newAccount = !!opts.isNewAccount;
    const repeat = !!opts.repeatOffender;
    let base = null;
    if (H >= 4 && confidence >= 0.98 && priceHit && dmHit) base = "severe";
    else if (H >= 4 && confidence >= 0.95 && confidence < 0.98) base = "medium";
    else if (H === 3 && confidence >= 0.92 && confidence < 0.95) base = "light";
    else if (H === 3 && confidence >= 0.92) base = "light";
    else if (H >= 4 && confidence >= 0.92 && confidence < 0.95) base = "light";
    if (!base) return null;
    if (newAccount) base = bumpSeverity(base, 1);
    if (repeat) base = bumpSeverity(base, 1);
    return base;
  }

  const signals = signalsOrPriceHit || {};
  const options = dmHitOrOptions || {};
  const priceHit = !!signals.priceHit;
  const dmHit = !!signals.dmHit;
  const directionScore = Number(signals.directionScore) || 0;
  const newAccount = !!options.isNewAccount;
  const repeat = !!options.repeatOffender;

  let base = null;
  if (H >= 4 && priceHit && dmHit && directionScore >= 2) {
    if (confidence >= 0.95 || newAccount) base = "severe";
    else base = "medium";
  } else if (H >= 3 && priceHit && dmHit) {
    base = "medium";
  } else if (H >= 3) {
    base = "light";
  } else if ((H === 2 && priceHit && dmHit) || repeat) {
    base = "light";
  }

  if (!base) return null;
  if (newAccount && base !== "severe") base = bumpSeverity(base, 1);
  if (repeat) base = bumpSeverity(base, 1);
  return base;
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
  bankCold,
  newAccount,
  newMember,
  repeatOffender,
  obfuscated,
  jokeDowngraded
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
  if (newAccount) parts.push("new account");
  if (newMember) parts.push("new member");
  if (repeatOffender) parts.push("repeat offender");
  if (obfuscated) parts.push("obfuscated (spaced)");
  if (jokeDowngraded) parts.push("joke marker (downgraded)");
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
    H: 0,
    isNewAccount: false,
    isNewMember: false,
    repeatOffender: false,
    obfuscated: false,
    jokeMarker: false
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
    H: 0,
    isNewAccount: false,
    isNewMember: false,
    repeatOffender: false,
    obfuscated: false,
    jokeMarker: false
  }),
  durationMs: null,
  reasonText: "ignore - empty text",
  embedding: null
});

function downgradeVerdict(verdict) {
  if (verdict === "timeout") return "review";
  if (verdict === "review") return "ignore";
  return verdict;
}

async function classifyScamTrade(text, options = {}) {
  const raw = String(text || "");
  if (!raw.trim()) return NOOP_RESULT;

  const forms = buildNormalizedTextForms(raw);
  const folded = forms.folded || raw;
  const dense = densifyObfuscated(folded);
  const usedDense = dense !== folded;

  if (META_OR_WARNING_RE.test(folded)) {
    return buildIgnore({
      reasonText: "ignore - meta/warning",
      signals: emptySignals(),
      embedding: options.embedding || null
    });
  }

  const directionScore = computeDirectionScore(folded, dense);
  const priceHitFolded = PRICE_OR_PAYMENT_RE.test(folded) || CASHAPP_TAG_RE.test(folded);
  const priceHitDense = usedDense && (PRICE_OR_PAYMENT_RE.test(dense) || CASHAPP_TAG_RE.test(dense));
  const priceHit = priceHitFolded || priceHitDense;
  const dmHitFolded = DM_RE.test(folded);
  const dmHitDense = usedDense && DM_RE.test(dense);
  const dmHit = dmHitFolded || dmHitDense;
  const topicHitFolded = KICIA_TOPIC_RE.test(folded);
  const topicHitDense = usedDense && (KICIA_TOPIC_RE.test(dense) || topicHitInDense(dense));
  const topicHit = topicHitFolded || topicHitDense;
  const obfuscated = usedDense && (
    (priceHitDense && !priceHitFolded)
    || (dmHitDense && !dmHitFolded)
    || (topicHitDense && !topicHitFolded)
    || (SELLER_RE.test(dense) && !SELLER_RE.test(folded))
  );
  const buyerVeto = directionScore <= -1;

  const newAccount = isNewAccount(options.accountAgeMs);
  const newMember = isNewMember(options.memberAgeMs);
  const repeatOffender = !!options.repeatOffender;

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
        H: 0,
        isNewAccount: newAccount,
        isNewMember: newMember,
        repeatOffender,
        obfuscated,
        jokeMarker: false
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
        H: 0,
        isNewAccount: newAccount,
        isNewMember: newMember,
        repeatOffender,
        obfuscated,
        jokeMarker: false
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
  let confidence = computeConfidence({ H, semDelta, headScore });

  // account-age confidence bumps mirror the link-classifier behavior
  if (newAccount) {
    confidence = clamp(confidence + (priceHit ? 0.10 : 0.05), 0, 1);
  }

  const jokeMarker = detectJokeMarker(folded, dense);

  const signals = {
    directionScore,
    patternScore,
    priceHit,
    dmHit,
    topicHit,
    semDelta: sem.available ? semDelta : 0,
    headScore,
    confidence,
    H,
    isNewAccount: newAccount,
    isNewMember: newMember,
    repeatOffender,
    obfuscated,
    jokeMarker
  };

  const firstOffenseConfidence = Number(readSetting(
    "scam.firstoffense.confidence",
    DEFAULTS.firstOffenseConfidence
  ));
  // new-account + strong pattern (price+dm+direction) lowers the confidence
  // gate — H=3 in cold-start tops out around 0.67 even with the +0.10 bump,
  // and the signal already says "this is a scammer".
  const effectiveConfidenceGate = (newAccount && priceHit && dmHit && directionScore >= 2)
    ? Math.min(firstOffenseConfidence, 0.65)
    : firstOffenseConfidence;

  // joke downgrade applies to staff/bypass or long-tenured members, never new accounts
  const jokeBypassEligible = jokeMarker && !newAccount
    && (options.hasBypass === true || (Number.isFinite(options.memberAgeMs) && options.memberAgeMs > 7 * 86_400_000));

  let verdict = "ignore";
  let severity = null;
  let jokeDowngraded = false;

  if (H >= 3 && directionScore >= 2 && confidence >= effectiveConfidenceGate) {
    const sev = pickSeverity(H, confidence, signals, { isNewAccount: newAccount, repeatOffender });
    if (sev) {
      verdict = "timeout";
      severity = sev;
    }
  } else if ((H >= 2 && topicHit) || (H === 1 && directionScore >= 1)) {
    verdict = "review";
  }

  // last-mile severity bump for repeat offenders when we still arrived at review
  if (verdict === "review" && repeatOffender) {
    verdict = "timeout";
    severity = "light";
  }

  if (jokeBypassEligible && verdict !== "ignore") {
    verdict = downgradeVerdict(verdict);
    if (verdict === "ignore" || verdict === "review") severity = null;
    jokeDowngraded = true;
  }

  const reasonText = buildReasonText({
    verdict,
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
    bankCold: !banksWarm,
    newAccount,
    newMember,
    repeatOffender,
    obfuscated,
    jokeDowngraded
  });

  const durationMs = verdict === "timeout" ? severityTimeoutMs(severity) : null;

  return buildResult({
    verdict,
    severity,
    signals,
    durationMs,
    reasonText,
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

function resetHeadCache() {
  _head = null;
  _headLoadedAt = 0;
  _headAttempted = false;
}

module.exports = {
  classifyScamTrade,
  resetHeadCache,
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
    densifyObfuscated,
    detectJokeMarker,
    isNewAccount,
    isNewMember,
    bumpSeverity,
    DEFAULTS,
    SELLER_RE,
    BUYER_RE,
    KICIA_TOPIC_RE,
    DM_RE,
    PRICE_OR_PAYMENT_RE,
    META_OR_WARNING_RE,
    JOKE_RE
  }
};
