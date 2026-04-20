const { BRAND } = require("./config");
const { findExecutorMatch, tryIssueMatch } = require("./kb");
const { normalizeText } = require("./text");

const STATUS_UP_REPLY = "nah bro <3, it's up";
const STATUS_DOWN_REPLY = "yeah, kiciahook is down rn";
const DOWN_NOTE = "btw, kiciahook is down rn, so that might be why";

const STATUS_PATTERNS = [
  /^(?:kicia|kiciahook)?\s*status$/,
  /\b(?:is|was)\s+(?:kicia|kiciahook)\s+(?:down|up|working|online|offline)\b/,
  /\b(?:kicia|kiciahook)\s+(?:down|up|working|online|offline)\b/,
  /\b(?:is|was)\s+(?:kicia|kiciahook)\s+work(?:ing)?\b/
];

const EXECUTOR_PATTERNS = [
  /\bis\s+(.+?)\s+supported\b/,
  /\bis\s+(.+?)\s+(?:working|compatible)\b/,
  /\bdoes\s+(.+?)\s+work\b/,
  /\bcan\s+i\s+use\s+(.+?)\b/,
  /\bwhat\s+about\s+(.+?)(?:\s+executor)?$/,
  /\bsupport(?:ed)?\s+for\s+(.+?)$/,
  /\bcan\s+(.+?)\s+work\b/
];

function sanitizeExecutorCandidate(candidate) {
  return normalizeText(candidate)
    .replace(/\b(?:the|an|a)\b/g, " ")
    .replace(/\b(?:executor|for kicia|with kicia)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectStatusQuestion(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasExecutorIntent(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return EXECUTOR_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractExecutorCandidate(text) {
  const normalized = normalizeText(text);
  for (const pattern of EXECUTOR_PATTERNS) {
    const match = normalized.match(pattern);
    if (!match || !match[1]) continue;
    const candidate = sanitizeExecutorCandidate(match[1]);
    if (candidate) return candidate;
  }
  return null;
}

function buildExecutorReply(executor) {
  if (!executor) {
    return {
      kind: "executor_unknown",
      body: "idk that exec, it's not in the KB",
      color: "info"
    };
  }

  if (executor.status === "supported") {
    const recommended = /recommended/i.test(executor.compatibility || "");
    return {
      kind: "executor",
      body: recommended
        ? `yeah, ${executor.name} is supported and recommended`
        : `yeah, ${executor.name} is supported`,
      color: "success",
      links: executor.links || []
    };
  }

  if (executor.status === "not_recommended") {
    return {
      kind: "executor",
      body: `${executor.name} can still work, but it's not one we recommend`,
      color: "warn",
      links: executor.links || []
    };
  }

  if (executor.status === "temporarily_not_working") {
    return {
      kind: "executor",
      body: `${executor.name} is listed, but it's not working rn`,
      color: "danger",
      links: executor.links || []
    };
  }

  return {
    kind: "executor",
    body: `nah, ${executor.name} isn't supported`,
    color: "danger",
    links: executor.links || []
  };
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
      header: "say what happened first",
      body: "send a short message about the problem, then ping me again and i'll check the docs.",
      color: "warn"
    };
  }

  if (detectStatusQuestion(normalized)) {
    return {
      kind: "status",
      body: runtimeStatus === "DOWN" ? STATUS_DOWN_REPLY : STATUS_UP_REPLY,
      color: runtimeStatus === "DOWN" ? "warn" : "success"
    };
  }

  const candidate = extractExecutorCandidate(normalized);
  if (candidate || hasExecutorIntent(normalized)) {
    const executor = findExecutorMatch(candidate || normalized, kb, { fallbackText: normalized });
    return maybeAppendDownNote(buildExecutorReply(executor), runtimeStatus);
  }

  const issueMatch = tryIssueMatch(normalized, kb);
  if (issueMatch && issueMatch.category !== "support_only") {
    return maybeAppendDownNote(
      {
        kind: "docs",
        header: "that one's in the docs",
        body: `looks like **${issueMatch.title}**`,
        tip: `[jump to docs](${BRAND.DOCS_JUMP_URL})`,
        color: "success"
      },
      runtimeStatus
    );
  }

  const supportOnly = issueMatch && issueMatch.category === "support_only";
  return maybeAppendDownNote(
    {
      kind: "ticket",
      reason: supportOnly ? "support_only" : "fallback",
      header: supportOnly ? "that one needs staff" : "couldn't pin that down",
      body: supportOnly
        ? `hit the **[ticket panel](${BRAND.TICKET_JUMP_URL})** and staff will sort it out`
        : `open a ticket here: **[ticket panel](${BRAND.TICKET_JUMP_URL})**`,
      tip: "drop screenshots and what you've already tried",
      color: supportOnly ? "warn" : "info"
    },
    runtimeStatus
  );
}

module.exports = {
  classifyTranscript,
  detectStatusQuestion,
  extractExecutorCandidate,
  hasExecutorIntent,
  STATUS_UP_REPLY,
  STATUS_DOWN_REPLY,
  DOWN_NOTE
};
