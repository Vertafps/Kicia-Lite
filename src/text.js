const STRIP_USER_MENTIONS_RE = /<@!?\d+>/g;
const TOKEN_CANONICAL_MAP = new Map([
  ["cna", "can"],
  ["cant", "can"],
  ["couldnt", "could"],
  ["recomend", "recommend"],
  ["recomended", "recommended"],
  ["reccomended", "recommended"],
  ["recommened", "recommended"],
  ["suport", "support"],
  ["suported", "supported"],
  ["suppported", "supported"],
  ["exe", "executor"],
  ["exec", "executor"],
  ["execs", "executor"],
  ["executer", "executor"],
  ["executor", "executor"],
  ["ececutor", "executor"],
  ["ecxecutor", "executor"],
  ["ecexutor", "executor"],
  ["downlaod", "download"],
  ["downlod", "download"],
  ["dwonload", "download"],
  ["wher", "where"],
  ["wheres", "where"],
  ["guii", "gui"],
  ["loby", "lobby"],
  ["bann", "banned"],
  ["bannd", "banned"],
  ["deteced", "detected"],
  ["detectd", "detected"],
  ["tripmin", "tripmine"],
  ["esped", "esp"],
  ["ragebot", "rage"],
  ["beat", "fight"],
  ["beats", "fight"],
  ["fighting", "fight"],
  ["losing", "lose"]
]);

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

function canonicalizeToken(token) {
  const stemmed = stemToken(token);
  return TOKEN_CANONICAL_MAP.get(stemmed) || stemmed;
}

function tokenize(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean)
    .map(canonicalizeToken);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(normalizedText, normalizedPhrase) {
  if (!normalizedText || !normalizedPhrase) return false;
  const re = new RegExp(`(?:^| )${escapeRegExp(normalizedPhrase)}(?:$| )`, "i");
  return re.test(normalizedText);
}

function isEditDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;

    if (a.length > b.length) {
      i += 1;
    } else if (b.length > a.length) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }

  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}

function fuzzyTokenMatch(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (Math.min(a.length, b.length) < 4) return false;
  if (a[0] !== b[0]) return false;
  return isEditDistanceAtMostOne(a, b);
}

function uniqueNormalized(values) {
  return [...new Set((values || []).map(normalizeText).filter(Boolean))];
}

module.exports = {
  cleanText,
  normalizeText,
  tokenize,
  containsPhrase,
  fuzzyTokenMatch,
  uniqueNormalized
};
