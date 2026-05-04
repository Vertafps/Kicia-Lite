"use strict";

const PRICE_RE = /(?:[$\u20ac\u00a3]\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?\s*(?:usd|eur|gbp|dollars?|bucks?|rs|lkr)\b)/i;
const DIRECT_COMMERCE_RE =
  /\b(?:sell|selling|sold|buy|buying|trade|trading|swap|swapping|exchange|exchanging|wts|wtb|for\s+sale|taking\s+offers?|vendor|plug)\b/i;
const EXCHANGE_DETAIL_RE =
  /\b(?:price|prices|offer|offers|cheap|cashapp|paypal|crypto|btc|eth|gift\s*card|dm|dms|pm|message\s+me|msg\s+me|private|privately)\b/i;
const META_OR_WARNING_RE =
  /\b(?:do\s+not|don't|dont|stop|avoid|warning|warn|report|reported|allowed|against\s+rules?|not\s+allowed|is\s+this|is\s+that|someone|somebody|user|person|people|they|he|she)\b.{0,80}\b(?:sell|selling|buy|buying|trade|trading|scam|prohibited|illegal|drugs?|weapons?)\b/i;
const QUESTION_RE = /\?|^(?:can|could|should|is|are|where|how|what|why|who|does|do)\b/i;

const PROHIBITED_GROUPS = [
  {
    category: "controlled substances",
    terms: [
      "marijuana",
      "marihuana",
      "cannabis",
      "weed",
      "hash",
      "thc",
      "edibles",
      "cocaine",
      "heroin",
      "meth",
      "mdma",
      "molly",
      "lsd",
      "fentanyl",
      "xanax",
      "percocet",
      "oxycontin",
      "lean"
    ]
  },
  {
    category: "weapons",
    terms: [
      "firearm",
      "firearms",
      "pistol",
      "rifle",
      "shotgun",
      "ammo",
      "ammunition"
    ]
  }
];

function normalizeCommerceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/3/g, "e")
    .replace(/[1!|]/g, "l")
    .replace(/0/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collapseRepeats(value) {
  return String(value || "").replace(/(.)\1{2,}/g, "$1$1");
}

function levenshteinDistance(left, right) {
  const a = collapseRepeats(left);
  const b = collapseRepeats(right);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }

  return previous[b.length];
}

function similarity(left, right) {
  const a = normalizeCommerceText(left).replace(/\s+/g, "");
  const b = normalizeCommerceText(right).replace(/\s+/g, "");
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - (levenshteinDistance(a, b) / Math.max(a.length, b.length));
}

function findProhibitedCommerceItem(input) {
  const normalized = normalizeCommerceText(input);
  if (!normalized) return null;

  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 3);
  let best = null;

  for (const group of PROHIBITED_GROUPS) {
    for (const term of group.terms) {
      const normalizedTerm = normalizeCommerceText(term);
      for (const token of tokens) {
        const exact = token === normalizedTerm;
        const fuzzyAllowed = normalizedTerm.length >= 6 && token.length >= 5;
        const score = exact ? 1 : fuzzyAllowed ? similarity(token, normalizedTerm) : 0;
        if (score >= 0.72 && (!best || score > best.score)) {
          best = {
            category: group.category,
            term,
            matched: token,
            score
          };
        }
      }
    }
  }

  return best;
}

function detectProhibitedCommerce(input) {
  const parts = Array.isArray(input) ? input : [input];
  const text = parts.map((part) => String(part || "")).filter(Boolean).join("\n");
  const normalized = normalizeCommerceText(text);
  if (!normalized || META_OR_WARNING_RE.test(normalized)) return null;

  const item = findProhibitedCommerceItem(normalized);
  if (!item) return null;

  const hasDirectCommerce = DIRECT_COMMERCE_RE.test(normalized);
  const hasPrice = PRICE_RE.test(text);
  const hasExchangeDetail = hasPrice || EXCHANGE_DETAIL_RE.test(normalized);
  if (!hasDirectCommerce || !hasExchangeDetail) return null;

  let confidence = 88;
  if (hasPrice) confidence += 5;
  if (item.score >= 0.9) confidence += 3;
  if (QUESTION_RE.test(String(text || "")) && !/^sell(?:ing)?\b|^wts\b|^for\s+sale\b/i.test(normalized)) {
    confidence -= 16;
  }

  confidence = Math.max(1, Math.min(99, Math.round(confidence)));
  if (confidence < 75) return null;

  return {
    category: item.category,
    term: item.term,
    matched: item.matched,
    confidence,
    score: item.score,
    reason: `prohibited goods sale detected (${item.category}; matched "${item.matched}")`
  };
}

module.exports = {
  detectProhibitedCommerce,
  findProhibitedCommerceItem,
  normalizeCommerceText,
  similarity
};
