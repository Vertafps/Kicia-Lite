const { OWNER_USER_ID, CHANNEL_LOCK_ROLE_ID } = require("../config");
const { buildPanel, DANGER, SUCCESS, WARN, INFO } = require("../embed");
const { buildJarvisProgressBody, runJarvisDiagnostics } = require("../diagnostics");
const { forceRefreshKb } = require("../kb");
const { buildStatusReplyBody } = require("../router");
const { detectLongStatusPrompt, detectShortStatusPrompt } = require("../status-prompts");
const { getRuntimeStatus, setRuntimeStatus } = require("../runtime-status");
const { safeEdit, safeReact, safeReply } = require("../utils/respond");
const { getCooldownReaction, markGuildReply } = require("./cooldown");

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
  return detectShortStatusPrompt(content);
}

function shouldAutoReplyStatus(content) {
  return isPublicStatusQueryMessage(content) || detectLongStatusPrompt(content) || isShortStatusPrompt(content);
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

  const progressPayload = (body) => ({
    embeds: [
      buildPanel({
        header: "Jarvis",
        body,
        color: INFO
      })
    ],
    allowedMentions: { repliedUser: false }
  });

  let progressMessage = null;
  try {
    progressMessage = await message.reply(progressPayload(buildJarvisProgressBody(0, "booting diagnostics")));
  } catch {}

  const updateProgress = async (body) => {
    if (!progressMessage) return;
    await safeEdit(progressMessage, progressPayload(body));
  };

  await updateProgress(buildJarvisProgressBody(0, "reading runtime status and recent logs"));
  const report = await runJarvisDiagnostics(message, {
    refreshKb,
    channelLockRoleId: CHANNEL_LOCK_ROLE_ID,
    onProgress: async ({ body }) => {
      await updateProgress(body);
    }
  });

  const finalPayload = {
    embeds: [
      buildPanel({
        header: "Jarvis Report",
        body: report.body,
        color: report.color
      })
    ],
    allowedMentions: { repliedUser: false }
  };

  if (progressMessage) {
    await progressMessage.edit(finalPayload).catch(() => null);
    return true;
  }

  await safeReply(message, finalPayload);

  return true;
}

async function maybeHandleStatusCommand(message, { refreshKb = forceRefreshKb } = {}) {
  const statusCommand = isStatusCommandMessage(message.content);
  const nextStatus = parseStatusCommand(message.content);
  const fetchCommand = isFetchCommandMessage(message.content);
  const jarvisCommand = isJarvisCommandMessage(message.content);

  if (statusCommand || nextStatus || fetchCommand || jarvisCommand) {
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

  if (statusCommand) {
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
