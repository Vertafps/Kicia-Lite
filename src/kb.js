const { fetchWithTimeout } = require("./utils/fetch");
const { KB_URL } = require("./config");

let _cache = null;
let _lastFetchOk = 0;
const REFRESH_MS = 10 * 60 * 1000;

function normalizeKb(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.issues)) {
    return data.issues.map((entry) => ({
      ...entry,
      strong_keywords: entry.strong_keywords || entry.match_phrases || []
    }));
  }
  throw new Error("KB not an array");
}

async function fetchKb() {
  if (_cache && Date.now() - _lastFetchOk < REFRESH_MS) return _cache;
  try {
    const res = await fetchWithTimeout(KB_URL, {}, 8000);
    if (!res.ok) throw new Error(`KB fetch ${res.status}`);
    const data = normalizeKb(await res.json());
    _cache = data;
    _lastFetchOk = Date.now();
    return data;
  } catch (err) {
    console.warn("KB fetch failed -- using stale cache:", err.message);
    if (_cache) return _cache;
    throw err;
  }
}

function hasWord(text, word) {
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(text);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stemToken(token) {
  if (token.length > 5 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function tokenize(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(Boolean)
    .map(stemToken);
}

function scoreTermMatch(normalizedTranscript, transcriptTokens, term) {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return 0;
  if (hasWord(normalizedTranscript, normalizedTerm)) {
    return normalizedTerm.includes(" ") ? 1.25 : 1;
  }

  const termTokens = tokenize(term).filter((token) => token.length > 2);
  if (!termTokens.length) return 0;

  const overlap = termTokens.filter((token) => transcriptTokens.has(token)).length;
  if (overlap === termTokens.length) return 0.75;
  if (termTokens.length >= 3 && overlap >= termTokens.length - 1) return 0.4;
  return 0;
}

function tryKeywordMatch(transcript, kb) {
  const normalizedTranscript = normalizeText(transcript);
  const transcriptTokens = new Set(tokenize(transcript));
  let best = null;
  let bestScore = 0;

  for (const entry of kb) {
    const kws = [...new Set((entry.keywords || []).map(normalizeText).filter(Boolean))];
    const strong = [...new Set((entry.strong_keywords || []).map(normalizeText).filter(Boolean))];
    const keywordScore = kws.reduce(
      (sum, keyword) => sum + scoreTermMatch(normalizedTranscript, transcriptTokens, keyword),
      0
    );
    const strongScore = strong.reduce(
      (sum, keyword) => sum + scoreTermMatch(normalizedTranscript, transcriptTokens, keyword),
      0
    );
    const qualifies = keywordScore >= 2 || strongScore >= 1;
    if (!qualifies) continue;

    const score = keywordScore + strongScore * 3;
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  return best;
}

module.exports = { fetchKb, tryKeywordMatch };
