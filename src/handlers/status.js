const { OWNER_USER_ID, CHANNEL_LOCK_ROLE_ID } = require("../config");
const { buildPanel, DANGER, SUCCESS, WARN, INFO } = require("../embed");
const { buildJarvisReport } = require("../diagnostics");
const { forceRefreshKb } = require("../kb");
const { buildStatusReplyBody, detectStatusQuestion } = require("../router");
const { getRuntimeStatus, setRuntimeStatus } = require("../runtime-status");
const { normalizeText } = require("../text");
const { safeReact, safeReply } = require("../utils/respond");
const { getCooldownReaction, markGuildReply } = require("./cooldown");

const SHORT_STATUS_PATTERNS = [
  /^status$/,
  /^does\s+it\s+work$/,
  /^does\s+it\s+works$/,
  /^is\s+it\s+work(?:ing)?$/,
  /^it\s+work(?:ing)?$/,
  /^still\s+work(?:ing|s)?$/,
  /^work(?:ing|s)?\s+rn$/,
  /^work(?:ing|s)?$/,
  /^not\s+work(?:ing)?$/,
  /^(?:doesnt|doesn\s+t|does\s+not)\s+work$/,
  /^(?:isnt|isn\s+t|is\s+not)\s+work(?:ing)?$/,
  /^(?:is\s+it\s+)?(?:borken|broken)$/,
  /^(?:is\s+it\s+)?(?:up|down)\s+rn$/,
  /^still\s+(?:up|down)$/,
  /^is\s+it\s+(?:up|down)$/,
  /^(?:up|down)$/
];

function parseStatusCommand(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (normalized === "$status up") return "UP";
  if (normalized === "$status down") return "DOWN";
  return null;
}

function isStatusCommandMessage(content) {
  return String(content || "").trim().toLowerCase().startsWith("$status");
}

function isPublicStatusQueryMessage(content) {
  return String(content || "").trim().toLowerCase() === "$status";
}

function isFetchCommandMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  return normalized === "$fetch" || normalized === "$refresh";
}

function isJarvisCommandMessage(content) {
  return String(content || "").trim().toLowerCase() === "$jarvis";
}

function isOwnerCommandMessage(content) {
  return isStatusCommandMessage(content) || isFetchCommandMessage(content) || isJarvisCommandMessage(content);
}

function isShortStatusPrompt(content) {
  const normalized = normalizeText(content);
  if (!normalized) return false;
  return SHORT_STATUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

function shouldAutoReplyStatus(content) {
  return isPublicStatusQueryMessage(content) || detectStatusQuestion(content) || isShortStatusPrompt(content);
}

function buildStatusEmbed(status = getRuntimeStatus()) {
  return buildPanel({
    header: "\u{1F4E1} KiciaHook Status",
    body: buildStatusReplyBody(status),
    color: status === "DOWN" ? WARN : SUCCESS
  });
}

async function maybeReplyWithPublicStatus(message, { useCooldown = true } = {}) {
  if (useCooldown && message.inGuild?.()) {
    const cooldownEmoji = getCooldownReaction(message.author?.id);
    if (cooldownEmoji) {
      await safeReact(message, cooldownEmoji);
      return true;
    }
  }

  await safeReply(message, {
    embeds: [buildStatusEmbed(getRuntimeStatus())],
    allowedMentions: { repliedUser: false }
  });

  if (message.inGuild?.()) {
    markGuildReply(message.author.id);
  }

  return true;
}

async function handleJarvisCommand(message, refreshKb) {
  if (message.author?.id !== OWNER_USER_ID) return true;

  const report = await buildJarvisReport(message, {
    refreshKb,
    channelLockRoleId: CHANNEL_LOCK_ROLE_ID
  });

  await safeReply(message, {
    embeds: [
      buildPanel({
        header: "Jarvis Report",
        body: report,
        color: INFO
      })
    ],
    allowedMentions: { repliedUser: false }
  });

  return true;
}

async function maybeHandleStatusCommand(message, { refreshKb = forceRefreshKb } = {}) {
  const nextStatus = parseStatusCommand(message.content);
  const fetchCommand = isFetchCommandMessage(message.content);
  const jarvisCommand = isJarvisCommandMessage(message.content);

  if (nextStatus || fetchCommand || jarvisCommand) {
    if (message.author?.id !== OWNER_USER_ID) return true;
  }

  if (jarvisCommand) {
    return handleJarvisCommand(message, refreshKb);
  }

  if (fetchCommand) {
    try {
      await refreshKb();
      await safeReply(message, {
        embeds: [
          buildPanel({
            body: "fetched latest kb and refreshed cache",
            color: SUCCESS
          })
        ],
        allowedMentions: { repliedUser: false }
      });
    } catch {
      await safeReply(message, {
        embeds: [
          buildPanel({
            body: "couldn't fetch latest kb rn",
            color: DANGER
          })
        ],
        allowedMentions: { repliedUser: false }
      });
    }
    return true;
  }

  if (nextStatus) {
    setRuntimeStatus(nextStatus);
    await safeReply(message, {
      embeds: [
        buildPanel({
          body: nextStatus === "DOWN" ? "set kiciahook status to down" : "set kiciahook status to up",
          color: nextStatus === "DOWN" ? WARN : SUCCESS
        })
      ],
      allowedMentions: { repliedUser: false }
    });
    return true;
  }

  if (isStatusCommandMessage(message.content)) {
    if (message.author?.id === OWNER_USER_ID) {
      if (isPublicStatusQueryMessage(message.content)) {
        return maybeReplyWithPublicStatus(message, { useCooldown: false });
      }

      await safeReply(message, {
        embeds: [
          buildPanel({
            body: "usage: `$status`, `$status up`, `$status down`, `$fetch`, or `$jarvis`",
            color: INFO
          })
        ],
        allowedMentions: { repliedUser: false }
      });
      return true;
    }

    if (!isPublicStatusQueryMessage(message.content)) {
      return true;
    }

    return maybeReplyWithPublicStatus(message, { useCooldown: false });
  }

  if (!shouldAutoReplyStatus(message.content)) return false;
  return maybeReplyWithPublicStatus(message);
}

module.exports = {
  parseStatusCommand,
  isFetchCommandMessage,
  isJarvisCommandMessage,
  isStatusCommandMessage,
  isPublicStatusQueryMessage,
  isOwnerCommandMessage,
  isShortStatusPrompt,
  shouldAutoReplyStatus,
  buildStatusEmbed,
  maybeHandleStatusCommand
};
