const STRIP_USER_MENTIONS_RE = /<@!?\d+>/g;

function cleanText(text) {
  return String(text || "")
    .replace(STRIP_USER_MENTIONS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stemToken(token) {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ied")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("zes")) return token.slice(0, -1);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenize(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean)
    .map(stemToken);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(normalizedText, normalizedPhrase) {
  if (!normalizedText || !normalizedPhrase) return false;
  const re = new RegExp(`(?:^| )${escapeRegExp(normalizedPhrase)}(?:$| )`, "i");
  return re.test(normalizedText);
}

function uniqueNormalized(values) {
  return [...new Set((values || []).map(normalizeText).filter(Boolean))];
}

module.exports = {
  cleanText,
  normalizeText,
  tokenize,
  containsPhrase,
  uniqueNormalized
};
