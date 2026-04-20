const { fetchWithTimeout } = require("./utils/fetch");
const { KB_URL } = require("./config");
const { containsPhrase, fuzzyTokenMatch, normalizeText, tokenize, uniqueNormalized } = require("./text");

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
    _titleTokens: [...new Set(tokenize(entry.title).filter((token) => token.length > 2))],
    _replyTokens: [
      ...new Set(
        tokenize(`${entry.reply || ""} ${(entry.steps || []).join(" ")}`).filter((token) => token.length > 2)
      )
    ]
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

function countNearbyTokenMatches(termTokens, transcriptTokens) {
  let matchCount = 0;
  for (const termToken of termTokens) {
    if (transcriptTokens.some((token) => fuzzyTokenMatch(termToken, token))) {
      matchCount += 1;
    }
  }
  return matchCount;
}

function scoreStrongPhraseHit(normalizedTranscript, transcriptTokens, phrase) {
  if (!phrase) return 0;
  if (containsPhrase(normalizedTranscript, phrase)) return 1;

  const termTokens = tokenize(phrase).filter((token) => token.length > 2);
  if (!termTokens.length) return 0;

  const fuzzyMatches = countNearbyTokenMatches(termTokens, transcriptTokens);
  if (termTokens.length >= 3 && fuzzyMatches >= termTokens.length - 1) return 0.7;
  if (termTokens.length === 2 && fuzzyMatches === 2) return 0.55;
  return 0;
}

function scoreKeywordHit(normalizedTranscript, transcriptTokens, keyword) {
  if (!keyword) return null;
  if (containsPhrase(normalizedTranscript, keyword)) {
    return {
      score: keyword.includes(" ") ? 7 : 3
    };
  }

  const termTokens = tokenize(keyword).filter((token) => token.length > 2);
  if (!termTokens.length) return null;

  const exactMatches = termTokens.filter((token) => transcriptTokens.includes(token)).length;
  if (termTokens.length === 1 && transcriptTokens.some((token) => fuzzyTokenMatch(termTokens[0], token))) {
    return {
      score: 1.75
    };
  }

  if (termTokens.length > 1 && exactMatches === termTokens.length) {
    return {
      score: 4.5
    };
  }

  const fuzzyMatches = countNearbyTokenMatches(termTokens, transcriptTokens);
  if (termTokens.length > 1 && fuzzyMatches === termTokens.length) {
    return {
      score: 3.75
    };
  }

  if (termTokens.length >= 3 && fuzzyMatches >= termTokens.length - 1) {
    return {
      score: 2.5
    };
  }

  return null;
}

function tryIssueMatch(transcript, kb) {
  const normalizedTranscript = normalizeText(transcript);
  if (!normalizedTranscript) return null;
  const transcriptTokens = tokenize(transcript);
  const candidates = [];

  for (const entry of kb.issues || []) {
    const strongPhraseScores = entry._matchPhrases
      .map((phrase) => scoreStrongPhraseHit(normalizedTranscript, transcriptTokens, phrase))
      .filter((score) => score > 0);
    const strongScore = strongPhraseScores.reduce((sum, score) => sum + score, 0);
    const keywordHits = [];
    const distinctKeywordHits = new Set();

    for (const keyword of entry._keywords) {
      const hit = scoreKeywordHit(normalizedTranscript, transcriptTokens, keyword);
      if (!hit) continue;
      keywordHits.push(hit);
      distinctKeywordHits.add(keyword);
    }

    if (!(strongScore >= 1 || distinctKeywordHits.size >= 2 || (strongScore >= 0.55 && distinctKeywordHits.size >= 1))) {
      continue;
    }

    const titleTokenHits = entry._titleTokens.filter((token) =>
      transcriptTokens.some((transcriptToken) => fuzzyTokenMatch(token, transcriptToken))
    ).length;
    const replyTokenHits = entry._replyTokens.filter((token) =>
      transcriptTokens.some((transcriptToken) => fuzzyTokenMatch(token, transcriptToken))
    ).length;
    const score =
      strongScore * 30 +
      keywordHits.reduce((sum, hit) => sum + hit.score, 0) +
      Math.min(titleTokenHits, 3) * 0.35 +
      Math.min(replyTokenHits, 4) * 0.2;

    candidates.push({
      entry,
      score,
      strongScore
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;
  if (!best.strongScore && best.score < 6) return null;

  const runnerUp = candidates[1];
  if (runnerUp && best.score - runnerUp.score < (best.strongScore ? 1 : 3)) {
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
