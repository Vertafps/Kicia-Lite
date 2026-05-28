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
const BUYER_RE = /\b(buy(?:ing|s)?|bought|wtb|lf|looking\s+(?:to\s+buy|for)|where.{0,20}(?:buy|get|purchase|find|download)|how.{0,15}(?:much|to\s+(?:buy|get)|do\s+i\s+(?:buy|get))|worth\s+(?:it|the|getting|buying|the\s+(?:price|money|cost)|\$?\d+))\b/i;
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
      // Distance tolerance scales with word length: short topics need exact-
      // ish matches (1 edit), medium-length tolerate 2 edits, and 9+ char
      // topics like "kiciahook" tolerate 3 edits — this catches scammer
      // typos like "kickerhook" (lev=3) that 2-edit caps were rejecting.
      const maxDist = word.length <= 6 ? 1 : word.length <= 8 ? 2 : 3;
      // cheap length-difference pre-check
      if (Math.abs(token.length - word.length) > maxDist) continue;
      if (levenshtein(token, word) <= maxDist) return match.index;
    }
  }
  return -1;
}
// Freebie-giveaway markers: scammers bait victims with "free X dm me" or
// "giving away X dm me" — distribution intent without any commerce vocabulary.
// Combined with topic + DM solicitation, this is seller-side intent.
const FREEBIE_RE = /\b(?:free|giveaway|giving\s+away|gifting|gift(?:ed|ing)?|hand(?:ing)?\s+out|handout|drop(?:ping)?\s+free|sharing|claim|claiming|legit\s+free|100%\s+free|no\s+cost|on\s+the\s+house|for\s+free)\b/i;
// Solicitation patterns: "anyone want X dm me", "if anyone wants X" — these
// are offer-side invitations (someone willing to provide X). Standalone they
// can be ambiguous, so they only fire when paired with topic + DM.
const SOLICITATION_RE = /\b(?:if\s+anyone\s+wants?|anyone\s+who\s+wants?|whoever\s+wants?|who\s+wants?\s+(?:a|an|some|free)|dm\s+(?:me\s+)?(?:if|when|for|to\s+get|to\s+claim)\b)/i;
const META_OR_WARNING_RE = /\b(?:do\s+not|don't|dont|stop|avoid|warning|warn|report|reported|allowed|against\s+rules?|not\s+allowed|is\s+this|is\s+that|someone|somebody|user|person|people|they|he|she)\b.{0,80}\b(?:sell|selling|buy|buying|trade|trading|scam|prohibited|illegal|free|giveaway|giving\s+away)\b/i;
const RULES_QUESTION_RE = /\b(?:is\s+(?:it\s+|that\s+|this\s+)?(?:allowed|prohibited|banned|against))|(?:is\s+\w.{0,40}(?:allowed|prohibited|banned|against\s+rules?))|(?:can|may|could|should)\s+(?:i|we|you)\s+(?:sell|buy|trade|swap)|(?:allowed|prohibited|banned)\s+(?:here|in\s+this\s+server|on\s+this\s+server)|are\s+we\s+allowed/i;
const JOKE_RE = /\b(?:\/s|\/jk|jk|jking|joking|kidding|kiddin|not\s+srs|not\s+serious|sarcasm|sarcastic)\b|\(jk\)|\(joking\)|\(kidding\)|\blmao\b/i;
// Fact-statement gate: "X is 25 dollars", "v3 costs 10", "kicia priced at 30" —
// these are informational price-statements, NOT seller pitches. Used to suppress
// the priceProximityHit fallback when no other seller-side signal corroborates.
const FACT_STATEMENT_RE = /\b(?:is|are|was|were|costs?|priced\s+at|priced)\s+(?:about\s+|around\s+|like\s+|just\s+|only\s+)?\$?\d+/i;
// Hypothetical frame: "what if i trade", "if i were to sell", "imagine if i" —
// suppresses all commerce signals when the entire sentence is framed as hypothetical.
// Also: "would be cool if X" / "wish X was cheaper" — pure conditional wish frames
// with no commerce intent. "if i could trade my account for kicia" — counterfactual.
const HYPOTHETICAL_RE = /\b(?:what\s+if|what\s+would|if\s+i\s+(?:were\s+to|wanted\s+to|wanna|could)|imagine\s+(?:if|i)|hypothetically|suppose\s+i|say\s+i|would\s+be\s+(?:cool|nice|great|awesome)\s+if|wish\s+(?:kicia|v[23]|hook|kiciahook|i|it|they|premium|prem|configs?)\s+(?:was|were)|wish\s+(?:i|it)\s+(?:was|were)\s+(?:cheaper|free))\b/i;
// Question-form veto: messages that start with or end with a question word/mark
// and have no seller-side signal are buyer/info questions — not seller intent.
const QUESTION_VETO_RE = /\?\s*$|^\s*(?:is|are|does|do|did|why|how|when|what|where|who|which|can|could|should|will|would|may|might|whats|what's|wheres|where's)\b/i;
// Rules-question expansion: explicit "rule on X" / "rules about X" / "ok to do X"
// patterns that read as inquiries about server rules, not commerce intent.
// Combines with META_OR_WARNING_RE / RULES_QUESTION_RE to widen the veto.
const RULES_INQUIRY_RE = /\b(?:rules?|rule\s+on|policy|policies)\s+(?:on|about|for|regarding|re)\b|\b(?:ok|okay|fine|cool)\s+to\s+(?:sell|buy|trade|swap|discuss|share|talk\s+about|mention)\b|\b(?:share|sharing)\s+(?:kicia|configs?|v[23]|hook|kiciahook)\s+(?:with|to)\s+(?:friends?|others?|someone)\b/i;
// Discord support / info request patterns. "how do i install X", "where do i
// find Y", "anyone got the download link" — never seller intent, always
// asking for help. Combined with topic, these are unambiguously support.
const SUPPORT_INQUIRY_RE = /\b(?:how\s+do\s+i|how\s+can\s+i|how\s+to|where\s+do\s+i|where\s+can\s+i|where\s+to|do\s+i\s+need|need\s+(?:to|help)|anyone\s+(?:got|have|know)|got\s+(?:the\s+)?(?:download|invite|link|tutorial)|reset\s+(?:my\s+)?hwid|not\s+loading|stuck\s+on|won'?t\s+(?:load|open|launch|run|start)|keeps\s+(?:disconnecting|crashing|failing)|disable\s+defender|disable\s+antivirus|tutorial|guide|install(?:ed|ing)?|import(?:ing)?\s+(?:a\s+)?config|find\s+(?:the\s+)?configs?\s+folder)\b/i;
// Pro-Kicia ecosystem chat: "kicia gang", "kicia stays winning", "ftw",
// "kicia carrying me" — pure praise. Never commerce.
const KICIA_PRAISE_RE = /\b(?:kicia\s+(?:gang|stays|wins?|won|ftw|ftl|on\s+top)|stays\s+winning|carrying\s+me|carries\s+me|got\s+me\s+to\s+(?:mythic|gold|silver|plat|diamond|master)|update\s+was\s+(?:crazy|fire|great|good|insane|sick|peak)|worth\s+every\s+penny|best\s+executor|goated\s+fr)\b/i;

// ============================================================================
// INNOCENCE GATE — "innocent until proven guilty" architecture
// ----------------------------------------------------------------------------
// Every classification starts at IGNORE. The classifier only escalates when
// EXPLICIT guilt signals are present: a seller verb (SELLER_RE), a
// possessive offer (POSSESSIVE_OFFER_RE), a Cyrillic seller verb, a freebie+
// DM+topic cluster, or a strong price+payment+DM combination.
//
// Before any scoring runs, the innocence gate checks for unambiguously benign
// patterns and short-circuits to ignore. The semantic head and trained head
// can only AMPLIFY a verdict; they can never CREATE one from these patterns.
//
// Branches (in evaluation order):
//   1. meta-or-warning  - "someone is selling X" / "don't buy from Y" / "warn"
//   2. rules-question   - "is selling allowed", "can i sell", "rule on trading"
//   3. hypothetical     - "what if I sold X", "imagine if v3 went free"
//   4. support-inquiry  - "how do I install v3", "v3 not loading"  (no DM/seller)
//   5. praise           - "kicia stays winning", "v3 worth every penny btw"
//   6. question-no-seller - starts with question word + no SELLER_RE + no DM
//   7. buyer-veto       - directionScore <= -1 (wtb/looking-for/where-to-buy)
//
// A branch returns { innocent: true, reason: "<short tag>" }.
// When nothing matches, returns { innocent: false }.
// ============================================================================
function checkInnocenceGate({ folded, dense, raw, directionScore, dmHit, topicHit }) {
  // 1. Meta / warning / third-person discussion of selling.
  if (META_OR_WARNING_RE.test(folded)) {
    return { innocent: true, reason: "meta/warning" };
  }
  // 2a. Explicit rules-question ("is selling allowed", "rule on trading").
  if (RULES_QUESTION_RE.test(folded)) {
    return { innocent: true, reason: "meta/warning" };
  }
  // 2b. Rules-inquiry expansion ("what's the rule on X", "rules about trading",
  // "ok to sell here", "share kicia with friends").
  if (RULES_INQUIRY_RE.test(folded)) {
    return { innocent: true, reason: "meta/warning" };
  }
  // 3. Hypothetical framing - what-if / imagine / would be cool if.
  if (HYPOTHETICAL_RE.test(folded)) {
    return { innocent: true, reason: "hypothetical/what-if" };
  }

  // The remaining branches need topic + direction context. If topic+direction
  // haven't been resolved yet, skip them — they'll be enforced after scoring.
  if (typeof directionScore !== "number" || typeof topicHit !== "boolean") {
    return { innocent: false };
  }

  // 4. Support / info request: "how do i install v3", "v3 not loading"
  //    + topic + no DM solicitation + no seller-side signal. The user is
  //    asking for help, not pitching a sale.
  if (topicHit && SUPPORT_INQUIRY_RE.test(folded) && !dmHit) {
    const hasSeller = SELLER_RE.test(folded)
      || (dense && dense !== folded && SELLER_RE.test(dense))
      || POSSESSIVE_OFFER_RE.test(folded)
      || (dense && dense !== folded && POSSESSIVE_OFFER_RE.test(dense))
      || CYRILLIC_SELLER_RE.test(raw || folded);
    if (!hasSeller) return { innocent: true, reason: "support inquiry" };
  }

  // 5. Pure-praise message: pro-Kicia talk with no commerce vocabulary.
  //    "kicia stays winning", "v3 update was crazy good", "best executor honestly".
  if (topicHit && KICIA_PRAISE_RE.test(folded) && !dmHit) {
    const hasSeller = SELLER_RE.test(folded)
      || (dense && dense !== folded && SELLER_RE.test(dense))
      || POSSESSIVE_OFFER_RE.test(folded)
      || (dense && dense !== folded && POSSESSIVE_OFFER_RE.test(dense))
      || CYRILLIC_SELLER_RE.test(raw || folded);
    const hasPrice = PRICE_OR_PAYMENT_RE.test(folded)
      || (dense && dense !== folded && PRICE_OR_PAYMENT_RE.test(dense));
    if (!hasSeller && !hasPrice) return { innocent: true, reason: "praise / casual mention" };
  }

  // 6. Question-form veto: starts with question word OR ends with `?` AND has
  //    no seller-side signal AND no DM solicitation. Buyer/info questions
  //    ("how much is v3?", "is kicia worth it") fall through here.
  const isQuestionForm = QUESTION_VETO_RE.test(folded);
  if (isQuestionForm && !dmHit) {
    const hasSeller = SELLER_RE.test(folded)
      || (dense && dense !== folded && SELLER_RE.test(dense))
      || POSSESSIVE_OFFER_RE.test(folded)
      || (dense && dense !== folded && POSSESSIVE_OFFER_RE.test(dense))
      || CYRILLIC_SELLER_RE.test(raw || folded);
    if (!hasSeller) return { innocent: true, reason: "question form, no seller signal" };
  }

  // 7. Buyer veto: explicit purchase intent ("wtb", "looking to buy",
  //    "where can i buy") with no seller signal of any flavour.
  if (directionScore <= -1) {
    return { innocent: true, reason: "buyer veto" };
  }

  return { innocent: false };
}

const DEFAULTS = {
  firstOffenseConfidence: 0.50,
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

// Known scammer-style mid-word splits ("sel ling", "se lling", "sell ing",
// "s elling", "sellin g") for the core commerce verbs. Limited to seller
// vocabulary so we don't accidentally densify normal multi-word phrases.
// Each verb gets an explicit alternation per cut-point so the regex stays
// readable; "ing/ed/s" suffix variants ride along where natural.
const SPACED_SELLER_VERB_RE = new RegExp(
  "\\b(?:" + [
    "s\\s+e\\s+l\\s+l(?:\\s+i\\s+n\\s+g|\\s+s)?", // s e l l (i n g)?
    "s\\s+ell(?:ing|s)?",                          // s elling
    "se\\s+ll(?:ing|s)?",                          // se lling
    "sel\\s+l(?:ing|s)?",                          // sel ling
    "sell\\s+ing",                                 // sell ing
    "sellin\\s+g",                                 // sellin g
    "s\\s+old", "so\\s+ld", "sol\\s+d",            // sold splits
    "w\\s+ts", "wt\\s+s",                          // wts splits
    "t\\s+rad(?:e|ing|ed|er|es)?",                 // t rade / t rading
    "tr\\s+ad(?:e|ing|ed|er|es)?",                 // tr ade
    "tra\\s+d(?:e|ing|ed|er|es)?",                 // tra de
    "trad\\s+(?:e|ing|ed|er|es)",                  // trad ing
    "tradin\\s+g",                                 // tradin g
    "s\\s+wap(?:ping|ped|s)?",                     // s wap (ping)?
    "sw\\s+ap(?:ping|ped|s)?",                     // sw ap (ping)?
    "swa\\s+p(?:ping|ped|s)?",                     // swa p (ping)?
    "swap\\s+ping",                                // swap ping
    "swapp\\s+ing",                                // swapp ing
    "f\\s+or\\s+sale", "fo\\s+r\\s+sale",          // f or sale
    "for\\s+s\\s+ale", "for\\s+sa\\s+le"           // for s ale
  ].join("|") + ")\\b",
  "i"
);

// collapses "s e l l i n g" -> "selling" (single-char splits, ≥4 in a row)
// AND known seller-verb multi-char splits like "sel ling" -> "selling".
// Two passes — the single-char regex first (most aggressive scammer pattern),
// then a targeted verb-split pass (safer than blanket multi-char collapsing).
function densifyObfuscated(text) {
  let out = String(text || "").replace(/\b\w(?:\s+\w\b){3,}/g, (match) => match.replace(/\s+/g, ""));
  // Second pass: collapse spaced seller verbs. Replace the entire matched
  // span (which may include internal spaces) with its space-stripped form.
  out = out.replace(SPACED_SELLER_VERB_RE, (match) => match.replace(/\s+/g, ""));
  return out;
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
  // Freebie/solicitation hits — only meaningful when paired with topic + DM,
  // gated below. Computed up here so the buyer-veto can take them into account.
  const freebieHit = FREEBIE_RE.exec(text)
    || (dense !== text ? FREEBIE_RE.exec(dense) : null);
  const solicitationHit = SOLICITATION_RE.exec(text)
    || (dense !== text ? SOLICITATION_RE.exec(dense) : null);
  const dmHitLocal = DM_RE.test(text) || (dense !== text && DM_RE.test(dense));

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

  const freebieGiveaway = !!(freebieHit && topicIdx >= 0 && dmHitLocal);
  const solicitationDrop = !!(solicitationHit && topicIdx >= 0 && dmHitLocal);

  // Buyer veto only fires when no seller-side signal of any flavour is present
  // (English verb, possessive offer, Cyrillic verb, freebie giveaway,
  // solicitation drop). A "free X dm me" message that also says "looking for"
  // is still a giveaway scam — the seller-side signal wins.
  if (buyerHit && !seller.hit && !possessiveHit && !cyrillicSellerHit
      && !freebieGiveaway && !solicitationDrop) return -2;

  // Question-form veto: "is v3 worth it for 25 euros?", "25 bucks for lifetime?"
  // etc. — buyer/info questions must not score +2 via priceProximity even when
  // BUYER_RE didn't catch them. Return 0 (neutral) when the message looks like
  // a question and has no seller-side signal of any kind.
  const isQuestionish = QUESTION_VETO_RE.test(text);
  if (isQuestionish && !seller.hit && !possessiveHit && !cyrillicSellerHit
      && !freebieGiveaway && !solicitationDrop && !dmHitLocal) {
    return 0;
  }

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
    // Freebie-giveaway: "free configs dm me", "giving away v3 keys dm me".
    // Tight proximity (≤40 chars between freebie token and topic) = strong
    // seller-side direction (+2). Looser cluster still scores +1 since the
    // DM solicitation already corroborates the offer-side intent.
    if (freebieGiveaway) {
      if (Math.abs(freebieHit.index - topicIdx) <= 40) return +2;
      return +1;
    }
    // Pure solicitation drop: "anyone want v3 dm me" — invitation without
    // an explicit "free" token. Lower confidence than freebie; +1 only.
    if (solicitationDrop) {
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
      // Suppress the fallback when the price is stated as a fact ("X is N dollars",
      // "X costs N") with no DM solicitation and no seller/possessive signal.
      // A bare "v3 is 25 dollars" is an informational statement, not a sales pitch.
      const isFactStatement = FACT_STATEMENT_RE.test(text)
        && !dmHitLocal
        && !seller.hit
        && !possessiveHit;
      if (isFactStatement) return 0;
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

  const obfuscated = !!signals.obfuscated;

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
  } else if (obfuscated && directionScore >= 2) {
    // Obfuscation + strong direction: deliberate scammer-style evasion
    // (e.g. "sel ling kickerhook v3"). The split/typo IS itself the second
    // signal — someone wouldn't break "selling" into "sel ling" by accident.
    // H can be 1 here because price/dm are typically absent in naked
    // obfuscated posts. Light tier; severity-bumped on new-account/repeat.
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
  } else if (verdict === "warn") {
    parts.push(`warn (sub-threshold) - H=${H} - conf=${confidence.toFixed(2)}`);
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
  if (verdict === "timeout") return "warn";
  if (verdict === "warn") return "ignore";
  return verdict;
}

async function classifyScamTrade(text, options = {}) {
  const raw = String(text || "");
  if (!raw.trim()) return NOOP_RESULT;

  const forms = buildNormalizedTextForms(raw);
  const folded = forms.folded || raw;
  const dense = densifyObfuscated(folded);
  const usedDense = dense !== folded;

  // -------------------------------------------------------------------------
  // PHASE 1 of the innocence gate — pre-scoring checks (META/RULES/HYPO).
  // These short-circuit before any scoring runs, so we never look at signals
  // for these classes of messages.
  // -------------------------------------------------------------------------
  const earlyGate = checkInnocenceGate({ folded, dense, raw });
  if (earlyGate.innocent) {
    return buildIgnore({
      reasonText: `ignore - ${earlyGate.reason}`,
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

  // -------------------------------------------------------------------------
  // PHASE 2 of the innocence gate — post-scoring checks that need the resolved
  // direction/dm/topic state to decide. Buyer-veto, question-form, support-
  // inquiry and praise all live here. A branch hit short-circuits to ignore.
  // -------------------------------------------------------------------------
  const lateGate = checkInnocenceGate({ folded, dense, raw, directionScore, dmHit, topicHit });
  if (lateGate.innocent) {
    return buildIgnore({
      reasonText: `ignore - ${lateGate.reason}`,
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
      const raw = scoreLogisticHead(vec, head);
      // sigmoid(NaN) → NaN; weights persisted as NaN can poison the score and
      // leak into computeConfidence. Coerce non-finite to null so the
      // half-credit default kicks in (consistent with kicia-disrespect).
      headScore = Number.isFinite(raw) ? raw : null;
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

  // Obfuscation is intent. Splitting "selling" into "sel ling" or fuzzying
  // "kiciahook" to "kickerhook" is deliberate evasion — bump confidence so
  // these don't sit at H=1, conf=0.29 in the warn bucket forever.
  if (obfuscated) {
    confidence = clamp(confidence + 0.15, 0, 1);
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
  // tight semantic proximity. When that's maxed out, the lowered gate kicks in.
  const strongDirection = directionScore >= 2;

  // Gate thresholds — single confidence check below decides timeout vs warn.
  //   - new-account + price+dm+direction: cap at 0.65 — once banks warm, H=3
  //     cold-start tops around 0.67 even with the +0.10 bump.
  //   - H=2 + strongDirection: cap at 0.40 — confidence math caps near 0.58
  //     in that band; 0.40 is comfortably reachable when sem clears, but well
  //     above the ~0.29 ceiling for H=1.
  // When firstOffenseConfidence is already lower than the cap, Math.min keeps
  // the base gate (the caps are upper bounds on the special-case gates, not
  // floors on the user-tuned setting).
  let gateConf = firstOffenseConfidence;
  if (newAccount && priceHit && dmHit && directionScore >= 2) {
    gateConf = Math.min(gateConf, 0.65);
  }
  if (strongDirection && H === 2) {
    gateConf = Math.min(gateConf, 0.40);
  }
  // Obfuscation + strong direction: the spaced-verb or fuzzy-topic match
  // already proved intent; lower gate so H=1 with conf ~0.44 (post +0.15
  // bump) can auto-action via the new obfuscated branch in pickSeverity.
  if (obfuscated && strongDirection) {
    gateConf = Math.min(gateConf, 0.35);
  }

  const jokeBypassEligible = jokeMarker && !newAccount
    && (options.hasBypass === true || (Number.isFinite(options.memberAgeMs) && options.memberAgeMs > 7 * 86_400_000));

  let verdict = "ignore";
  let severity = null;
  let jokeDowngraded = false;

  // Repeat-offender second-offense rule: a STRONG seller signal forces timeout,
  // regardless of confidence. Requires directionScore >= 2 (seller-verb within
  // 40 chars of topic) OR H >= 3 (three independent corroborating signals).
  // Weak/incidental signals (bare topic hit, lone price mention) no longer promote
  // to timeout — this prevents benign follow-up messages from being auto-muted.
  // pickSeverity already bumps one tier when repeatOffender is set.
  if (repeatOffender && (directionScore >= 2 || H >= 3)) {
    const sev = pickSeverity(H, confidence, signals, { isNewAccount: newAccount, repeatOffender })
      || "light";
    verdict = "timeout";
    severity = sev;
  } else if (confidence >= gateConf) {
    // Primary gate: confidence-first. Sub-checks fold into pickSeverity, which
    // returns null when nothing actionable lines up — falls back to warn below.
    const sev = pickSeverity(H, confidence, signals, { isNewAccount: newAccount, repeatOffender });
    if (sev) {
      verdict = "timeout";
      severity = sev;
    } else if (directionScore >= 1 && H >= 1) {
      verdict = "warn";
    }
  } else if (directionScore >= 1 && H >= 1) {
    // Sub-threshold: signals fired but confidence didn't clear the gate.
    // Require real commerce direction (directionScore >= 1) — sem/head alone
    // on benign Kicia-topical text must not produce warns.
    verdict = "warn";
  }

  if (jokeBypassEligible && verdict !== "ignore") {
    verdict = downgradeVerdict(verdict);
    if (verdict === "ignore" || verdict === "warn") severity = null;
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
    checkInnocenceGate,
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
    RULES_QUESTION_RE,
    RULES_INQUIRY_RE,
    SUPPORT_INQUIRY_RE,
    KICIA_PRAISE_RE,
    QUESTION_VETO_RE,
    JOKE_RE,
    FREEBIE_RE,
    SOLICITATION_RE,
    FACT_STATEMENT_RE,
    HYPOTHETICAL_RE,
    topicHitFuzzy,
    levenshtein
  }
};
