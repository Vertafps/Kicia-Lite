const { OWNER_USER_ID } = require("../config");
const { buildPanel, DANGER, SUCCESS, WARN, INFO } = require("../embed");
const { forceRefreshKb } = require("../kb");
const { buildStatusReplyBody, detectStatusQuestion } = require("../router");
const { getRuntimeStatus, setRuntimeStatus } = require("../runtime-status");
const { normalizeText } = require("../text");
const { getCooldownReaction, markGuildReply } = require("./cooldown");

const SHORT_STATUS_PATTERNS = [
  /^status$/,
  /^does\s+it\s+work$/,
  /^is\s+it\s+work(?:ing)?$/,
  /^it\s+work(?:ing)?$/,
  /^work(?:ing|s)?$/,
  /^not\s+work(?:ing)?$/,
  /^(?:doesnt|doesn\s+t|does\s+not)\s+work$/,
  /^(?:isnt|isn\s+t|is\s+not)\s+work(?:ing)?$/,
  /^(?:is\s+it\s+)?(?:borken|broken)$/,
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

function isOwnerCommandMessage(content) {
  return isStatusCommandMessage(content) || isFetchCommandMessage(content);
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
      await message.react?.(cooldownEmoji).catch(() => null);
      return true;
    }
  }

  await message.reply({
    embeds: [buildStatusEmbed(getRuntimeStatus())],
    allowedMentions: { repliedUser: false }
  });

  if (message.inGuild?.()) {
    markGuildReply(message.author.id);
  }

  return true;
}

async function maybeHandleStatusCommand(message, { refreshKb = forceRefreshKb } = {}) {
  const nextStatus = parseStatusCommand(message.content);
  const fetchCommand = isFetchCommandMessage(message.content);

  if (nextStatus || fetchCommand) {
    if (message.author?.id !== OWNER_USER_ID) return true;
  }

  if (fetchCommand) {
    try {
      await refreshKb();
      await message.reply({
        embeds: [
          buildPanel({
            body: "fetched latest kb and refreshed cache",
            color: SUCCESS
          })
        ],
        allowedMentions: { repliedUser: false }
      });
    } catch {
      await message.reply({
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
    await message.reply({
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

      await message.reply({
        embeds: [
          buildPanel({
            body: "usage: `$status`, `$status up`, or `$status down`",
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
  isStatusCommandMessage,
  isPublicStatusQueryMessage,
  isOwnerCommandMessage,
  isShortStatusPrompt,
  shouldAutoReplyStatus,
  buildStatusEmbed,
  maybeHandleStatusCommand
};
