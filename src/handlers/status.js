const { CHANNEL_LOCK_ROLE_ID, BRAND } = require("../config");
const { getStatusJumpUrl } = require("../channel-config");
const { isNoResponseMessage } = require("../channel-policy");
const {
  buildPanel,
  buildRichPanel,
  DANGER,
  SUCCESS,
  WARN,
  INFO,
  brandAuthor,
  ansiPill,
  kpi,
  terminalBlock,
  ansi
} = require("../embed");
const { buildLinkButtonRows } = require("../components");
const { buildJarvisProgressBody, runJarvisDiagnostics } = require("../diagnostics");
const { forceRefreshKb } = require("../kb");
const { canUseOwnerCommands } = require("../permissions");
const { buildStatusReplyBody } = require("../router");
const { detectLongStatusPrompt, detectShortStatusPrompt } = require("../status-prompts");
const { getRuntimeStatus, setRuntimeStatus } = require("../runtime-status");
const { safeEdit, safeReact, safeReply } = require("../utils/respond");
const { getCooldownReaction, markGuildReply } = require("./cooldown");

function parseStatusCommand(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (normalized === "$status up") return "UP";
  if (normalized === "$status down") return "DOWN";
  if (normalized === "$status unaware" || normalized === "$status unknown") return "UNAWARE";
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

function isTestProMaxCommandMessage(content) {
  return String(content || "").trim().toLowerCase() === "$testpromax";
}

function isOwnerCommandMessage(content) {
  return (
    parseStatusCommand(content) !== null ||
    (isStatusCommandMessage(content) && !isPublicStatusQueryMessage(content)) ||
    isFetchCommandMessage(content) ||
    isJarvisCommandMessage(content) ||
    isTestProMaxCommandMessage(content)
  );
}

function isShortStatusPrompt(content) {
  return detectShortStatusPrompt(content);
}

function shouldAutoReplyStatus(content) {
  return isPublicStatusQueryMessage(content) || detectLongStatusPrompt(content) || isShortStatusPrompt(content);
}

function buildStatusEmbed(status = getRuntimeStatus()) {
  const tone = status === "DOWN" ? "danger" : status === "UNAWARE" ? "warn" : "success";
  const color = status === "DOWN" ? DANGER : status === "UNAWARE" ? WARN : SUCCESS;
  const description = [
    buildStatusReplyBody(status),
    terminalBlock([
      `${ansi("status", "dim")}   ${ansi(status, tone, { bold: true })}`,
      `${ansi("updates", "dim")}  ${ansi("posted in #status", "info")}`,
      `${ansi("command", "dim")}  ${ansi("$status", "white", { bold: true })} ${ansi("·", "dim")} ${ansi("$status up|down|unaware", "dim")}`
    ])
  ].join("\n\n");

  return buildRichPanel({
    color,
    author: brandAuthor("STATUS"),
    title: "📡 KiciaHook Status",
    description,
    fields: [
      kpi("STATE", status),
      kpi("UPDATES", "#status", { mono: true }),
      kpi("MODE", status === "UNAWARE" ? "review" : status === "DOWN" ? "incident" : "live")
    ],
    footer: `${BRAND.NAME} · status uplink ${status === "UP" ? "active" : status.toLowerCase()}`
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
    components: buildLinkButtonRows([{ label: "Open Status Channel", url: getStatusJumpUrl() }]),
    allowedMentions: { repliedUser: false }
  });

  if (message.inGuild?.()) {
    markGuildReply(message.author.id);
  }

  return true;
}

async function handleJarvisCommand(message, refreshKb, { deep = false } = {}) {
  if (!canUseOwnerCommands(message)) return true;

  const progressPayload = (body) => ({
    embeds: [
      buildPanel({
        header: deep ? "Systems sweep · Test Pro Max" : "Systems sweep in progress",
        body,
        color: INFO,
        author: brandAuthor(deep ? "JARVIS · TEST PRO MAX" : "JARVIS · WIZARD OF KICIA"),
        footer: deep ? "this can take up to 45s" : "this can take up to 30s"
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
    targetVisibleMs: deep ? 45_000 : undefined,
    onProgress: async ({ body }) => {
      await updateProgress(body);
    }
  });

  const finalPayload = {
    embeds: [
      buildPanel({
        header: deep ? "Sweep complete · full report" : "Sweep complete",
        body: report.body,
        color: report.color,
        author: brandAuthor(deep ? "JARVIS · REPORT · TPM" : "JARVIS · REPORT"),
        footer: report.color === WARN ? "Carrot · jarvis · attention needed" : "Carrot · jarvis · all systems nominal"
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
  const testProMaxCommand = isTestProMaxCommandMessage(message.content);

  const publicStatusQuery = statusCommand && isPublicStatusQueryMessage(message.content);

  if (publicStatusQuery && isNoResponseMessage(message)) {
    return false;
  }

  if (publicStatusQuery) {
    return maybeReplyWithPublicStatus(message, { useCooldown: false });
  }

  if (nextStatus || fetchCommand || jarvisCommand || testProMaxCommand || statusCommand) {
    if (!canUseOwnerCommands(message)) return true;
  }

  if (jarvisCommand || testProMaxCommand) {
    return handleJarvisCommand(message, refreshKb, { deep: testProMaxCommand });
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
          body:
            nextStatus === "DOWN"
              ? "set kiciahook status to **down**"
              : nextStatus === "UNAWARE"
                ? "set kiciahook status to **unaware** (review pending)"
                : "set kiciahook status to **up**",
          color: nextStatus === "DOWN" ? DANGER : nextStatus === "UNAWARE" ? WARN : SUCCESS
        })
      ],
      allowedMentions: { repliedUser: false }
    });
    return true;
  }

  if (statusCommand) {
    await safeReply(message, {
      embeds: [
        buildPanel({
          body: "usage: `$status`, `$status up`, `$status down`, `$status unaware`, `$fetch`, `$jarvis`, or `$testpromax`",
          color: INFO
        })
      ],
      allowedMentions: { repliedUser: false }
    });
    return true;
  }

  if (!shouldAutoReplyStatus(message.content)) return false;
  if (isNoResponseMessage(message)) return false;
  return maybeReplyWithPublicStatus(message);
}

module.exports = {
  parseStatusCommand,
  isFetchCommandMessage,
  isJarvisCommandMessage,
  isTestProMaxCommandMessage,
  isStatusCommandMessage,
  isPublicStatusQueryMessage,
  isOwnerCommandMessage,
  isShortStatusPrompt,
  shouldAutoReplyStatus,
  buildStatusEmbed,
  maybeHandleStatusCommand
};
