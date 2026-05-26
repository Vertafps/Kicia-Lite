const { embedText, cosineSim } = require("./embeddings");
const { getBank } = require("./example-banks");
const { buildNormalizedTextForms } = require("./text");
const { scoreLogisticHead } = require("./inline-probe");
const { recordRuntimeEvent } = require("./runtime-health");

// inline two-row Levenshtein — kept local to avoid coupling with prohibited-commerce.
// Treats adjacent-char transposition as a single edit (restricted Damerau-Levenshtein)
// so "kciia" vs "kicia" is distance 1 — the canonical scammer-typo case.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const n = a.length;
  const m = b.length;
  // Three rows for the Damerau adjacent-transposition lookback.
  let prev2 = new Array(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  const cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2] + 1);
      }
      cur[j] = best;
    }
    // shift rows: prev2 ← prev, prev ← cur
    for (let j = 0; j <= m; j++) {
      prev2[j] = prev[j];
      prev[j] = cur[j];
    }
  }
  return prev[m];
}

// `\b` doesn't fire before `$` (both non-word boundary characters), so the
// dollar-sign alternatives must NOT be word-anchored. Crypto/payment-rail
// tokens still want \b so they don't trigger inside unrelated words.
const PRICE_OR_PAYMENT_RE = /(?:\$\s*\d+|\d+\s*\$|\b\d+\s*(?:usd|eur|gbp|dollars?|bucks?|robux|rbx|euros?|pounds?)\b|\b(?:cashapp|paypal|crypto|btc|eth|ltc|usdt|solana|sol|bnb|xrp|venmo|zelle|gift\s*card|steam\s*g(?:ift\s*card|c)|amazon\s*gc|roblox\s*gc|nitro|western\s+union|moneygram|wu)\b)/i;
const CASHAPP_TAG_RE = /\bcashapp\b[\s\S]{0,20}\$\w+|\$\w+[\s\S]{0,20}\bcashapp\b/i;
// Includes:
//   - English seller verbs (selling/sold/wts/trade/swap/vouches/etc)
//   - Restocking verbs (restocked/stocked/back open/back in business/in stock) —
//     these signal "I'm resuming/continuing my sales business", a strong
//     seller-side cue scammers use to ride the loosening of cooldown logic.
//   - Spanish/Portuguese sellers (vendo/vende/vendendo/vendiendo/venta/venda)
//     so non-English scammers don't slip through the ASCII gate.
// Cyrillic sellers live in a separate CYRILLIC_SELLER_RE (Unicode-flag regex)
// to keep this one ASCII-only and avoid /u flag side-effects across the file.
const SELLER_RE = /\b(sell(?:ing|s)?|sold|wts|for\s+sale|taking\s+offers?|vendor|plug|trade|trading|swap(?:ping)?|exchange|exchanging|lf\s*(?:trade|swap)|vouch(?:es|ed)?|going\s+first|gf\s+(?:only|rep)|tos\s+(?:first|required)|t\.?o\.?s\.?\s+first|restock(?:ed|ing|s)?|stocked(?:\s+up)?|back\s+open|back\s+in\s+business|in\s+stock|vendo|vende|vendiendo|vendendo|venta|venda|verkaufe|verkaufen)\b/i;
// Cyrillic seller-side verbs only (no "купить" = "to buy"). Uses /u flag so
// the engine treats characters as Unicode code points, which lets the verbs
// match anywhere in the input regardless of surrounding language.
const CYRILLIC_SELLER_RE = /(?:продаю|продам|продается|продаётся|продать)/iu;
// possessive-offer-style: forward form "got X if u want", "have X who wants",
// "got X for 10"; reverse form "who wants my X", "anyone want my X". The
// trailing/leading intent-indicator (if u want / hmu / for sale / for $N) is
// what makes this seller-side rather than benign "I own this".
const POSSESSIVE_OFFER_RE = /(?:\b(?:got|have|hav|gots?|own|owning)\b[^.\n]{0,30}\b(?:if\s+(?:u|you)\s+want|who\s+wants?|anyone\s+want|lmk|let\s+me\s+know|hmu|dm\s+me|pm\s+me|msg\s+me|for\s+(?:sale|trade|cheap|\d+))|\b(?:who\s+wants?|anyone\s+want)\b[^.\n]{0,20}\bmy\b)/i;
const TRUSTED_SELLER_RE = /\btrusted(?:\s+seller)?\b/i;
const MIDDLEMAN_RE = /\b(?:middleman|mm)\b/i;
const BUYER_RE = /\b(buy(?:ing|s)?|bought|wtb|lf|looking\s+(?:to\s+buy|for)|where.{0,20}(?:buy|get|purchase|find|download)|how.{0,15}(?:much|to\s+(?:buy|get)|do\s+i\s+(?:buy|get)))\b/i;
const DM_RE = /\b(dm\s*me|pm\s*me|msg\s*me|message\s*me|go\s+private|in\s+dms?|hmu|slide\s+in(?:to)?\s+(?:my\s+)?dms?|msg\s+me\s+asap|pm\s+asap|dm\s+urgent|inbox\s+me)\b/i;
const KICIA_TOPIC_RE = /\b(kicia|kiciahook|hook|v[23]|configs?|keys?|licenses?|lifetimes?|premiums?|subs?|subscriptions?|cracked\s+kicia)\b/i;
// "kicia 30 usd" / "v3 30usd dm" style — topic + explicit currency within 30
// chars with no seller verb present. Captures implicit seller intent: someone
// quoting a Kicia product alongside a price IS the sales pitch, even without
// "selling". Buyer phrasing still vetoes via BUYER_RE before this is consulted.
const PRICE_NEAR_TOPIC_RE = /(?:\b(?:kicia|kiciahook|hook|v[23]|configs?|keys?|licenses?|lifetimes?|premiums?|subs?|subscriptions?)\b)[^.\n]{0,30}(?:\$\s*\d+|\d+\s*\$|\d+\s*(?:usd|eur|gbp|dollars?|bucks?|robux|rbx))/i;
const TOPIC_NEAR_PRICE_RE = /(?:\$\s*\d+|\d+\s*\$|\d+\s*(?:usd|eur|gbp|dollars?|bucks?|robux|rbx))[^.\n]{0,30}(?:\b(?:kicia|kiciahook|hook|v[23]|configs?|keys?|licenses?|lifetimes?|premiums?|subs?|subscriptions?)\b)/i;
// "kicia for 10 paypal only" / "v3 30 cashapp only" — topic + bare number +
// payment rail clustered within ~30 chars each. Distinct from the currency-
// suffix forms above because the dollar amount is implicit ("paypal" carries
// the rail-name signal, the number carries the price). Three-way proximity:
// topic ↔ number ↔ rail. Either ordering qualifies. Stays gated by topic
// being present somewhere in the cluster.
const TOPIC_NUM_RAIL_RE = /\b(?:kicia|kiciahook|hook|v[23]|configs?|keys?|licenses?|lifetimes?|premiums?|subs?|subscriptions?)\b[^.\n]{0,30}\b\d+\b[^.\n]{0,15}\b(?:cashapp|paypal|crypto|btc|eth|ltc|usdt|solana|sol|bnb|xrp|venmo|zelle|nitro|robux|rbx)\b/i;
const RAIL_NUM_TOPIC_RE = /\b(?:cashapp|paypal|crypto|btc|eth|ltc|usdt|solana|sol|bnb|xrp|venmo|zelle|nitro|robux|rbx)\b[^.\n]{0,15}\b\d+\b[^.\n]{0,30}\b(?:kicia|kiciahook|hook|v[23]|configs?|keys?|licenses?|lifetimes?|premiums?|subs?|subscriptions?)\b/i;
// Words to fuzzy-match against tokens >= 4 chars when KICIA_TOPIC_RE misses.
// Intentionally excludes short tokens like "hook"/"v2"/"v3" — too many false
// positives at 1-edit distance, and the regex already catches them.
const TOPIC_FUZZY_WORDS = ["kicia", "kiciahook", "configs", "config", "keys", "key", "license", "lifetime", "premium"];

// Returns the position of an exact OR fuzzy topic match, or -1 if no match.
// Exact regex first; falls back to per-token Levenshtein over alpha tokens.
function topicHitFuzzy(text) {
  const m = KICIA_TOPIC_RE.exec(text);
  if (m) return m.index;

  const lower = String(text || "").toLowerCase();
  const tokenRe = /[a-z]{4,}/g;
  let match;
  while ((match = tokenRe.exec(lower)) !== null) {
    const token = match[0];
    // too-long tokens (>14) are unlikely typos of any topic word
    if (token.length > 14) continue;
    for (const word of TOPIC_FUZZY_WORDS) {
      const maxDist = word.length <= 6 ? 1 : 2;
      // cheap length-difference pre-check
      if (Math.abs(token.length - word.length) > maxDist) continue;
      if (levenshtein(token, word) <= maxDist) return match.index;
    }
  }
  return -1;
}
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

function readSetting(key, fallback) {
  try {
    const value = require("./settings").getSetting(key);
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

// collapses "s e l l i n g" -> "selling"; requires 4+ adjacent single-char tokens
function densifyObfuscated(text) {
  return String(text || "").replace(/\b\w(?:\s+\w\b){3,}/g, (match) => match.replace(/\s+/g, ""));
}

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
  // trusted/middleman/mm gated on commerce context — too noisy otherwise
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

function computeDirectionScore(text, denseText, rawText) {
  const dense = denseText == null ? densifyObfuscated(text) : denseText;
  // Folding latinizes Cyrillic (e.g. "продаю" → "npoдaю"), so the raw text
  // is the only place Cyrillic verbs survive. Fall back to `text` when raw
  // isn't supplied (legacy single-arg callers, including tests).
  const rawForCyrillic = rawText == null ? text : rawText;
  const seller = sellerSignal(text, dense);
  const possessiveHit = POSSESSIVE_OFFER_RE.exec(text)
    || (dense !== text ? POSSESSIVE_OFFER_RE.exec(dense) : null);
  // Cyrillic seller-verb match — runs on the raw text to survive folding.
  const cyrillicSellerHit = CYRILLIC_SELLER_RE.exec(rawForCyrillic);
  const buyerHit = BUYER_RE.exec(text);

  // Resolve topic index: regex on text → regex on dense → dense-substring → fuzzy.
  let topicIdx = -1;
  let topicHitFromRegex = KICIA_TOPIC_RE.exec(text);
  if (topicHitFromRegex) {
    topicIdx = topicHitFromRegex.index;
  } else if (dense !== text) {
    topicHitFromRegex = KICIA_TOPIC_RE.exec(dense);
    if (topicHitFromRegex) topicIdx = topicHitFromRegex.index;
  }
  if (topicIdx < 0 && dense !== text && topicHitInDense(dense)) {
    topicIdx = 0;
  }
  if (topicIdx < 0) {
    const fuzzy = topicHitFuzzy(text);
    if (fuzzy >= 0) topicIdx = fuzzy;
  }

  // Buyer veto only fires when no seller-side signal of any flavour is present
  // (English verb, possessive offer, or Cyrillic verb).
  if (buyerHit && !seller.hit && !possessiveHit && !cyrillicSellerHit) return -2;

  if (topicIdx >= 0) {
    if (seller.hit) {
      const sellerRef = SELLER_RE.exec(text)
        || (dense !== text ? SELLER_RE.exec(dense) : null)
        || TRUSTED_SELLER_RE.exec(text)
        || MIDDLEMAN_RE.exec(text);
      if (sellerRef && Math.abs(sellerRef.index - topicIdx) <= 40) return +2;
      return +1;
    }
    if (possessiveHit) {
      if (Math.abs(possessiveHit.index - topicIdx) <= 40) return +2;
      return +1;
    }
    if (cyrillicSellerHit) {
      // cyrillicSellerHit.index references raw text — resolve topic in raw
      // text too so the proximity math compares apples to apples. Falls back
      // to the folded topicIdx if raw doesn't hit (shouldn't happen, but
      // keeps the call safe).
      const rawTopic = KICIA_TOPIC_RE.exec(rawForCyrillic);
      const rawTopicIdx = rawTopic ? rawTopic.index : topicIdx;
      if (Math.abs(cyrillicSellerHit.index - rawTopicIdx) <= 40) return +2;
      return +1;
    }
    // Bare price-near-topic fallback. No explicit seller verb, but the topic
    // is quoted within 30 chars of a price/currency/payment-rail token —
    // strong implicit seller intent (the only person who quotes "kicia 30 usd"
    // or "v3 30 cashapp only" is the seller). Already past the buyer-veto
    // check above, so buyers don't end up here.
    const priceProximityHit =
      PRICE_NEAR_TOPIC_RE.test(text) || TOPIC_NEAR_PRICE_RE.test(text)
      || TOPIC_NUM_RAIL_RE.test(text) || RAIL_NUM_TOPIC_RE.test(text)
      || (dense !== text && (
        PRICE_NEAR_TOPIC_RE.test(dense) || TOPIC_NEAR_PRICE_RE.test(dense)
        || TOPIC_NUM_RAIL_RE.test(dense) || RAIL_NUM_TOPIC_RE.test(dense)
      ));
    if (priceProximityHit) {
      return +2;
    }
  }
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
  // legacy 4-arg form: pickSeverity(H, conf, priceHit, dmHit)
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
  } else if (H === 2 && directionScore >= 2) {
    // strong direction (seller-verb within 40 chars of kicia-topic) + one
    // corroborating signal — tight enough to auto-action at "light"
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

  const directionScore = computeDirectionScore(folded, dense, raw);
  const priceHitFolded = PRICE_OR_PAYMENT_RE.test(folded) || CASHAPP_TAG_RE.test(folded);
  const priceHitDense = usedDense && (PRICE_OR_PAYMENT_RE.test(dense) || CASHAPP_TAG_RE.test(dense));
  // Possessive-offer "for N" (e.g. "got configs for 10") is price intent even
  // without an explicit currency symbol — scammer shorthand on a kicia-server.
  // Only counts when seller-direction is already established (avoids
  // "got home from work for 10 minutes" style false positives).
  const possessiveForN = directionScore >= 1
    && /\b(?:got|have|hav|gots?|own|owning)\b[^.\n]{0,30}\bfor\s+\d+\b/i.test(folded);
  const priceHit = priceHitFolded || priceHitDense || possessiveForN;
  const dmHitFolded = DM_RE.test(folded);
  const dmHitDense = usedDense && DM_RE.test(dense);
  const dmHit = dmHitFolded || dmHitDense;
  const topicHitFolded = KICIA_TOPIC_RE.test(folded);
  const topicHitDense = usedDense && (KICIA_TOPIC_RE.test(dense) || topicHitInDense(dense));
  // fuzzy fallback for deliberate scammer typos ("confits", "kciia", "kicha")
  const topicHitFuzzyMatch = !topicHitFolded && !topicHitDense && topicHitFuzzy(folded) >= 0;
  const topicHit = topicHitFolded || topicHitDense || topicHitFuzzyMatch;
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

  // directionScore=+2 means seller-verb and Kicia-topic are within 40 chars —
  // tight semantic proximity. When that's maxed out, one corroborating signal
  // (semantic, head, price, dm) is enough — H=2 with strong direction qualifies.
  // Weaker direction still needs the full H>=3 stack.
  const strongDirection = directionScore >= 2;
  const minH = strongDirection ? 2 : 3;

  // Gate thresholds:
  //   - new-account + price+dm+direction: cap at 0.65 — H=3 cold-start tops
  //     around 0.67 even with the +0.10 bump.
  //   - H=2 + strongDirection: confidence math caps near 0.58, so use 0.40 —
  //     comfortably reachable when sem clears its threshold, but well above
  //     the ~0.29 ceiling for H=1.
  let effectiveConfidenceGate = firstOffenseConfidence;
  if (newAccount && priceHit && dmHit && directionScore >= 2) {
    effectiveConfidenceGate = Math.min(firstOffenseConfidence, 0.65);
  } else if (strongDirection && H === 2) {
    effectiveConfidenceGate = Math.min(firstOffenseConfidence, 0.40);
  }

  const jokeBypassEligible = jokeMarker && !newAccount
    && (options.hasBypass === true || (Number.isFinite(options.memberAgeMs) && options.memberAgeMs > 7 * 86_400_000));

  let verdict = "ignore";
  let severity = null;
  let jokeDowngraded = false;

  if (H >= minH && strongDirection && confidence >= effectiveConfidenceGate) {
    const sev = pickSeverity(H, confidence, signals, { isNewAccount: newAccount, repeatOffender });
    if (sev) {
      verdict = "timeout";
      severity = sev;
    }
  } else if ((H >= 2 && topicHit) || (H === 1 && directionScore >= 1)) {
    verdict = "review";
  }

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
    CYRILLIC_SELLER_RE,
    POSSESSIVE_OFFER_RE,
    BUYER_RE,
    KICIA_TOPIC_RE,
    DM_RE,
    PRICE_OR_PAYMENT_RE,
    PRICE_NEAR_TOPIC_RE,
    TOPIC_NEAR_PRICE_RE,
    TOPIC_NUM_RAIL_RE,
    RAIL_NUM_TOPIC_RE,
    META_OR_WARNING_RE,
    JOKE_RE,
    topicHitFuzzy,
    levenshtein
  }
};
