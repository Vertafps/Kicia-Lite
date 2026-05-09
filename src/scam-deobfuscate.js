"use strict";

const { foldConfusableText } = require("./text");

const LEET_MAP = {
  "0": "o",
  "1": "l",
  "2": "z",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  "$": "s",
  "!": "i",
  "|": "l"
};

const SCAM_LEXICON = [
  "selling", "sell", "sold", "seller", "resell", "reseller", "reselling",
  "buying", "buy", "bought", "buyer",
  "trading", "trade", "trader", "swap", "swapping", "exchange", "exchanging",
  "wts", "wtb",
  "kiciahook", "kicia",
  "premium", "prem", "license", "licence", "key", "keys",
  "executor", "executors", "exec", "config", "configs", "cfg", "cfgs", "script", "scripts",
  "account", "accounts", "acc", "alts",
  "robux", "rbx", "nitro", "ue",
  "paypal", "cashapp", "crypto", "venmo", "zelle", "btc", "eth",
  "cheap", "cheaper", "free", "discount",
  "dm", "dms", "pm", "inbox", "private",
  "hvh", "rage", "legit", "for", "from", "with", "and", "the", "your", "my", "me", "im"
];

const TIER_LEXICON = SCAM_LEXICON.filter((word) => !["dm", "pm", "ue", "for", "from", "with", "and", "the", "my", "me", "im"].includes(word));

const HIGH_VALUE_LEXICON = new Set([
  "selling", "sell", "sold", "buying", "buy", "trading", "trade", "swap", "wts", "wtb",
  "kicia", "kiciahook", "premium", "license", "key", "executor", "config", "cheap", "free",
  "paypal", "cashapp", "crypto", "robux", "nitro", "reseller", "account"
]);

const SCAM_LEXICON_SET = new Set(SCAM_LEXICON);

const FUZZY_VARIANTS = new Map([
  ["seling", "selling"],
  ["sllng", "selling"],
  ["sellng", "selling"],
  ["selng", "selling"],
  ["sellin", "selling"],
  ["sealing", "selling"],
  ["saeling", "selling"],
  ["saelling", "selling"],
  ["stelling", "selling"],
  ["sel", "sell"],
  ["selz", "sell"],
  ["tradng", "trading"],
  ["tradin", "trading"],
  ["tradn", "trading"],
  ["traidng", "trading"],
  ["traidnk", "trading"],
  ["traedink", "trading"],
  ["trde", "trade"],
  ["trd", "trade"],
  ["trad", "trade"],
  ["buyng", "buying"],
  ["buyn", "buying"],
  ["byng", "buying"],
  ["buyin", "buying"],
  ["chep", "cheap"],
  ["cheep", "cheap"],
  ["chap", "cheap"],
  ["cheaap", "cheap"],
  ["premiun", "premium"],
  ["premum", "premium"],
  ["preium", "premium"],
  ["prm", "prem"],
  ["pre", "prem"],
  ["kica", "kicia"],
  ["kcia", "kicia"],
  ["kicka", "kicia"],
  ["kh", "kicia"],
  ["execu+tor", "executor"],
  ["execter", "executor"],
  ["confg", "config"],
  ["confgs", "configs"],
  ["cfk", "cfg"],
  ["fig", "cfg"],
  ["figs", "cfgs"],
  ["acc0unt", "account"],
  ["akkount", "account"],
  ["ackount", "account"],
  ["acnt", "account"],
  ["acnts", "accounts"],
  ["fre", "free"],
  ["fre3", "free"],
  ["nittro", "nitro"]
]);

const PROTECTED_BRAND_FRAGMENTS = ["kicia", "kiciah", "kiciahook", "kica", "kicka", "kcia"];

const SORTED_LEXICON = [...new Set(SCAM_LEXICON)].sort((a, b) => b.length - a.length);

function applyLeet(text) {
  let out = "";
  let count = 0;
  for (const ch of text) {
    const replacement = LEET_MAP[ch];
    if (replacement != null) {
      out += replacement;
      count += 1;
    } else {
      out += ch;
    }
  }
  return { text: out, count };
}

function collapseIntraWordSpacing(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return { text, runs: [], collapsed: 0, singles: 0 };

  const runs = [];
  const out = [];
  let totalSingles = 0;
  let i = 0;

  while (i < tokens.length) {
    const start = i;
    let singleLetters = 0;
    while (i < tokens.length && tokens[i].length <= 3 && /^[a-z]+$/i.test(tokens[i])) {
      if (tokens[i].length === 1) singleLetters += 1;
      i += 1;
    }
    const runLen = i - start;

    if (runLen >= 4 && singleLetters >= 3) {
      const merged = tokens.slice(start, i).join("");
      out.push(merged);
      runs.push({ tokens: tokens.slice(start, i), merged, length: runLen, singles: singleLetters });
      totalSingles += singleLetters;
    } else {
      for (let j = start; j < i; j += 1) out.push(tokens[j]);
      if (i < tokens.length) {
        out.push(tokens[i]);
        i += 1;
      }
    }
  }

  return {
    text: out.join(" "),
    runs,
    collapsed: runs.reduce((sum, r) => sum + r.length, 0),
    singles: totalSingles
  };
}

function splitByLexicon(token) {
  const matches = [];
  const segments = [];
  let unknown = "";
  let i = 0;

  while (i < token.length) {
    let matched = null;
    for (const word of SORTED_LEXICON) {
      if (word.length < 3) continue;
      if (token.startsWith(word, i)) {
        matched = word;
        break;
      }
    }
    if (matched) {
      if (unknown) {
        segments.push(unknown);
        unknown = "";
      }
      segments.push(matched);
      matches.push(matched);
      i += matched.length;
    } else {
      unknown += token[i];
      i += 1;
    }
  }

  if (unknown) segments.push(unknown);

  return {
    text: segments.join(" ").trim() || token,
    matches: matches.length,
    matchedWords: matches,
    highValueMatches: matches.filter((m) => HIGH_VALUE_LEXICON.has(m)).length
  };
}

function levenshtein(a, b) {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const prev = new Array(bl + 1);
  const curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j += 1) prev[j] = j;
  for (let i = 1; i <= al; i += 1) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= bl; j += 1) prev[j] = curr[j];
  }
  return prev[bl];
}

const FUZZY_TARGET_LEXICON = [
  "selling", "trading", "buying", "swap", "swapping", "exchange", "wts", "wtb",
  "kicia", "kiciahook", "premium", "license", "key", "keys",
  "executor", "config", "configs", "account", "accounts", "script", "robux", "nitro",
  "cheap", "free", "paypal", "cashapp", "crypto"
];

function fuzzyMatchLexicon(token) {
  if (!token) return null;
  if (SCAM_LEXICON_SET.has(token)) return null;
  if (FUZZY_VARIANTS.has(token)) return FUZZY_VARIANTS.get(token);

  for (const word of SORTED_LEXICON) {
    if (Math.abs(word.length - token.length) > 2) continue;
    if (word === token) return null;
    const collapsed = word.replace(/(.)\1+/g, "$1");
    if (collapsed === token) return word;
  }

  if (token.length < 5) return null;

  for (const word of FUZZY_TARGET_LEXICON) {
    if (word === token) continue;
    if (word.length < 5) continue;
    if (Math.abs(word.length - token.length) > 2) continue;
    const maxDist = word.length >= 7 ? 2 : 1;
    if (levenshtein(token, word) <= maxDist) return word;
  }

  return null;
}

function countSuspiciousFragments(text) {
  let count = 0;
  for (const fragment of PROTECTED_BRAND_FRAGMENTS) {
    const re = new RegExp(`\\b${fragment}\\b`, "gi");
    const matches = text.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

function deobfuscate(rawText) {
  const original = String(rawText || "");
  const folded = foldConfusableText(original).toLowerCase();

  const punctStripped = folded.replace(/[`*_~|>[\](){},.!?;:"'\\\/#%^&+=-]+/g, " ");
  const leet = applyLeet(punctStripped);
  const collapse = collapseIntraWordSpacing(leet.text);

  const tokens = collapse.text.split(/\s+/).filter(Boolean);
  const cleanedTokens = [];
  let lexiconSplitMatches = 0;
  let highValueSplitMatches = 0;
  let fuzzyRestores = 0;

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (!/^[a-z0-9]+$/i.test(lowered)) {
      cleanedTokens.push(lowered);
      continue;
    }

    if (SCAM_LEXICON_SET.has(lowered)) {
      cleanedTokens.push(lowered);
      continue;
    }

    const fuzzy = fuzzyMatchLexicon(lowered);
    if (fuzzy) {
      cleanedTokens.push(fuzzy);
      fuzzyRestores += 1;
      continue;
    }

    if (lowered.length >= 6) {
      const split = splitByLexicon(lowered);
      if (split.matches >= 1) {
        cleanedTokens.push(split.text);
        lexiconSplitMatches += split.matches;
        highValueSplitMatches += split.highValueMatches;
        continue;
      }
    }

    cleanedTokens.push(lowered);
  }

  const cleaned = cleanedTokens.join(" ").replace(/\s+/g, " ").trim();

  const lengthRatio = original.length > 0 ? cleaned.length / original.length : 0;
  const compactBonus = lengthRatio > 0 && lengthRatio < 0.55 ? 14 : 0;

  let score = 0;
  score += Math.min(50, collapse.singles * 8);
  score += Math.min(30, leet.count * 3);
  score += Math.min(40, lexiconSplitMatches * 12);
  score += Math.min(50, highValueSplitMatches * 16);
  score += Math.min(20, fuzzyRestores * 8);
  score += compactBonus;

  const revealedHighValue =
    highValueSplitMatches > 0 ||
    (fuzzyRestores > 0 && /\b(?:selling|trading|buying|cheap|kicia|premium|free)\b/.test(cleaned) &&
      !/\b(?:selling|trading|buying|cheap|kicia|premium|free)\b/.test(folded));
  if (revealedHighValue) score += 25;

  const suspiciousBefore = countSuspiciousFragments(folded);
  const suspiciousAfter = countSuspiciousFragments(cleaned);
  if (suspiciousAfter > suspiciousBefore) score += 18;

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    original,
    cleaned,
    score,
    revealedHighValue,
    runs: collapse.runs,
    leetSubstitutions: leet.count,
    lexiconSplitMatches,
    highValueSplitMatches,
    fuzzyRestores,
    singletonRunChars: collapse.singles
  };
}

function deobfuscateMany(texts) {
  const results = (Array.isArray(texts) ? texts : [texts])
    .filter((t) => t != null && String(t).trim() !== "")
    .map((t) => deobfuscate(t));

  if (!results.length) {
    return { cleaned: "", score: 0, revealedHighValue: false, results: [] };
  }

  const maxScore = Math.max(...results.map((r) => r.score));
  const combined = results.map((r) => r.cleaned).join("\n").trim();
  const revealedHighValue = results.some((r) => r.revealedHighValue);

  return {
    cleaned: combined,
    score: maxScore,
    revealedHighValue,
    results
  };
}

module.exports = {
  deobfuscate,
  deobfuscateMany,
  splitByLexicon,
  fuzzyMatchLexicon,
  SCAM_LEXICON,
  HIGH_VALUE_LEXICON
};
