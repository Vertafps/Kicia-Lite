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
const {
  getScamDetectionEnabled,
  setScamDetectionEnabled,
  getPolicyEnforcementEnabled,
  setPolicyEnforcementEnabled
} = require("../restricted-emoji-db");
const { recordRuntimeEvent } = require("../runtime-health");
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

function parseScamCommand(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (normalized === "$scam" || normalized === "$scam status") return "status";
  if (normalized === "$scam enable" || normalized === "$scam on") return "enable";
  if (normalized === "$scam disable" || normalized === "$scam off") return "disable";
  return null;
}

function isScamCommandMessage(content) {
  return parseScamCommand(content) !== null;
}

function parsePolicyCommand(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (normalized === "$policy" || normalized === "$policy status") return "status";
  if (normalized === "$policy enable" || normalized === "$policy on") return "enable";
  if (normalized === "$policy disable" || normalized === "$policy off") return "disable";
  return null;
}

function isPolicyCommandMessage(content) {
  return parsePolicyCommand(content) !== null;
}

function isOwnerCommandMessage(content) {
  return (
    parseStatusCommand(content) !== null ||
    (isStatusCommandMessage(content) && !isPublicStatusQueryMessage(content)) ||
    isFetchCommandMessage(content) ||
    isJarvisCommandMessage(content) ||
    isTestProMaxCommandMessage(content) ||
    isScamCommandMessage(content) ||
    isPolicyCommandMessage(content)
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

async function handlePolicyCommand(message, action) {
  if (action === "status") {
    const enabled = await getPolicyEnforcementEnabled().catch(() => true);
    const body = enabled
      ? "policy enforcement is **ENABLED** — prohibited commerce (drugs/weapons) detection AND the broad link policy (KB blocklist + threat intel + heuristics) are active.\n\nuse `$policy disable` to drop everything except the FishFish-based scam-link blocking."
      : "policy enforcement is **DISABLED** — only the FishFish global phishing/malware blocklist is active. Prohibited commerce detection and broad link policy are OFF.\n\nuse `$policy enable` to turn the full layer back on.";
    await safeReply(message, {
      embeds: [buildPanel({ body, color: enabled ? SUCCESS : WARN })],
      allowedMentions: { repliedUser: false }
    });
    return true;
  }

  const targetState = action === "enable";
  let actualState;
  try {
    actualState = await setPolicyEnforcementEnabled(targetState);
  } catch (err) {
    recordRuntimeEvent("error", "policy-toggle", err?.message || err);
    await safeReply(message, {
      embeds: [buildPanel({ body: "couldn't persist that toggle — db write failed.", color: DANGER })],
      allowedMentions: { repliedUser: false }
    });
    return true;
  }

  recordRuntimeEvent(
    "info",
    "policy-toggle",
    `set to ${actualState ? "enabled" : "disabled"} by ${message.author?.id || "unknown"}`
  );

  const body = actualState
    ? "policy enforcement **enabled**. prohibited commerce + broad link policy + threat intel back on.\n\nuse `$policy disable` to fall back to FishFish-only link blocking."
    : "policy enforcement **disabled**. dropped:\n• prohibited commerce (drug/weapon detection)\n• KB-driven link blocklist\n• Google Safe Browsing / Web Risk / VirusTotal / PhishTank lookups\n• shortener expansion + URL heuristics\n\n_kept active:_ FishFish global scam/phishing/malware blocklist (`$status` Scam Pulse).\n\nuse `$policy enable` to turn the full layer back on.";

  await safeReply(message, {
    embeds: [buildPanel({ body, color: actualState ? SUCCESS : INFO })],
    allowedMentions: { repliedUser: false }
  });
  return true;
}

async function handleScamCommand(message, action) {
  if (action === "status") {
    const enabled = await getScamDetectionEnabled().catch(() => true);
    const body = enabled
      ? "scam/trade pattern detection is **ENABLED**.\n\nuse `$scam disable` to turn it off if false positives are spiking."
      : "scam/trade pattern detection is **DISABLED**.\n\nuse `$scam enable` to turn it back on.\n_(prohibited commerce / drug+weapon detection and link policy stay active either way)_";
    await safeReply(message, {
      embeds: [buildPanel({ body, color: enabled ? SUCCESS : WARN })],
      allowedMentions: { repliedUser: false }
    });
    return true;
  }

  const targetState = action === "enable";
  let actualState;
  try {
    actualState = await setScamDetectionEnabled(targetState);
  } catch (err) {
    recordRuntimeEvent("error", "scam-toggle", err?.message || err);
    await safeReply(message, {
      embeds: [buildPanel({ body: "couldn't persist that toggle — db write failed.", color: DANGER })],
      allowedMentions: { repliedUser: false }
    });
    return true;
  }

  recordRuntimeEvent(
    "info",
    "scam-toggle",
    `set to ${actualState ? "enabled" : "disabled"} by ${message.author?.id || "unknown"}`
  );

  const body = actualState
    ? "scam/trade pattern detection **enabled**. bot will flag scam-shaped messages again.\n\nuse `$scam disable` if it gets noisy."
    : "scam/trade pattern detection **disabled**. bot will skip pattern matching for scam/trade intent.\n\n_(prohibited commerce / drug+weapon detection and link policy still active.)_\n\nuse `$scam enable` to turn it back on.";

  await safeReply(message, {
    embeds: [buildPanel({ body, color: actualState ? SUCCESS : INFO })],
    allowedMentions: { repliedUser: false }
  });
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
  const scamCommand = parseScamCommand(message.content);
  const policyCommand = parsePolicyCommand(message.content);

  const publicStatusQuery = statusCommand && isPublicStatusQueryMessage(message.content);

  if (publicStatusQuery && isNoResponseMessage(message)) {
    return false;
  }

  if (publicStatusQuery) {
    return maybeReplyWithPublicStatus(message, { useCooldown: false });
  }

  if (nextStatus || fetchCommand || jarvisCommand || testProMaxCommand || statusCommand || scamCommand || policyCommand) {
    if (!canUseOwnerCommands(message)) return true;
  }

  if (scamCommand) {
    return handleScamCommand(message, scamCommand);
  }

  if (policyCommand) {
    return handlePolicyCommand(message, policyCommand);
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
          body: "usage: `$status`, `$status up`, `$status down`, `$status unaware`, `$fetch`, `$jarvis`, `$testpromax`, `$scam [enable|disable|status]`, or `$policy [enable|disable|status]`",
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
  parseScamCommand,
  parsePolicyCommand,
  isFetchCommandMessage,
  isJarvisCommandMessage,
  isScamCommandMessage,
  isPolicyCommandMessage,
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
