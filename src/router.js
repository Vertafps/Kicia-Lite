const { BRAND } = require("./config");
const { findExecutorMatch, tryIssueMatch } = require("./kb");
const { normalizeText } = require("./text");

const STATUS_UP_REPLY = "status says it's up rn";
const STATUS_DOWN_REPLY = "status says it's down rn";
const DOWN_NOTE = "btw, kiciahook is down rn, so that might be why";
const DOCS_HEADERS = [
  "\u{1F4DA} Found It Ez",
  "\u{1F4DA} Yeaaah Found It < 3",
  "\u{1F4DA} I Pinned It Down",
  "\u{1F4DA} Got It Right Here",
  "\u{1F4DA} Check This Out",
  "\u{1F4DA} I've Got The Docs"
];
const FALLBACK_HEADERS = [
  "\u{1F3AB} Couldn't Pin That Down",
  "\u{1F3AB} Not Seeing That In Docs",
  "\u{1F3AB} Didn't Lock That One In",
  "\u{1F3AB} That One's Not Clicking Yet",
  "\u{1F3AB} Still Looking Into It"
];
const SUPPORT_ONLY_HEADERS = [
  "\u{1F3AB} That One Needs Staff",
  "\u{1F3AB} Staff Need To Handle That One",
  "\u{1F3AB} That's One For The Staff Team",
  "\u{1F3AB} This One Needs A Ticket",
  "\u{1F3AB} Staff Intervention Required"
];

const STATUS_PATTERNS = [
  /^(?:kicia|kiciahook)?\s*status$/,
  /\b(?:is|was)\s+(?:kicia|kiciahook)\s+(?:down|up|working|online|offline)\b/,
  /\b(?:kicia|kiciahook)\s+(?:down|up|working|online|offline)\b/,
  /\b(?:is|was)\s+(?:kicia|kiciahook)\s+work(?:ing)?\b/,
  /\bdoes\s+(?:kicia|kiciahook)\s+work\b/,
  /\bcan\s+(?:kicia|kiciahook)\s+work\b/,
  /\bis\s+it\s+(?:down|up)\b/,
  /\bcurrent\s+status\b/
];
const EXECUTOR_SUPPORT_PATTERNS = [
  /\bis\s+(.+?)\s+supported\b/,
  /\bis\s+(.+?)\s+(?:working|compatible)\b/,
  /\bis\s+(.+?)\s+(?:good|okay|ok|fine)\s+(?:with|for)\s+(?:kicia|kiciahook)\b/,
  /\bdoes\s+(.+?)\s+work(?:s|ing)?\b/,
  /\bdoes\s+(?:kicia|kiciahook)\s+support\s+(.+?)$/,
  /\bdoes\s+(.+?)\s+support\s+(?:kicia|kiciahook)\b/,
  /\bcan\s+i\s+use\s+(.+?)\b/,
  /\bwhat\s+about\s+(.+?)(?:\s+executor)?$/,
  /\bsupport\s+(.+?)\s+with\s+(?:kicia|kiciahook)\b/,
  /\bsupport(?:ed)?\s+for\s+(.+?)$/,
  /\bcan\s+(.+?)\s+work\b/,
  /\b(?:what|which)\s+execs?\s+(?:are|is)\s+supported\b/
];
const EXECUTOR_INFO_PATTERNS = [
  /\bhow\s+can\s+i\s+get\s+(.+?)$/,
  /\bhow\s+do\s+i\s+get\s+(.+?)$/,
  /\bwhere\s+can\s+i\s+get\s+(.+?)$/,
  /\bwhere\s+do\s+i\s+get\s+(.+?)$/,
  /\bhow\s+can\s+i\s+download\s+(.+?)$/,
  /\bhow\s+do\s+i\s+download\s+(.+?)$/,
  /\bwhere\s+can\s+i\s+download\s+(.+?)$/,
  /\bwhere\s+do\s+i\s+download\s+(.+?)$/,
  /\btell\s+me\s+about\s+(.+?)(?:\s+executor)?$/,
  /\binfo(?:rmation)?\s+(?:on|about)\s+(.+?)(?:\s+executor)?$/,
  /\bwhere\s+is\s+the\s+link\s+for\s+(.+?)$/,
  /\bwhere\s+is\s+(.+?)\s+from\b/,
  /\blink\s+to\s+(.+?)$/
];
const FEATURE_PATTERNS = [
  /\bdoes\s+(?:kicia|kiciahook)\s+have\s+(.+?)$/,
  /\bwhere\s+is\s+(.+?)$/,
  /\bwhere\s+do\s+i\s+find\s+(.+?)$/,
  /\bwhere\s+can\s+i\s+find\s+(.+?)$/,
  /\bwhich\s+tab\s+(?:is|has)\s+(.+?)$/,
  /\bhow\s+do\s+i\s+find\s+(.+?)$/,
  /\bhow\s+to\s+use\s+(.+?)$/
];
// BUG FIX: removed duplicate "executor" entry from original
const EXECUTOR_WORD_RE = /\b(?:executor|executer|ececutor|exec)\b/;
const BAN_PATTERNS = [/\bban(?:ned)?\b/, /\bdetected\b/, /\banticheat\b/, /\bmod ban\b/, /\bgetting banned\b/];

function sanitizeExecutorCandidate(candidate) {
  // BUG FIX: removed duplicate "executor" in alternation from original
  return normalizeText(candidate)
    .replace(/\b(?:the|an|a|pls|please)\b/g, " ")
    .replace(/\b(?:executors?|exec|executer|ececutor|for kicia(?:hook)?|with kicia(?:hook)?)\b/g, " ")
    .replace(/\b(?:link|site|website|download|downloads|get|info|information)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFeatureCandidate(candidate) {
  return normalizeText(candidate)
    .replace(/\b(?:the|an|a|feature|features|thing|stuff|option|setting|please|pls)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTranscriptLines(text) {
  return String(text || "")
    .split(/\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function hashText(text) {
  let hash = 0;
  const normalized = normalizeText(text);
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function pickVariant(variants, seedText) {
  if (!Array.isArray(variants) || variants.length === 0) return "";
  return variants[hashText(seedText) % variants.length];
}

function detectStatusQuestion(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function detectBanQuestion(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return BAN_PATTERNS.some((pattern) => pattern.test(normalized));
}

function containsExecutorishWord(text) {
  // BUG FIX: removed duplicate "executor" from original regex
  return EXECUTOR_WORD_RE.test(normalizeText(text));
}

function hasExecutorIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return EXECUTOR_SUPPORT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractPatternCandidate(text, patterns) {
  const normalized = normalizeText(text);
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match || !match[1]) continue;
    const candidate = sanitizeExecutorCandidate(match[1]);
    if (candidate) return candidate;
  }
  return null;
}

function extractExecutorCandidate(text) {
  return extractPatternCandidate(text, EXECUTOR_SUPPORT_PATTERNS);
}

function extractExecutorInfoCandidate(text) {
  return extractPatternCandidate(text, EXECUTOR_INFO_PATTERNS);
}

function extractFeatureCandidate(text) {
  const normalized = normalizeText(text);
  for (const pattern of FEATURE_PATTERNS) {
    const match = normalized.match(pattern);
    if (!match || !match[1]) continue;
    const candidate = sanitizeFeatureCandidate(match[1]);
    if (candidate) return candidate;
  }
  return null;
}

function findBareExecutorCandidate(text, kb) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  if ((normalized.includes(" ") || normalized.length >= 4) && kb.executorAliasIndex?.[normalized]) {
    return kb.executorAliasIndex[normalized];
  }

  const sanitized = sanitizeExecutorCandidate(normalized);
  if (!sanitized || sanitized === normalized || !kb.executorAliasIndex?.[sanitized]) {
    return null;
  }

  if (sanitized.includes(" ") || sanitized.length >= 4 || containsExecutorishWord(normalized)) {
    return kb.executorAliasIndex[sanitized];
  }

  return null;
}

function detectExecutorListIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const asksChoice =
    /\bwhat\s+executor\s+should\s+i\s+use\b/.test(normalized) ||
    /\bwhich\s+executor\s+should\s+i\s+use\b/.test(normalized) ||
    /\bany\s+good\s+executors?\b/.test(normalized);
  const asksList =
    /\b(?:recommended|supported|best|good|list|show|working|work)\s+(?:free\s+|paid\s+)?executors?\b/.test(normalized) ||
    /\bwhat\s+(?:are\s+)?(?:the\s+)?(?:recommended|supported|best|working)\s+(?:free\s+|paid\s+)?executors?\b/.test(normalized) ||
    /\bwhat\s+(?:free\s+|paid\s+)?executors?\s+are\s+(?:recommended|supported|best|working|work)\b/.test(normalized) ||
    /\bwhich\s+(?:free\s+|paid\s+)?executors?\s+(?:are\s+)?(?:recommended|supported|working|work)\b/.test(normalized) ||
    /\bshow\s+me\s+(?:the\s+)?(?:recommended|supported|best|working)\s+(?:free\s+|paid\s+)?executors?\b/.test(normalized) ||
    /\bexecutors?\s+(?:that|which)?\s*(?:are\s+)?(?:working|work|supported)\b/.test(normalized);
  const mentionsExecutorSet = /\bexecutors?\b/.test(normalized);

  if (!asksChoice && !(asksList && mentionsExecutorSet)) return null;

  return {
    type: "executor_list",
    recommendedOnly: asksChoice || /\b(?:recommended|best|good)\b/.test(normalized),
    typeFilter: /\bfree\b/.test(normalized) ? "free" : /\bpaid\b/.test(normalized) ? "paid" : null
  };
}

function detectExecutorQuestion(text, kb) {
  const supportCandidate = extractExecutorCandidate(text);
  if (supportCandidate || hasExecutorIntent(text)) {
    return {
      type: "executor",
      line: normalizeText(text),
      candidate: supportCandidate,
      intent: "support"
    };
  }

  const infoCandidate = extractExecutorInfoCandidate(text);
  if (infoCandidate) {
    const knownExecutor = findExecutorMatch(infoCandidate, kb, { fallbackText: text });
    if (knownExecutor || containsExecutorishWord(text)) {
      return {
        type: "executor",
        line: normalizeText(text),
        candidate: infoCandidate,
        intent: "info"
      };
    }
  }

  const normalized = normalizeText(text);
  const knownExecutor = findExecutorMatch(normalized, kb);
  if (
    knownExecutor &&
    /\b(?:download|get|link|site|website|info|information|about)\b/.test(normalized)
  ) {
    return {
      type: "executor",
      line: normalized,
      candidate: knownExecutor.name,
      intent: "info"
    };
  }

  const bareExecutor = findBareExecutorCandidate(text, kb);
  if (bareExecutor) {
    return {
      type: "executor",
      line: normalized,
      candidate: bareExecutor.name,
      intent: "info"
    };
  }

  return null;
}

function buildFeatureSearchText(line, candidate) {
  if (!candidate) return line;
  return [line, `where is ${candidate}`, `where do i find ${candidate}`, candidate].join("\n");
}

function buildBanSearchText(line) {
  return [line, "will i get banned", "is kicia detected", "got banned"].join("\n");
}

function findLatestExplicitIntent(transcript, kb) {
  const lines = getTranscriptLines(transcript);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (detectStatusQuestion(line)) {
      return { type: "status", line };
    }

    const executorQuestion = detectExecutorQuestion(line, kb);
    if (executorQuestion) return executorQuestion;

    const executorList = detectExecutorListIntent(line);
    if (executorList) return { ...executorList, line };

    if (detectBanQuestion(line)) {
      return { type: "ban", line };
    }

    const featureCandidate = extractFeatureCandidate(line);
    if (featureCandidate) {
      return { type: "feature", line, candidate: featureCandidate };
    }
  }

  return null;
}

function formatType(type) {
  if (!type) return null;
  return normalizeText(type) === "free" ? "free" : normalizeText(type) === "paid" ? "paid" : type;
}

function isRecommendedExecutor(executor) {
  return /recommended/i.test(executor?.compatibility || "");
}

function filterExecutorsByType(executors, typeFilter) {
  if (!typeFilter) return executors;
  return executors.filter((executor) => normalizeText(executor.type) === normalizeText(typeFilter));
}

function sortExecutorsByPreference(executors) {
  return [...executors].sort((a, b) => Number(isRecommendedExecutor(b)) - Number(isRecommendedExecutor(a)));
}

function getSuggestedExecutors(kb, { typeFilter = null, limit = 4 } = {}) {
  const supported = filterExecutorsByType(kb.executorsByStatus?.supported || [], typeFilter);
  return sortExecutorsByPreference(supported).slice(0, limit);
}

function formatExecutorListLine(executor, { includeStatus = true } = {}) {
  const tags = [];
  if (executor.type) tags.push(formatType(executor.type));
  if (executor.compatibility) {
    tags.push(executor.compatibility);
  } else if (includeStatus) {
    tags.push(executor.status === "supported" ? "supported" : executor.status.replace(/_/g, " "));
  }
  const firstLink = executor.links?.[0];
  const linkText = firstLink ? ` - [link](${firstLink.url})` : "";
  return `- **${executor.name}**${tags.length ? ` - ${tags.join(", ")}` : ""}${linkText}`;
}

function getSupportedExecutorSelection(kb, { typeFilter = null } = {}) {
  const supported = filterExecutorsByType(kb.executorsByStatus?.supported || [], typeFilter);
  return sortExecutorsByPreference(supported);
}

function buildExecutorListReply(kb, options = {}) {
  const executors = getSupportedExecutorSelection(kb, options);
  const typeLabel = options.typeFilter ? `${formatType(options.typeFilter)} ` : "";

  if (!executors.length) {
    return {
      kind: "executor_list",
      header: "\u{1F9E9} Executor Picks",
      body: `not seeing a ${typeLabel}supported executor listed in the documentation rn`,
      color: "info"
    };
  }

  let intro = `here are the ${typeLabel}supported executors in docs rn:`;
  if (options.recommendedOnly) {
    intro = `these are the ${typeLabel}supported picks I'd point to first rn:`;
  }

  const lines = executors.map((executor) => formatExecutorListLine(executor, { includeStatus: false }));

  return {
    kind: "executor_list",
    header: "\u{1F9E9} Executor Picks",
    body: `${intro}\n\n${lines.join("\n")}`,
    color: "success"
  };
}

function buildExecutorDetails(executor) {
  const details = [];
  if (executor.type) details.push(`**Type:** ${formatType(executor.type)}`);
  if (executor.compatibility) details.push(`**Compatibility:** ${executor.compatibility}`);
  if (executor.notes?.length) details.push(`**Notes:** ${executor.notes.join(" ")}`);
  if (executor.reply) details.push(executor.reply);
  if (executor.links?.length > 1) {
    details.push(
      `**More links:** ${executor.links
        .slice(1)
        .map((link) => `[${link.label}](${link.url})`)
        .join(" | ")}`
    );
  }
  return details;
}

function buildSuggestedExecutorsText(kb, options = {}) {
  const suggestions = getSuggestedExecutors(kb, options);
  if (!suggestions.length) return null;
  return ["### Better picks rn", ...suggestions.map((executor) => formatExecutorListLine(executor, { includeStatus: false }))].join("\n");
}

function isFreshStandaloneQuestion(line) {
  return /^(?:how|what|why|where|when|which|can|does|is|are|do|did|will)\b/.test(line);
}

function shouldRejectIssueMatchForLatestLine(transcript, issueMatch, kb) {
  const lines = getTranscriptLines(transcript);
  if (lines.length < 2 || !issueMatch) return false;

  const latestLine = lines[lines.length - 1];
  if (!isFreshStandaloneQuestion(latestLine)) return false;

  const latestLineMatch = tryIssueMatch(latestLine, kb);
  return !latestLineMatch || latestLineMatch.title !== issueMatch.title;
}

function buildExecutorReply(executor, kb, { intent = "support" } = {}) {
  const suggestionText = buildSuggestedExecutorsText(kb);
  if (!executor) {
    const bodyLines = ["idk that exec, it's not in the documentation"];
    if (suggestionText) bodyLines.push(suggestionText);
    return {
      kind: "executor_unknown",
      header: "\u2753 Couldn't Find That Executor",
      body: bodyLines.join("\n\n"),
      color: "info"
    };
  }

  const details = buildExecutorDetails(executor);
  const firstLink = executor.links?.[0];
  let statusLine = `yeah, ${executor.name} is supported`;
  let color = "success";

  if (executor.status === "supported" && isRecommendedExecutor(executor)) {
    statusLine = `yeah, ${executor.name} is supported and recommended`;
  } else if (executor.status === "not_recommended") {
    statusLine = `${executor.name} can still work, but it's not one we recommend`;
    color = "warn";
  } else if (executor.status === "temporarily_not_working") {
    statusLine = `${executor.name} is listed, but it's not working rn`;
    color = "danger";
  } else if (executor.status === "unsupported") {
    statusLine = `nah, ${executor.name} isn't supported`;
    color = "danger";
  }

  const bodyLines = [`### ${executor.name}`, statusLine];
  if (intent === "info" || executor.status !== "supported" || details.length) {
    bodyLines.push(...details);
  }
  if (executor.status !== "supported" && suggestionText) {
    bodyLines.push(suggestionText);
  }

  return {
    kind: "executor",
    header: "\u{1F9E9} Executor Info",
    body: bodyLines.join("\n\n"),
    tip: firstLink ? `## \u{1F517} [Open ${executor.name}](${firstLink.url})` : undefined,
    tipStyle: "heading",
    tipLevel: "##",
    color
  };
}

/**
 * Build the inline answer body from a matched KB issue.
 * IMPROVEMENT: Shows the actual reply + steps + links inline instead of
 * just linking to docs, making the bot actually answer questions.
 */
function buildIssueBody(issue) {
  const parts = [];

  if (issue.reply) {
    parts.push(issue.reply);
  }

  if (Array.isArray(issue.steps) && issue.steps.length > 0) {
    const numbered = issue.steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
    parts.push(numbered);
  }

  if (Array.isArray(issue.links) && issue.links.length > 0) {
    const linkLines = issue.links
      .map((link) => {
        if (typeof link === "string") return link;
        if (link && link.url) return link.label ? `[${link.label}](${link.url})` : link.url;
        return null;
      })
      .filter(Boolean);
    if (linkLines.length) parts.push(linkLines.join("\n"));
  }

  return parts.join("\n\n") || null;
}

function maybeAppendDownNote(route, runtimeStatus) {
  if (runtimeStatus !== "DOWN") return route;
  if (route.kind === "status") return route;
  return {
    ...route,
    extra: route.extra ? `${route.extra}\n\n${DOWN_NOTE}` : DOWN_NOTE
  };
}

function classifyTranscript(transcript, kb, runtimeStatus = "UP") {
  const normalized = normalizeText(transcript);
  if (!normalized) {
    return {
      kind: "empty",
      header: "\u26A0\uFE0F Say What Happened First",
      body: "Send a short message about the problem, then ping me again and I'll check the docs.",
      color: "warn"
    };
  }

  const explicitIntent = findLatestExplicitIntent(transcript, kb);

  if (explicitIntent?.type === "status") {
    return {
      kind: "status",
      header: "\u{1F4E1} KiciaHook Status",
      body: runtimeStatus === "DOWN" ? STATUS_DOWN_REPLY : STATUS_UP_REPLY,
      color: runtimeStatus === "DOWN" ? "warn" : "success"
    };
  }

  if (explicitIntent?.type === "executor_list") {
    return maybeAppendDownNote(buildExecutorListReply(kb, explicitIntent), runtimeStatus);
  }

  if (explicitIntent?.type === "executor") {
    const executor = findExecutorMatch(explicitIntent.candidate || explicitIntent.line, kb, {
      fallbackText: explicitIntent.line
    });
    return maybeAppendDownNote(buildExecutorReply(executor, kb, explicitIntent), runtimeStatus);
  }

  const issueSearchText =
    explicitIntent?.type === "feature"
      ? buildFeatureSearchText(explicitIntent.line, explicitIntent.candidate)
      : explicitIntent?.type === "ban"
        ? buildBanSearchText(explicitIntent.line)
        : normalized;

  const issueMatch = tryIssueMatch(issueSearchText, kb);

  // IMPROVEMENT: if multi-line transcript didn't match, also try just the
  // latest line on its own — catches cases where older messages pollute the
  // transcript and the real question is in the last message only.
  let safeIssueMatch = shouldRejectIssueMatchForLatestLine(transcript, issueMatch, kb) ? null : issueMatch;
  if (!safeIssueMatch && issueSearchText === normalized) {
    const lines = getTranscriptLines(transcript);
    if (lines.length > 1) {
      const lastLineMatch = tryIssueMatch(lines[lines.length - 1], kb);
      if (lastLineMatch) safeIssueMatch = lastLineMatch;
    }
  }

  if (safeIssueMatch && safeIssueMatch.category !== "support_only") {
    // IMPROVEMENT: show the actual KB reply + steps inline instead of just
    // linking to docs — the bot now actually answers the question.
    const issueBody = buildIssueBody(safeIssueMatch);
    return maybeAppendDownNote(
      {
        kind: "docs",
        header: pickVariant(DOCS_HEADERS, safeIssueMatch.title || normalized),
        body: issueBody ? `### ${safeIssueMatch.title}\n\n${issueBody}` : `**${safeIssueMatch.title}**`,
        tip: `## \u{1F4D8} [Full docs](${BRAND.DOCS_JUMP_URL})`,
        tipStyle: "heading",
        tipLevel: "##",
        color: "success"
      },
      runtimeStatus
    );
  }

  const supportOnly = safeIssueMatch && safeIssueMatch.category === "support_only";
  return maybeAppendDownNote(
    {
      kind: "ticket",
      reason: supportOnly ? "support_only" : "fallback",
      header: supportOnly
        ? pickVariant(SUPPORT_ONLY_HEADERS, safeIssueMatch?.title || normalized)
        : pickVariant(FALLBACK_HEADERS, normalized),
      body: supportOnly
        ? `Hit the **[ticket panel](${BRAND.TICKET_JUMP_URL})** and staff will sort it out.`
        : `Open a ticket here: **[ticket panel](${BRAND.TICKET_JUMP_URL})**.`,
      tip: "Drop screenshots and what you've already tried.",
      color: supportOnly ? "warn" : "info"
    },
    runtimeStatus
  );
}

module.exports = {
  classifyTranscript,
  detectStatusQuestion,
  extractExecutorCandidate,
  getTranscriptLines,
  hasExecutorIntent,
  STATUS_UP_REPLY,
  STATUS_DOWN_REPLY,
  DOWN_NOTE
};
