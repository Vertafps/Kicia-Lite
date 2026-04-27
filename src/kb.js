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
  "a",
  "an",
  "how",
  "what",
  "why",
  "where",
  "when",
  "which",
  "do",
  "did",
  "does",
  "is",
  "are",
  "can",
  "will",
  "use",
  "using",
  "to",
  "of",
  "on",
  "in",
  "at",
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
  "and",
  "work",
  "works",
  "working",
  "issue",
  "problem",
  "please",
  "pls",
  "rn"
]);
const SHORT_SIGNAL_TOKENS = new Set(["ui", "tp"]);

function keepSignalToken(token) {
  return (token.length > 2 || SHORT_SIGNAL_TOKENS.has(token)) && !LOW_SIGNAL_TOKENS.has(token);
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
    _normalizedTitle: normalizeText(entry.title),
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

function getMatchTokens(value) {
  return tokenize(value).filter((token) => token.length > 2 || SHORT_SIGNAL_TOKENS.has(token));
}

function scoreStrongPhraseHit(normalizedTranscript, transcriptTokens, phrase) {
  if (!phrase) return null;

  const allTermTokens = getMatchTokens(phrase);
  const termTokens = allTermTokens.filter(keepSignalToken);
  const tokenCount = Math.max(1, allTermTokens.length);
  const hasSignal = termTokens.length > 0;

  if (containsPhrase(normalizedTranscript, phrase)) {
    const wholePhrase = normalizeText(phrase) === normalizedTranscript;
    return {
      score: hasSignal ? 1 + Math.min(tokenCount, 6) * 0.15 + (wholePhrase ? 0.35 : 0) : 0.35,
      exact: true,
      hasSignal,
      wholePhrase,
      tokenCount
    };
  }

  if (!termTokens.length) return null;

  const fuzzyMatches = countNearbyTokenMatches(termTokens, transcriptTokens);
  if (!fuzzyMatches) return null;

  if (termTokens.length === 1) {
    const allMatches = countNearbyTokenMatches(allTermTokens, transcriptTokens);
    const genericCoverage = allMatches / Math.max(1, allTermTokens.length);
    return genericCoverage >= 0.75
      ? {
          score: 0.7,
          exact: false,
          hasSignal: true,
          wholePhrase: false,
          tokenCount
        }
      : null;
  }

  if (termTokens.length >= 3 && fuzzyMatches >= termTokens.length - 1) {
    return {
      score: 0.7,
      exact: false,
      hasSignal: true,
      wholePhrase: false,
      tokenCount
    };
  }
  if (termTokens.length === 2 && fuzzyMatches === 2) {
    return {
      score: 0.55,
      exact: false,
      hasSignal: true,
      wholePhrase: false,
      tokenCount
    };
  }
  return null;
}

function scoreKeywordHit(normalizedTranscript, transcriptTokens, keyword) {
  if (!keyword) return null;
  const termTokens = getMatchTokens(keyword).filter(keepSignalToken);
  const tokenCount = Math.max(1, getMatchTokens(keyword).length);

  if (containsPhrase(normalizedTranscript, keyword)) {
    return {
      score: keyword.includes(" ") ? 7 + Math.min(tokenCount, 5) * 0.4 : 3,
      exact: true,
      signalCount: termTokens.length,
      tokenCount
    };
  }

  if (!termTokens.length) return null;

  const exactMatches = termTokens.filter((token) => transcriptTokens.includes(token)).length;
  if (termTokens.length === 1 && transcriptTokens.some((token) => fuzzyTokenMatch(termTokens[0], token))) {
    return {
      score: 1.75,
      exact: false,
      signalCount: termTokens.length,
      tokenCount
    };
  }

  if (termTokens.length > 1 && exactMatches === termTokens.length) {
    return {
      score: 4.5,
      exact: false,
      signalCount: termTokens.length,
      tokenCount
    };
  }

  const fuzzyMatches = countNearbyTokenMatches(termTokens, transcriptTokens);
  if (termTokens.length > 1 && fuzzyMatches === termTokens.length) {
    return {
      score: 3.75,
      exact: false,
      signalCount: termTokens.length,
      tokenCount
    };
  }

  if (termTokens.length >= 3 && fuzzyMatches >= termTokens.length - 1) {
    return {
      score: 2.5,
      exact: false,
      signalCount: termTokens.length,
      tokenCount
    };
  }

  return null;
}

function scoreEntryAgainstText(normalizedTranscript, transcriptTokens, entry) {
  const strongPhraseHits = entry._matchPhrases
    .map((phrase) => scoreStrongPhraseHit(normalizedTranscript, transcriptTokens, phrase))
    .filter(Boolean);
  const bestStrongHit = strongPhraseHits.reduce(
    (best, hit) => (!best || hit.score > best.score ? hit : best),
    null
  );
  const strongScore = bestStrongHit
    ? bestStrongHit.score + Math.min(strongPhraseHits.length - 1, 3) * 0.12
    : 0;
  const exactStrongHits = strongPhraseHits.filter((hit) => hit.exact && hit.hasSignal).length;
  const exactWholeStrongHits = strongPhraseHits.filter((hit) => hit.exact && hit.hasSignal && hit.wholePhrase).length;
  const exactStrongTokenScore = strongPhraseHits
    .filter((hit) => hit.exact && hit.hasSignal)
    .reduce((best, hit) => Math.max(best, hit.tokenCount), 0);
  const keywordHits = [];
  const distinctKeywordHits = new Set();
  const exactKeywordHits = new Set();
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
    if (hit.exact && hit.signalCount > 0 && hit.tokenCount > 1) {
      exactKeywordHits.add(keyword);
    }
  }

  const titlePhraseMatch = containsPhrase(normalizedTranscript, entry._normalizedTitle);
  const titleTokensCount = tokenize(entry.title).length;
  const qualifies =
    exactStrongHits >= 1 ||
    strongScore >= 1 ||
    exactKeywordHits.size >= 1 ||
    (titlePhraseMatch && titleTokensCount >= 2) ||
    distinctKeywordHits.size >= 2 ||
    (strongScore >= 0.55 && (distinctKeywordHits.size >= 1 || titleTokenHits >= 1 || replyTokenHits >= 1)) ||
    (distinctKeywordHits.size >= 1 && titleTokenHits >= 2) ||
    (titleTokenHits >= 2 && replyTokenHits >= 2);

  const score =
    strongScore * 35 +
    exactStrongHits * 8 +
    exactWholeStrongHits * 14 +
    exactStrongTokenScore * 5 +
    (titlePhraseMatch ? (titleTokensCount >= 2 ? 15 : 5) : 0) +
    exactKeywordHits.size * 5 +
    keywordHits.reduce((sum, hit) => sum + hit.score, 0) +
    Math.min(titleTokenHits, 4) * 0.6 +
    Math.min(replyTokenHits, 5) * 0.3;

  return {
    strongScore,
    exactStrongHits,
    exactWholeStrongHits,
    exactStrongTokenScore,
    keywordHits,
    distinctKeywordHits,
    exactKeywordHits,
    titleTokenHits,
    replyTokenHits,
    titlePhraseMatch,
    titleTokensCount,
    qualifies,
    score
  };
}

function tryIssueMatch(transcript, kb) {
  const normalizedTranscript = normalizeText(transcript);
  if (!normalizedTranscript) return null;
  const transcriptTokens = tokenize(transcript);
  const transcriptLines = String(transcript || "")
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  const latestLine = transcriptLines[transcriptLines.length - 1] || null;
  const candidates = [];

  for (const entry of kb.issues || []) {
    const transcriptScore = scoreEntryAgainstText(normalizedTranscript, transcriptTokens, entry);
    if (!transcriptScore.qualifies) {
      continue;
    }

    if (
      transcriptTokens.length <= 2 &&
      !transcriptScore.strongScore &&
      transcriptScore.exactKeywordHits.size < 1 &&
      transcriptScore.distinctKeywordHits.size < 2 &&
      transcriptScore.titleTokenHits < 2
    ) {
      continue;
    }

    const perLineScores = transcriptLines.map((line) => {
      const lineTokens = tokenize(line);
      return {
        line,
        ...scoreEntryAgainstText(line, lineTokens, entry)
      };
    });
    const bestLineScore = perLineScores.reduce(
      (best, current) => (!best || current.score > best.score ? current : best),
      null
    );
    const latestLineScore = latestLine
      ? perLineScores.find((lineScore) => lineScore.line === latestLine) || null
      : null;
    const lineFocusBonus = bestLineScore?.qualifies ? bestLineScore.score * 0.35 : 0;
    const latestLineBonus = latestLineScore?.qualifies
      ? latestLineScore.score * (latestLineScore.strongScore >= 1 ? 1.8 : 0.7) +
        (latestLineScore.strongScore >= 1 ? 10 : 0)
      : 0;
    const score = transcriptScore.score + lineFocusBonus + latestLineBonus;

    // Vague input penalty: if transcript is just one or two words and we don't
    // have a strong phrase match or a multi-word title match, require a higher score.
    const isVagueInput = transcriptTokens.length <= 2 && !transcriptScore.strongScore;

    candidates.push({
      entry,
      score,
      strongScore: transcriptScore.strongScore,
      exactStrongHits: transcriptScore.exactStrongHits,
      exactKeywordHits: transcriptScore.exactKeywordHits.size,
      latestLineBonus,
      isVagueInput
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;

  const threshold = best.isVagueInput ? 10 : 6;
  if (!best.strongScore && best.score < threshold) return null;

  const runnerUp = candidates[1];
  const margin = best.exactStrongHits || best.exactKeywordHits ? 0.25 : best.strongScore ? 1 : 3;
  if (runnerUp && best.score - runnerUp.score < margin) {
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
