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
const viz = require("../embed-viz");
const { buildJarvisProgressBody, buildJarvisProgressTokens, runJarvisDiagnostics } = require("../diagnostics");
const { forceRefreshKb } = require("../kb");
const { canUseOwnerCommands } = require("../permissions");
const { buildStatusReplyBody } = require("../router");
const { detectLongStatusPrompt, detectShortStatusPrompt } = require("../status-prompts");
const { getRuntimeStatus, setRuntimeStatus } = require("../runtime-status");
const { safeEdit, safeReact, safeReply } = require("../utils/respond");
const { getCooldownReaction, markGuildReply } = require("./cooldown");
const ui = require("../ui");

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

function buildStatusReplyPayload(status = getRuntimeStatus()) {
  const ribbon = status === "UP"
    ? Array.from({ length: 96 }, () => "up")
    : status === "UNAWARE"
      ? Array.from({ length: 96 }, (_, i) => (i >= 88 ? "unaware" : "up"))
      : Array.from({ length: 96 }, (_, i) => (i >= 90 ? "down" : i >= 86 ? "unaware" : "up"));
  const incidents7d = status === "UP" ? 0 : 1;
  const uptime = incidents7d === 0
    ? 100
    : status === "UNAWARE" ? 99.50 : 98.20;

  const result = ui.buildStatusEmbed({
    status,
    uptime,
    latencyMs: 0,
    ribbon,
    lastDown: status === "UP" ? "—" : "earlier today",
    incidents7d: String(incidents7d)
  });

  return { embed: result.embeds[0], files: result.files };
}

function buildStatusEmbed(status = getRuntimeStatus()) {
  return buildStatusReplyPayload(status).embed;
}

async function maybeReplyWithPublicStatus(message, { useCooldown = true } = {}) {
  if (useCooldown && message.inGuild?.()) {
    const cooldownEmoji = getCooldownReaction(message.author?.id);
    if (cooldownEmoji) {
      await safeReact(message, cooldownEmoji);
      return true;
    }
  }

  const built = buildStatusReplyPayload(getRuntimeStatus());
  await safeReply(message, {
    embeds: [built.embed],
    files: built.files,
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

  const progressPayload = (stepIndex, note) => {
    const tokens = buildJarvisProgressTokens(stepIndex, note);
    const title = `JARVIS // wizard-of-kicia · phase ${String(tokens.phaseIndex).padStart(2, "0")}/${String(tokens.total).padStart(2, "0")}`;
    const img = viz.makeImageAttachment(`jarvis-progress-${tokens.phaseIndex}`, viz.terminalPaneSvg({ title, lines: tokens.lines, width: viz.VIZ_W }));
    const description = `Diagnosing runtime, KB cache, moderation policy, intelligence vendors, and guild security.\n\n*phase ${tokens.phaseIndex}/${tokens.total} · ${tokens.activeStep}*`;
    const embed = buildPanel({
      header: deep ? "Systems sweep · Test Pro Max" : "Systems sweep in progress",
      body: description,
      color: INFO,
      author: brandAuthor(deep ? "JARVIS · TEST PRO MAX" : "JARVIS · WIZARD OF KICIA"),
      image: img ? img.url : undefined,
      footer: deep ? "this can take up to 45s" : "this can take up to 30s"
    });
    return {
      embeds: [embed],
      files: img ? [img.attachment] : [],
      allowedMentions: { repliedUser: false }
    };
  };

  let progressMessage = null;
  try {
    progressMessage = await message.reply(progressPayload(0, "booting diagnostics"));
  } catch {}

  const updateProgress = async (stepIndex, note) => {
    if (!progressMessage) return;
    await safeEdit(progressMessage, progressPayload(stepIndex, note));
  };

  await updateProgress(0, "reading runtime status and recent logs");
  const report = await runJarvisDiagnostics(message, {
    refreshKb,
    channelLockRoleId: CHANNEL_LOCK_ROLE_ID,
    targetVisibleMs: deep ? 45_000 : undefined,
    onProgress: async ({ stepIndex, body }) => {
      // body is the ANSI text version, but we render the SVG version via stepIndex+note
      const noteMatch = body.match(/now\s+([^`]+?)(?:```)?$/m);
      const note = noteMatch ? noteMatch[1].trim() : null;
      await updateProgress(stepIndex, note);
    }
  });

  const findings = (report.sectionSummaries || [])
    .filter((s) => s.tone !== "ok")
    .map((s) => ({
      key: s.key,
      severity: s.tone === "fail" ? "fail" : "warn",
      line: s.detail
    }));
  const runId = `J-${String(Date.now()).slice(-4)}`;
  const sweep = ui.buildSweepReportEmbed({
    systems: report.scorecard,
    findings,
    runId
  });
  const finalPayload = {
    embeds: sweep.embeds,
    components: sweep.components,
    files: sweep.files,
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
  buildStatusReplyPayload,
  maybeHandleStatusCommand
};
