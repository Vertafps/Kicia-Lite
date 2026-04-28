const STRIP_USER_MENTIONS_RE = /<@!?\d+>/g;
const INVISIBLE_TEXT_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const COMBINING_MARK_RE = /[\u0300-\u036f]/g;
const CONFUSABLE_CHAR_MAP = new Map([
  ["\u0430", "a"],
  ["\u03B1", "a"],
  ["\uFF41", "a"],
  ["\u0184", "b"],
  ["\u0421", "c"],
  ["\u0441", "c"],
  ["\u03F2", "c"],
  ["\uFF43", "c"],
  ["\u0501", "d"],
  ["\u0435", "e"],
  ["\u0451", "e"],
  ["\u03B5", "e"],
  ["\uFF45", "e"],
  ["\u0261", "g"],
  ["\u04BB", "h"],
  ["\u0456", "i"],
  ["\u0406", "i"],
  ["\u03B9", "i"],
  ["\uFF49", "i"],
  ["\u0458", "j"],
  ["\u0131", "i"],
  ["\u04CF", "l"],
  ["\u217C", "l"],
  ["\uFF4C", "l"],
  ["\u043C", "m"],
  ["\u03BC", "m"],
  ["\u043E", "o"],
  ["\u03BF", "o"],
  ["\uFF4F", "o"],
  ["\u0440", "p"],
  ["\u03C1", "p"],
  ["\uFF50", "p"],
  ["\u0455", "s"],
  ["\uFF53", "s"],
  ["\u0442", "t"],
  ["\uFF54", "t"],
  ["\u0445", "x"],
  ["\u03C7", "x"],
  ["\uFF58", "x"],
  ["\u0443", "y"],
  ["\uFF59", "y"]
]);
const TOKEN_CANONICAL_MAP = new Map([
  ["cna", "can"],
  ["cant", "can"],
  ["isnt", "is"],
  ["isn", "is"],
  ["arent", "are"],
  ["aren", "are"],
  ["couldnt", "could"],
  ["couldn", "could"],
  ["shouldnt", "should"],
  ["shouldn", "should"],
  ["dont", "do"],
  ["doesn", "does"],
  ["doesnt", "does"],
  ["wont", "will"],
  ["won", "will"],
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
  ["losing", "lose"],
  ["config", "configuration"],
  ["configs", "configuration"],
  ["cfg", "configuration"],
  ["cfgs", "configuration"],
  ["workin", "working"],
  ["worj", "working"],
  ["fix", "fixed"],
  ["fixing", "fixed"],
  ["update", "updated"],
  ["updating", "updated"],
  ["crash", "crashing"],
  ["crashed", "crashing"],
  ["error", "err"],
  ["msg", "message"],
  ["txt", "text"],
  ["idk", "know"],
  ["dunno", "know"],
  ["got", "get"],
  ["gett", "get"],
  ["pls", "please"],
  ["plz", "please"],
  ["thx", "thanks"],
  ["ty", "thanks"],
  ["rly", "really"]
]);

function foldConfusableText(text) {
  return String(text || "")
    .replace(INVISIBLE_TEXT_RE, "")
    .normalize("NFKD")
    .replace(COMBINING_MARK_RE, "")
    .replace(/./gu, (char) => CONFUSABLE_CHAR_MAP.get(char) || char);
}

function cleanText(text) {
  return String(text || "")
    .replace(STRIP_USER_MENTIONS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text) {
  return cleanText(foldConfusableText(text))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stemToken(token) {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ive")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ly")) return token.slice(0, -2);
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

function isEditDistanceAtMost(a, b, maxEdits = 1) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > maxEdits) return false;

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
    if (edits > maxEdits) return false;

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
  return edits <= maxEdits;
}

function fuzzyTokenMatch(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (Math.min(a.length, b.length) < 4) return false;
  if (a[0] !== b[0]) return false;
  if (
    Math.min(a.length, b.length) >= 8 &&
    a.slice(0, 3) === b.slice(0, 3) &&
    isEditDistanceAtMost(a, b, 2)
  ) {
    return true;
  }
  return isEditDistanceAtMost(a, b, 1);
}

function uniqueNormalized(values) {
  return [...new Set((values || []).map(normalizeText).filter(Boolean))];
}

module.exports = {
  cleanText,
  foldConfusableText,
  normalizeText,
  tokenize,
  containsPhrase,
  fuzzyTokenMatch,
  isEditDistanceAtMost,
  uniqueNormalized
};
