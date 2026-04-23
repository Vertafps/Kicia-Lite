const { fetchWithTimeout } = require("./utils/fetch");
const { KB_URL } = require("./config");
const { containsPhrase, fuzzyTokenMatch, isEditDistanceAtMost, normalizeText, tokenize, uniqueNormalized } = require("./text");

let _cache = null;
let _lastFetchOk = 0;
const REFRESH_MS = 10 * 60 * 1000;
const EXECUTOR_STATUSES = [
  "supported",
  "temporarily_not_working",
  "not_recommended",
  "unsupported"
];
const LOW_SIGNAL_TOKENS = new Set([
  "how",
  "what",
  "why",
  "where",
  "when",
  "which",
  "does",
  "is",
  "can",
  "use",
  "using",
  "with",
  "about",
  "help",
  "need",
  "want",
  "that",
  "this",
  "from",
  "have",
  "has",
  "get",
  "got",
  "just",
  "into",
  "your",
  "you",
  "for",
  "the",
  "and"
]);

function keepSignalToken(token) {
  return token.length > 2 && !LOW_SIGNAL_TOKENS.has(token);
}

function normalizeExecutorLinks(entry) {
  const seen = new Set();
  const links = [];
  const rawLinks = [
    entry.link,
    ...(Array.isArray(entry.links) ? entry.links : [])
  ];

  for (const rawLink of rawLinks) {
    let url = null;
    let label = null;

    if (typeof rawLink === "string") {
      url = rawLink.trim();
      label = `Open ${entry.name}`;
    } else if (rawLink && typeof rawLink === "object") {
      url = typeof rawLink.url === "string" ? rawLink.url.trim() : "";
      label = typeof rawLink.label === "string" && rawLink.label.trim() ? rawLink.label.trim() : `Open ${entry.name}`;
    }

    if (!url || seen.has(url)) continue;
    seen.add(url);
    links.push({ label, url });
  }

  return links;
}

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
    _titleTokens: [...new Set(tokenize(entry.title).filter(keepSignalToken))],
    _replyTokens: [
      ...new Set(
        tokenize(`${entry.reply || ""} ${(entry.steps || []).join(" ")}`).filter(keepSignalToken)
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
          type: entry.type || null,
          compatibility: entry.compatibility || null,
          reply: entry.reply || null,
          notes: Array.isArray(entry.notes) ? entry.notes.filter(Boolean) : entry.notes ? [entry.notes] : [],
          links: normalizeExecutorLinks(entry),
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

  // BUG FIX: bot_rules in the KB JSON is an object, not an array. The old
  // code did `|| []` as fallback which is fine, but the returned value was
  // inconsistently typed (object when present, array when absent). Normalise
  // to always be an object or null so callers don't have to guess.
  const rawBotRules = raw.bot_rules || raw.meta?.bot_rules || null;
  const botRules = rawBotRules && typeof rawBotRules === "object" && !Array.isArray(rawBotRules)
    ? rawBotRules
    : null;

  return {
    issues,
    executorsByStatus,
    executorAliasIndex,
    botRules
  };
}

async function fetchKb({ force = false } = {}) {
  if (!force && _cache && Date.now() - _lastFetchOk < REFRESH_MS) return _cache;
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

async function forceRefreshKb() {
  return fetchKb({ force: true });
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

function chooseBestFuzzyAlias(text, kb) {
  const textTokens = tokenize(text).filter((token) => token.length > 1);
  if (!textTokens.length) return null;

  let best = null;
  for (const [alias, executor] of Object.entries(kb.executorAliasIndex || {})) {
    const aliasTokens = tokenize(alias);
    if (!aliasTokens.length) continue;

    const matchesToken = (aliasToken, textToken) =>
      aliasToken === textToken ||
      fuzzyTokenMatch(aliasToken, textToken) ||
      (
        aliasToken.length >= 8 &&
        textToken.length >= 8 &&
        aliasToken.slice(0, 3) === textToken.slice(0, 3) &&
        isEditDistanceAtMost(aliasToken, textToken, 2)
      );

    const matches = aliasTokens.filter((aliasToken) =>
      textTokens.some((textToken) => matchesToken(aliasToken, textToken))
    ).length;
    if (!matches) continue;

    const coverage = matches / aliasTokens.length;
    const score =
      (matches === aliasTokens.length ? 8 : aliasTokens.length >= 3 && matches >= aliasTokens.length - 1 ? 5 : 0) +
      coverage +
      alias.length * 0.01;

    if (score < 5) continue;
    if (!best || score > best.score) {
      best = { score, executor };
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

  const fuzzyCandidateMatch = chooseBestFuzzyAlias(candidate, kb);
  if (fuzzyCandidateMatch) return fuzzyCandidateMatch;

  if (fallbackText) {
    return (
      chooseLongestAlias(fallbackText, kb) ||
      chooseBestFuzzyAlias(fallbackText, kb)
    );
  }
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

  const nearMatches = termTokens.filter((termToken) =>
    transcriptTokens.some((token) => token === termToken || fuzzyTokenMatch(termToken, token))
  ).length;
  if (termTokens.length >= 2 && nearMatches >= termTokens.length - 1) {
    return {
      score: 1.8
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
    const titleTokenHits = entry._titleTokens.filter((token) =>
      transcriptTokens.some((transcriptToken) => token === transcriptToken || fuzzyTokenMatch(token, transcriptToken))
    ).length;
    const replyTokenHits = entry._replyTokens.filter((token) =>
      transcriptTokens.some((transcriptToken) => token === transcriptToken || fuzzyTokenMatch(token, transcriptToken))
    ).length;

    for (const keyword of entry._keywords) {
      const hit = scoreKeywordHit(normalizedTranscript, transcriptTokens, keyword);
      if (!hit) continue;
      keywordHits.push(hit);
      distinctKeywordHits.add(keyword);
    }

    const titlePhraseMatch = containsPhrase(normalizedTranscript, normalizeText(entry.title));
    const titleTokensCount = tokenize(entry.title).length;

    if (
      !(
        strongScore >= 1 ||
        (titlePhraseMatch && titleTokensCount >= 2) ||
        distinctKeywordHits.size >= 2 ||
        (strongScore >= 0.55 && distinctKeywordHits.size >= 1) ||
        (distinctKeywordHits.size >= 1 && titleTokenHits >= 2) ||
        (titleTokenHits >= 2 && replyTokenHits >= 2)
      )
    ) {
      continue;
    }

    const score =
      strongScore * 30 +
      (titlePhraseMatch ? (titleTokensCount >= 2 ? 15 : 5) : 0) +
      keywordHits.reduce((sum, hit) => sum + hit.score, 0) +
      Math.min(titleTokenHits, 4) * 0.6 +
      Math.min(replyTokenHits, 5) * 0.3;

    // Vague input penalty: if transcript is just one or two words and we don't
    // have a strong phrase match or a multi-word title match, require a higher score.
    const isVagueInput = transcriptTokens.length <= 2 && !strongScore;

    candidates.push({
      entry,
      score,
      strongScore,
      isVagueInput
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;

  const threshold = best.isVagueInput ? 10 : 6;
  if (!best.strongScore && best.score < threshold) return null;

  const runnerUp = candidates[1];
  if (runnerUp && best.score - runnerUp.score < (best.strongScore ? 1 : 3)) {
    return null;
  }

  return best.entry;
}

module.exports = {
  fetchKb,
  forceRefreshKb,
  normalizeKb,
  findExecutorMatch,
  tryIssueMatch
};
