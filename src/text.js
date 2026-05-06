const STRIP_USER_MENTIONS_RE = /<@!?\d+>/g;
const INVISIBLE_TEXT_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0100}-\u{E01EF}]/gu;
const COMBINING_MARK_RE = /\p{Mark}/gu;
const CONFUSABLE_CHAR_MAP = new Map([
  ["\u0410", "a"],
  ["\u0430", "a"],
  ["\u0391", "a"],
  ["\u03B1", "a"],
  ["\u0251", "a"],
  ["\u0252", "a"],
  ["\u00C6", "ae"],
  ["\u00E6", "ae"],
  ["\uAA96", "a"],
  ["\uFF41", "a"],
  ["\u00DF", "ss"],
  ["\u0184", "b"],
  ["\u0411", "b"],
  ["\u0431", "b"],
  ["\u0412", "b"],
  ["\u0432", "b"],
  ["\u0392", "b"],
  ["\u03B2", "b"],
  ["\u0421", "c"],
  ["\u0441", "c"],
  ["\u03F9", "c"],
  ["\u03F2", "c"],
  ["\u00A2", "c"],
  ["\u0254", "c"],
  ["\u03FD", "c"],
  ["\u176F", "c"],
  ["\u1974", "c"],
  ["\uFF43", "c"],
  ["\u0500", "d"],
  ["\u0393", "f"],
  ["\u0501", "d"],
  ["\u146F", "d"],
  ["\u13A0", "d"],
  ["\u13A1", "d"],
  ["\u1A35", "o"],
  ["\u0415", "e"],
  ["\u0435", "e"],
  ["\u0404", "e"],
  ["\u0454", "e"],
  ["\u0401", "e"],
  ["\u0451", "e"],
  ["\u0395", "e"],
  ["\u03B5", "e"],
  ["\u039E", "e"],
  ["\u03BE", "e"],
  ["\u01DD", "e"],
  ["\uAAC0", "e"],
  ["\uFF45", "e"],
  ["\u0492", "f"],
  ["\u0493", "f"],
  ["\u03DC", "f"],
  ["\u0261", "g"],
  ["\u050C", "g"],
  ["\u050D", "g"],
  ["\u13C0", "g"],
  ["\u13C1", "g"],
  ["\u19C1", "g"],
  ["\u0581", "g"],
  ["\u0126", "h"],
  ["\u0127", "h"],
  ["\u041D", "h"],
  ["\u043D", "h"],
  ["\u04BB", "h"],
  ["\u0397", "h"],
  ["\u029C", "h"],
  ["\u0266", "h"],
  ["\u03B7", "n"],
  ["\u0399", "i"],
  ["\u03AA", "i"],
  ["\u0456", "i"],
  ["\u0406", "i"],
  ["\u03B9", "i"],
  ["\u03CA", "i"],
  ["\u13A5", "i"],
  ["\u1965", "i"],
  ["\u2148", "i"],
  ["\uAAB1", "i"],
  ["\uFF49", "i"],
  ["\u0458", "j"],
  ["\u0131", "i"],
  ["\u041A", "k"],
  ["\u043A", "k"],
  ["\u039A", "k"],
  ["\u03BA", "k"],
  ["\u029E", "k"],
  ["\u04CF", "l"],
  ["\u0141", "l"],
  ["\u0142", "l"],
  ["\u0196", "l"],
  ["\u1963", "l"],
  ["\u2113", "l"],
  ["\u217C", "l"],
  ["\uAAB6", "l"],
  ["\uFF4C", "l"],
  ["\u041C", "m"],
  ["\u043C", "m"],
  ["\u039C", "m"],
  ["\u03BC", "m"],
  ["\uAB51", "m"],
  ["\u039D", "n"],
  ["\u03BD", "n"],
  ["\u041F", "n"],
  ["\u043F", "n"],
  ["\u0510", "n"],
  ["\u0511", "n"],
  ["\u1952", "n"],
  ["\u{104E3}", "n"],
  ["\uAA80", "n"],
  ["\u041E", "o"],
  ["\u043E", "o"],
  ["\u039F", "o"],
  ["\u03BF", "o"],
  ["\u0AA1", "s"],
  ["\u00D8", "o"],
  ["\u00F8", "o"],
  ["\u0152", "o"],
  ["\u0153", "o"],
  ["\u0275", "o"],
  ["\u2C7A", "o"],
  ["\uA7BA", "o"],
  ["\uAAAE", "o"],
  ["\uFF4F", "o"],
  ["\u0420", "p"],
  ["\u0440", "p"],
  ["\u03A1", "p"],
  ["\u03C1", "p"],
  ["\u03F1", "g"],
  ["\uFF50", "p"],
  ["\u027F", "r"],
  ["\u0405", "s"],
  ["\u0455", "s"],
  ["\u03A3", "s"],
  ["\u03C3", "s"],
  ["\u03C2", "s"],
  ["\u015E", "s"],
  ["\u015F", "s"],
  ["\uABF1", "s"],
  ["\uFF53", "s"],
  ["\u0422", "t"],
  ["\u0442", "t"],
  ["\u03A4", "t"],
  ["\u03C4", "t"],
  ["\uFF54", "t"],
  ["\u0426", "u"],
  ["\u0446", "u"],
  ["\u03C5", "u"],
  ["\uAA8A", "u"],
  ["\u0425", "x"],
  ["\u0445", "x"],
  ["\u03A7", "x"],
  ["\u03C7", "x"],
  ["\uFF58", "x"],
  ["\u03A5", "y"],
  ["\u0443", "y"],
  ["\uFF59", "y"],
  ["\u0396", "z"],
  ["\u03B6", "z"]
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
  ["hardware", "hwid"],
  ["bind", "keybind"],
  ["binds", "keybind"],
  ["keybinds", "keybind"],
  ["proj", "projectile"],
  ["projectiles", "projectile"],
  ["rbx", "robux"],
  ["beat", "fight"],
  ["beats", "fight"],
  ["fighting", "fight"],
  ["losing", "lose"],
  ["lost", "lose"],
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

function foldEnclosedAlphanumericChar(char) {
  const codePoint = char.codePointAt(0);
  if (!Number.isFinite(codePoint)) return null;

  const upperRanges = [
    [0x24B6, 0x24CF],
    [0x1F130, 0x1F149],
    [0x1F150, 0x1F169],
    [0x1F170, 0x1F189],
    [0x1F1E6, 0x1F1FF]
  ];
  for (const [start, end] of upperRanges) {
    if (codePoint >= start && codePoint <= end) {
      return String.fromCharCode(0x61 + codePoint - start);
    }
  }

  if (codePoint >= 0x24D0 && codePoint <= 0x24E9) {
    return String.fromCharCode(0x61 + codePoint - 0x24D0);
  }

  return null;
}

function foldConfusableText(text) {
  return String(text || "")
    .replace(INVISIBLE_TEXT_RE, "")
    .normalize("NFKD")
    .replace(COMBINING_MARK_RE, "")
    .replace(/./gu, (char) =>
      CONFUSABLE_CHAR_MAP.get(char) || foldEnclosedAlphanumericChar(char) || char
    );
}

function getScriptMixMetadata(text) {
  const counts = {
    latin: 0,
    cyrillic: 0,
    greek: 0,
    otherLetters: 0
  };
  let letters = 0;
  const source = String(text || "");

  for (const char of source) {
    if (!/\p{Letter}/u.test(char)) continue;
    letters += 1;
    if (/\p{Script=Latin}/u.test(char)) counts.latin += 1;
    else if (/\p{Script=Cyrillic}/u.test(char)) counts.cyrillic += 1;
    else if (/\p{Script=Greek}/u.test(char)) counts.greek += 1;
    else counts.otherLetters += 1;
  }

  const usedScripts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([script]) => script);
  INVISIBLE_TEXT_RE.lastIndex = 0;
  const hadDefaultIgnorable = INVISIBLE_TEXT_RE.test(source);
  INVISIBLE_TEXT_RE.lastIndex = 0;

  return {
    ...counts,
    letters,
    usedScripts,
    hasMixedScripts: usedScripts.length > 1,
    hadDefaultIgnorable
  };
}

function applySecurityLeetText(text) {
  return String(text || "")
    .replace(/[@4]/g, "a")
    .replace(/3/g, "e")
    .replace(/[1!|]/g, "i")
    .replace(/0/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t");
}

function collapseRepeatedText(text) {
  return String(text || "").replace(/([a-z0-9])\1{2,}/g, "$1$1");
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

function buildNormalizedTextForms(text) {
  const source = String(text || "");
  const folded = foldConfusableText(source);
  const leetFolded = applySecurityLeetText(folded.toLowerCase());
  const normalized = cleanText(leetFolded)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const compact = normalized.replace(/\s+/g, "");
  const collapsed = collapseRepeatedText(normalized);
  const compactCollapsed = collapsed.replace(/\s+/g, "");

  return {
    raw: source,
    folded,
    normalized,
    compact,
    collapsed,
    compactCollapsed,
    scriptMix: getScriptMixMetadata(source)
  };
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
  buildNormalizedTextForms,
  collapseRepeatedText,
  foldConfusableText,
  getScriptMixMetadata,
  normalizeText,
  tokenize,
  containsPhrase,
  fuzzyTokenMatch,
  isEditDistanceAtMost,
  uniqueNormalized
};
