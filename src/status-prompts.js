const { normalizeText } = require("./text");

const LONG_STATUS_PATTERNS = [
  /^(?:kicia|kiciahook)?\s*status$/,
  /\b(?:is|was)\s+(?:kicia|kiciahook)\s+(?:down|up|working|online|offline)\b/,
  /\b(?:kicia|kiciahook)\s+(?:down|up|working|online|offline)\b/,
  /\b(?:is|was)\s+(?:kicia|kiciahook)\s+work(?:ing)?\b/,
  /\bdoes\s+(?:kicia|kiciahook)\s+work\b/,
  /\bcan\s+(?:kicia|kiciahook)\s+work\b/,
  /\bis\s+it\s+(?:down|up)\b/,
  /\bcurrent\s+status\b/
];

const SHORT_STATUS_PATTERNS = [
  /^status$/,
  /^does\s+it\s+work$/,
  /^does\s+it\s+works$/,
  /^is\s+it\s+work(?:ing)?$/,
  /^it\s+work(?:ing)?$/,
  /^still\s+work(?:ing|s)?$/,
  /^work(?:ing|s)?\s+rn$/,
  /^work(?:ing|s)?$/,
  /^not\s+work(?:ing)?$/,
  /^(?:doesnt|doesn\s+t|does\s+not)\s+work$/,
  /^(?:isnt|isn\s+t|is\s+not)\s+work(?:ing)?$/,
  /^(?:is\s+it\s+)?(?:borken|broken)$/,
  /^(?:is\s+it\s+)?(?:up|down)\s+rn$/,
  /^still\s+(?:up|down)$/,
  /^is\s+it\s+(?:up|down)$/,
  /^(?:up|down)$/
];

function matchesAnyPattern(content, patterns) {
  const normalized = normalizeText(content);
  if (!normalized) return false;
  return patterns.some((pattern) => pattern.test(normalized));
}

function detectLongStatusPrompt(content) {
  return matchesAnyPattern(content, LONG_STATUS_PATTERNS);
}

function detectShortStatusPrompt(content) {
  return matchesAnyPattern(content, SHORT_STATUS_PATTERNS);
}

function detectStatusPrompt(content) {
  return detectLongStatusPrompt(content) || detectShortStatusPrompt(content);
}

module.exports = {
  LONG_STATUS_PATTERNS,
  SHORT_STATUS_PATTERNS,
  detectLongStatusPrompt,
  detectShortStatusPrompt,
  detectStatusPrompt
};
