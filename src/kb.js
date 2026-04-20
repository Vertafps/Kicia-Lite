const { fetchWithTimeout } = require("./utils/fetch");
const { KB_URL } = require("./config");
const { containsPhrase, normalizeText, tokenize, uniqueNormalized } = require("./text");

let _cache = null;
let _lastFetchOk = 0;
const REFRESH_MS = 10 * 60 * 1000;
const EXECUTOR_STATUSES = [
  "supported",
  "temporarily_not_working",
  "not_recommended",
  "unsupported"
];

function normalizeKb(data) {
  const raw = Array.isArray(data) ? { issues: data } : data;
  if (!raw || !Array.isArray(raw.issues)) throw new Error("KB not an array");

  const issues = raw.issues.map((entry) => ({
    ...entry,
    category: entry.category || null,
    match_phrases: entry.match_phrases || entry.strong_keywords || [],
    strong_keywords: entry.strong_keywords || entry.match_phrases || [],
    _matchPhrases: uniqueNormalized(entry.match_phrases || entry.strong_keywords || []),
    _keywords: uniqueNormalized(entry.keywords || []),
    _titleTokens: [...new Set(tokenize(entry.title).filter((token) => token.length > 2))]
  }));

  const executorsByStatus = Object.fromEntries(
    EXECUTOR_STATUSES.map((status) => {
      const list = Array.isArray(raw.executors?.[status]) ? raw.executors[status] : [];
      return [
        status,
        list.map((entry) => ({
          ...entry,
          status,
          aliases: [...new Set([entry.name, ...(entry.aliases || [])])],
          normalizedAliases: uniqueNormalized([entry.name, ...(entry.aliases || [])])
        }))
      ];
    })
  );

  const executorAliasIndex = Object.create(null);
  for (const status of EXECUTOR_STATUSES) {
    for (const executor of executorsByStatus[status]) {
      for (const alias of executor.normalizedAliases) {
        if (!executorAliasIndex[alias]) executorAliasIndex[alias] = executor;
      }
    }
  }

  return {
    issues,
    executorsByStatus,
    executorAliasIndex,
    botRules: raw.bot_rules || raw.meta?.bot_rules || []
  };
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

function chooseLongestAlias(text, kb, { allowShort = false } = {}) {
  const normalizedText = normalizeText(text);
  let best = null;

  for (const [alias, executor] of Object.entries(kb.executorAliasIndex || {})) {
    if (!allowShort && alias.length < 4 && !alias.includes(" ")) continue;
    if (!containsPhrase(normalizedText, alias)) continue;
    if (!best || alias.length > best.alias.length) {
      best = { alias, executor };
    }
  }

  return best ? best.executor : null;
}

function findExecutorMatch(candidate, kb, { fallbackText } = {}) {
  const normalizedCandidate = normalizeText(candidate);
  if (normalizedCandidate && kb.executorAliasIndex?.[normalizedCandidate]) {
    return kb.executorAliasIndex[normalizedCandidate];
  }

  const candidateMatch = chooseLongestAlias(candidate, kb, { allowShort: true });
  if (candidateMatch) return candidateMatch;

  if (fallbackText) return chooseLongestAlias(fallbackText, kb);
  return null;
}

function scoreKeywordHit(normalizedTranscript, transcriptTokens, keyword) {
  if (!keyword) return null;
  if (containsPhrase(normalizedTranscript, keyword)) {
    return {
      score: keyword.includes(" ") ? 7 : 3
    };
  }

  const termTokens = tokenize(keyword).filter((token) => token.length > 2);
  if (termTokens.length > 1 && termTokens.every((token) => transcriptTokens.has(token))) {
    return {
      score: 4.5
    };
  }

  return null;
}

function tryIssueMatch(transcript, kb) {
  const normalizedTranscript = normalizeText(transcript);
  if (!normalizedTranscript) return null;
  const transcriptTokens = new Set(tokenize(transcript));
  const candidates = [];

  for (const entry of kb.issues || []) {
    const strongHits = entry._matchPhrases.filter((phrase) => containsPhrase(normalizedTranscript, phrase));
    const keywordHits = [];
    const distinctKeywordHits = new Set();

    for (const keyword of entry._keywords) {
      const hit = scoreKeywordHit(normalizedTranscript, transcriptTokens, keyword);
      if (!hit) continue;
      keywordHits.push(hit);
      distinctKeywordHits.add(keyword);
    }

    if (!(strongHits.length >= 1 || distinctKeywordHits.size >= 2)) continue;

    const titleTokenHits = entry._titleTokens.filter((token) => transcriptTokens.has(token)).length;
    const score =
      strongHits.length * 30 +
      keywordHits.reduce((sum, hit) => sum + hit.score, 0) +
      Math.min(titleTokenHits, 3) * 0.35;

    candidates.push({
      entry,
      score,
      strongHits: strongHits.length
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;
  if (!best.strongHits && best.score < 6) return null;

  const runnerUp = candidates[1];
  if (runnerUp && best.score - runnerUp.score < (best.strongHits ? 1 : 3)) {
    return null;
  }

  return best.entry;
}

module.exports = {
  fetchKb,
  normalizeKb,
  findExecutorMatch,
  tryIssueMatch
};
