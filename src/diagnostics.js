const { PermissionFlagsBits } = require("discord.js");
const {
  LINK_MODERATION_TIMEOUT_MS,
  SUSPICIOUS_ALERT_WINDOW_MS,
  SUSPICIOUS_TIMEOUT_THRESHOLD,
  SUSPICIOUS_TIMEOUT_MS,
  SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD,
  SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_MS,
  SELLING_CONFIDENCE_TIMEOUT_THRESHOLD,
  SELLING_CONFIDENCE_TIMEOUT_TIERS,
  SELLING_LOW_CONFIDENCE_THRESHOLD,
  SELLING_REPEAT_WINDOW_MS,
  SELLING_REPEAT_TIMEOUT_THRESHOLD,
  SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD,
  SELLING_TIMEOUT_MS,
  ENABLE_GUILD_MEMBER_EVENTS,
  GEMINI_API_KEY,
  GEMINI_SCAM_CACHE_MS,
  GEMINI_SCAM_FAILURE_COOLDOWN_MS,
  GEMINI_SCAM_MIN_INTERVAL_MS,
  GEMINI_SCAM_MODEL,
  GEMINI_SCAM_TIMEOUT_MS,
  FISHFISH_API_BASE_URL,
  GOOGLE_SAFE_BROWSING_API_KEY,
  GOOGLE_WEB_RISK_API_KEY,
  PHISHTANK_API_KEY,
  SCAM_PULSE_TIMEOUT_MS,
  VIRUSTOTAL_API_KEY
} = require("./config");
const {
  getChannelLockTargets,
  getDailyStatsChannelId,
  getLogChannelId,
  getNoResponseChannelIds,
  getStatusJumpUrl
} = require("./channel-config");
const { formatDuration } = require("./duration");
const { SUCCESS, WARN, ansi, terminalBlock } = require("./embed");
const { getScamPulseSnapshot } = require("./link-policy");
const { getRestrictedEmojiDatabaseSnapshot } = require("./restricted-emoji-db");
const { getRuntimeHealthSnapshot } = require("./runtime-health");
const { getRuntimeStatus } = require("./runtime-status");

const JARVIS_STEPS = [
  "Wake Core",
  "Runtime + Logs",
  "KB Cache",
  "Moderation Policy",
  "Guild Security",
  "Final Report"
];
const JARVIS_MIN_VISIBLE_MS = 15_000;
const JARVIS_MAX_VISIBLE_MS = 30_000;
const JARVIS_PROGRESS_MARKS = [0, 0.18, 0.38, 0.58, 0.78, 0.94, 1];
const LOG_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks
];
const LOCK_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels
];

function permissionLabel(permission) {
  switch (permission) {
    case PermissionFlagsBits.ViewChannel:
      return "View Channel";
    case PermissionFlagsBits.SendMessages:
      return "Send Messages";
    case PermissionFlagsBits.EmbedLinks:
      return "Embed Links";
    case PermissionFlagsBits.ManageChannels:
      return "Manage Channels";
    default:
      return String(permission);
  }
}

function formatRecentEvents(events) {
  if (!events.length) return "none since boot";
  return events
    .slice(0, 3)
    .map((event) => `${event.scope}: ${event.detail}`)
    .join(" | ");
}

function getMissingPermissionLabels(channel, member, permissions) {
  const channelPermissions = channel?.permissionsFor?.(member);
  if (!channelPermissions) {
    return permissions.map(permissionLabel);
  }

  return permissions
    .filter((permission) => !channelPermissions.has(permission))
    .map(permissionLabel);
}

async function resolveGuildChannel(guild, channelId) {
  const cached = guild?.channels?.cache?.get(channelId);
  if (cached) return cached;
  if (typeof guild?.channels?.fetch === "function") {
    return guild.channels.fetch(channelId).catch(() => null);
  }
  return null;
}

function describeLockState(channel, roleId) {
  const overwrite = channel?.permissionOverwrites?.cache?.get?.(roleId);
  if (overwrite?.deny?.has(PermissionFlagsBits.SendMessages)) return "locked";
  if (overwrite?.allow?.has(PermissionFlagsBits.SendMessages)) return "unlocked";
  return "neutral";
}

function buildJarvisProgressBody(stepIndex, note) {
  const completed = Math.max(0, Math.min(JARVIS_STEPS.length, stepIndex));
  const progressWidth = 24;
  const percent = Math.round((completed / Math.max(1, JARVIS_STEPS.length - 1)) * 100);
  const filled = Math.round((completed / Math.max(1, JARVIS_STEPS.length - 1)) * progressWidth);
  const filledBar = ansi("#".repeat(filled), "green", { bold: true });
  const emptyBar = ansi(".".repeat(Math.max(0, progressWidth - filled)), "dim");
  const activeStep = JARVIS_STEPS[Math.min(stepIndex, JARVIS_STEPS.length - 1)] || "Starting";
  const phaseIndex = Math.min(JARVIS_STEPS.length, Math.max(1, stepIndex + 1));

  const head = [
    `${ansi("JARVIS // Wizard of Kicia systems sweep", "cyan", { bold: true })}`
  ];

  const meta = [
    "",
    `${ansi("phase", "white")}   ${ansi(String(phaseIndex).padStart(2, "0"), "cyan", { bold: true })}${ansi("/" + String(JARVIS_STEPS.length).padStart(2, "0"), "dim")}  ${ansi(activeStep, "yellow")}`,
    `${ansi("scan", "white")}    ${ansi("[", "green")}${filledBar}${emptyBar}${ansi("]", "green")}  ${ansi(String(percent).padStart(3, " ") + "%", "cyan")}`,
    `${ansi(`window  ${formatDuration(JARVIS_MIN_VISIBLE_MS)}-${formatDuration(JARVIS_MAX_VISIBLE_MS)}`, "dim")}`,
    `${ansi("matrix  runtime | docs | moderation | security | intel", "dim")}`,
    ""
  ];

  const steps = JARVIS_STEPS.map((step, index) => {
    if (index < stepIndex) return `${ansi(`[OK  ] ${step}`, "green", { bold: true })}`;
    if (index === stepIndex) return `${ansi(`[RUN ] ${step}`, "yellow", { bold: true })}`;
    return `${ansi(`[WAIT] ${step}`, "dim")}`;
  });

  const lines = [...head, ...meta, ...steps];

  if (note) {
    lines.push("", `${ansi("now    " + note, "dim")}`);
  }

  return terminalBlock(lines);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function buildRuntimeSection(message) {
  const health = getRuntimeHealthSnapshot();
  const runtimeLines = [
    `**Status:** ${getRuntimeStatus()}`,
    `**Gateway Ping:** ${Number.isFinite(message.client?.ws?.ping) ? `${message.client.ws.ping}ms` : "unknown"}`,
    `**Warnings:** ${health.warnings.length}`,
    `**Recent Warnings:** ${formatRecentEvents(health.warnings)}`,
    `**Errors:** ${health.errors.length}`,
    `**Recent Errors:** ${formatRecentEvents(health.errors)}`
  ];

  const summary = terminalBlock([
    `${ansi("[", health.errors.length ? "red" : "green")}${ansi(health.errors.length ? "FAIL" : "OK  ", health.errors.length ? "red" : "green", { bold: true })}${ansi("]", health.errors.length ? "red" : "green")} ${ansi("runtime", "white")}      ${ansi(`gateway ${Number.isFinite(message.client?.ws?.ping) ? `${message.client.ws.ping}ms` : "unknown"} · ${health.warnings.length} warnings · ${health.errors.length} errors`, "dim")}`
  ]);

  return {
    text: `## Runtime\n${summary}\n${runtimeLines.join("\n")}`,
    hasIssue: health.errors.length > 0,
    summaryLine: {
      key: "RUNTIME",
      tone: health.errors.length ? "fail" : "ok",
      detail: `${Number.isFinite(message.client?.ws?.ping) ? `${message.client.ws.ping}ms` : "unknown"} · ${health.errors.length} errors`
    }
  };
}

function buildModerationGuardLines() {
  const sellingTierText = (SELLING_CONFIDENCE_TIMEOUT_TIERS || [])
    .map((tier) => `>${tier.threshold}% ${formatDuration(tier.timeoutMs)}`)
    .join(", ");
  return [
    [
      "**Link Guard:**",
      "docs/trusted/gifs/common-safe links pass;",
      "unknown low-risk links stay quiet;",
      "shorteners/invites warn;",
      `file hosts, homoglyphs, masked links, and malware files timeout ${formatDuration(LINK_MODERATION_TIMEOUT_MS)}`
    ].join(" "),
    "**Fake Info Alerts:** retired from public/log moderation; status questions still use runtime status replies",
    [
      "**Suspicious Alerts:**",
      `timeout at ${SUSPICIOUS_TIMEOUT_THRESHOLD} in ${formatDuration(SUSPICIOUS_ALERT_WINDOW_MS)}`,
      `timeout ${formatDuration(SUSPICIOUS_TIMEOUT_MS)}`,
      `or confidence > ${SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD}% timeout ${formatDuration(SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_MS)}`
    ].join(" "),
    "**Suspicious Rules:** private DM steering, credential/2FA asks, cracked/leaked/free premium, accidental-report scams, QR/OAuth steering, paste/run/download prompts",
    [
      "**Scam/Trade Guard:**",
      "context-first prefilter checks the target user's last 5 messages plus per-message reply context;",
      "message edits are re-scanned through the same moderation watcher;",
      "local Kicia policy + Naive Bayes classifier handles confident cases before remote AI;",
      GEMINI_API_KEY
        ? `Gemini ${GEMINI_SCAM_MODEL} handles borderline cases;`
        : "Gemini fallback optional/off, local detection remains active;",
      `AI cache ${formatDuration(GEMINI_SCAM_CACHE_MS)};`,
      `local AI gap ${formatDuration(GEMINI_SCAM_MIN_INTERVAL_MS)};`,
      `remote AI failure cooldown ${formatDuration(GEMINI_SCAM_FAILURE_COOLDOWN_MS)};`,
      `API timeout ${formatDuration(GEMINI_SCAM_TIMEOUT_MS)};`,
      `confirmed confidence ladder ${sellingTierText || `>${SELLING_CONFIDENCE_TIMEOUT_THRESHOLD}%`};`,
      `repeat fallback ${SELLING_REPEAT_TIMEOUT_THRESHOLD} hits in ${formatDuration(SELLING_REPEAT_WINDOW_MS)}`,
      `(${SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD} hits if confidence < ${SELLING_LOW_CONFIDENCE_THRESHOLD}%)`,
      `repeat timeout ${formatDuration(SELLING_TIMEOUT_MS)}`
    ].join(" ")
  ];
}

function buildIntelligenceGuardLines() {
  const pulse = getScamPulseSnapshot();
  const pulseCache = pulse.lastRefreshAt
    ? `${pulse.domains} domains / ${pulse.urls} URLs cached`
    : "cache pending";
  return [
    `**Scam Pulse:** FishFish URL/domain checks enabled (${FISHFISH_API_BASE_URL}); ${pulseCache}; verified pulse hits timeout ${formatDuration(SCAM_PULSE_TIMEOUT_MS)}; PhishTank ${PHISHTANK_API_KEY ? "enabled" : "optional/off"}`,
    `**Gemini Scam AI:** ${GEMINI_API_KEY ? `enabled (${GEMINI_SCAM_MODEL})` : "optional/off, local-only fallback active"}`,
    `**Safe Browsing:** ${GOOGLE_SAFE_BROWSING_API_KEY ? "enabled" : "optional/off"}`,
    `**Google Web Risk:** ${GOOGLE_WEB_RISK_API_KEY ? "enabled" : "optional/off"}`,
    `**VirusTotal:** ${VIRUSTOTAL_API_KEY ? "enabled" : "optional/off"}`
  ];
}

async function buildKbSection(refreshKb) {
  try {
    const kb = await refreshKb();
    const issueCount = Array.isArray(kb?.issues) ? kb.issues.length : 0;
    const executorAliases = Object.keys(kb?.executorAliasIndex || {}).length;
    const metaLines = [];
    if (kb?.meta?.version) metaLines.push(`**Version:** ${kb.meta.version}`);
    if (kb?.meta?.last_updated) metaLines.push(`**Last Updated:** ${kb.meta.last_updated}`);
    const summary = terminalBlock([
      `${ansi("[", "green")}${ansi("OK  ", "green", { bold: true })}${ansi("]", "green")} ${ansi("kb", "white")}           ${ansi(`${kb?.meta?.version || "loaded"} · refreshed · ${issueCount} issues · ${executorAliases} aliases`, "dim")}`
    ]);
    return {
      text: `## KB\n${summary}\n**Refresh:** ok\n${metaLines.length ? `${metaLines.join("\n")}\n` : ""}**Issues:** ${issueCount}\n**Executor Aliases:** ${executorAliases}`,
      hasIssue: false,
      summaryLine: {
        key: "KB",
        tone: "ok",
        detail: `${kb?.meta?.version || "loaded"} · ${issueCount} issues`
      }
    };
  } catch (err) {
    const summary = terminalBlock([
      `${ansi("[", "red")}${ansi("FAIL", "red", { bold: true })}${ansi("]", "red")} ${ansi("kb", "white")}           ${ansi(err.message, "red")}`
    ]);
    return {
      text: `## KB\n${summary}\n**Refresh:** failed\n**Error:** ${err.message}`,
      hasIssue: true,
      summaryLine: {
        key: "KB",
        tone: "fail",
        detail: err.message
      }
    };
  }
}

async function buildSecuritySection(message, channelLockRoleId) {
  if (!message.inGuild?.()) {
    return {
      text: "## Security\n**Scope:** dm mode, guild security checks skipped",
      hasIssue: false
    };
  }

  const guild = message.guild;
  const botMember = guild.members?.me;
  const securityLines = [];
  let hasIssue = false;

  const logChannelId = getLogChannelId();
  const dailyStatsChannelId = getDailyStatsChannelId();
  const noResponseChannelIds = getNoResponseChannelIds();
  const channelLockTargets = getChannelLockTargets();

  const logChannel = await resolveGuildChannel(guild, logChannelId);
  if (!logChannel) {
    securityLines.push(`**Logs Channel:** missing channel ${logChannelId}`);
    hasIssue = true;
  } else {
    const missing = getMissingPermissionLabels(logChannel, botMember, LOG_CHANNEL_PERMISSIONS);
    if (missing.length) hasIssue = true;
    securityLines.push(
      `**Logs Channel:** ${missing.length ? `missing ${missing.join(" / ")}` : `ok <#${logChannel.id}>`}`
    );
  }

  const dailyStatsChannel = await resolveGuildChannel(guild, dailyStatsChannelId);
  if (!dailyStatsChannel) {
    securityLines.push(`**Daily Stats Channel:** missing channel ${dailyStatsChannelId}`);
    hasIssue = true;
  } else {
    const missing = getMissingPermissionLabels(dailyStatsChannel, botMember, LOG_CHANNEL_PERMISSIONS);
    if (missing.length) hasIssue = true;
    securityLines.push(
      `**Daily Stats Channel:** ${missing.length ? `missing ${missing.join(" / ")}` : `ok <#${dailyStatsChannel.id}>`}`
    );
  }

  for (const channelId of noResponseChannelIds) {
    const channel = await resolveGuildChannel(guild, channelId);
    if (!channel) hasIssue = true;
    securityLines.push(
      `**No-Response Channel ${channelId}:** ${channel ? `ok <#${channel.id}>` : "missing"}`
    );
  }

  for (const target of channelLockTargets) {
    const channel = await resolveGuildChannel(guild, target.id);
    if (!channel) {
      securityLines.push(`**Lock Target ${target.label}:** missing (${target.id})`);
      hasIssue = true;
      continue;
    }

    const missing = getMissingPermissionLabels(channel, botMember, LOCK_CHANNEL_PERMISSIONS);
    const state = describeLockState(channel, channelLockRoleId);
    if (missing.length) hasIssue = true;
    securityLines.push(
      `**Lock Target ${target.label}:** ${missing.length ? `missing ${missing.join(" / ")}` : "ok"} | ${state}`
    );
  }

  try {
    const emojiDb = await getRestrictedEmojiDatabaseSnapshot();
    securityLines.push(
      `**Emoji DB:** ok | ${emojiDb.tableCounts.restrictedEmojis} restricted | timeout ${formatDuration(emojiDb.emojiTimeoutMs)}`
    );
    securityLines.push(
      `**Manual Moderation Whitelist:** ${emojiDb.tableCounts.moderationWhitelist || 0} users | lockdown unaffected`
    );
    securityLines.push(
      `**Trusted Links:** ${emojiDb.tableCounts.trustedLinks || 0} dynamic entries | static allowlist still loaded`
    );
    securityLines.push(
      `**Daily Tracking DB:** users ${emojiDb.tableCounts.dailyUsers} | channels ${emojiDb.tableCounts.dailyChannels} | staff ${emojiDb.tableCounts.dailyStaff}`
    );
    securityLines.push(
      `**Moderation Review DB:** ${emojiDb.tableCounts.moderationActions || 0} open action reviews | auto-cleaned after revert, expiry, and daily cleanup`
    );
    securityLines.push(
      `**Nickname Mod DB:** ${emojiDb.tableCounts.nicknamePatterns || 0} rename patterns | checked on messages${ENABLE_GUILD_MEMBER_EVENTS ? ", joins, and member updates" : "; join/update checks require ENABLE_GUILD_MEMBER_EVENTS=true"}`
    );
    securityLines.push(
      ENABLE_GUILD_MEMBER_EVENTS
        ? "**Impersonation Guard:** staff-name lookalikes on join are log-only for manual review"
        : "**Impersonation Guard:** join lookalike checks are installed but waiting for GuildMembers intent opt-in"
    );
    securityLines.push(
      ENABLE_GUILD_MEMBER_EVENTS
        ? "**Role Ops:** `$role all` member-list access enabled; bulk assignment still requires Manage Roles and role hierarchy"
        : "**Role Ops:** single-user role assignment enabled; `$role all` requires ENABLE_GUILD_MEMBER_EVENTS=true"
    );
    securityLines.push(
      ...buildIntelligenceGuardLines()
    );
    securityLines.push(
      ...buildModerationGuardLines()
    );
  } catch (err) {
    securityLines.push(`**Emoji DB:** failed (${err.message})`);
    hasIssue = true;
  }

  securityLines.push(`**Status Channel:** [Open](${getStatusJumpUrl(guild.id)})`);

  const detail = hasIssue ? "needs attention" : "all guards armed";
  const summary = terminalBlock([
    `${ansi("[", hasIssue ? "yellow" : "green")}${ansi(hasIssue ? "WARN" : "OK  ", hasIssue ? "yellow" : "green", { bold: true })}${ansi("]", hasIssue ? "yellow" : "green")} ${ansi("security", "white")}     ${ansi(detail, hasIssue ? "yellow" : "dim")}`
  ]);

  return {
    text: `## Security\n${summary}\n${securityLines.join("\n")}`,
    hasIssue,
    summaryLine: {
      key: "SECURITY",
      tone: hasIssue ? "warn" : "ok",
      detail
    }
  };
}

function pickJarvisVisibleMs(random = Math.random) {
  const roll = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(JARVIS_MIN_VISIBLE_MS + ((JARVIS_MAX_VISIBLE_MS - JARVIS_MIN_VISIBLE_MS) * roll));
}

async function waitForJarvisMark({
  startedAt,
  targetVisibleMs,
  mark,
  sleepFn,
  nowFn
}) {
  const targetElapsed = Math.round(targetVisibleMs * mark);
  const elapsed = nowFn() - startedAt;
  if (targetElapsed > elapsed) {
    await sleepFn(targetElapsed - elapsed);
  }
}

async function runJarvisDiagnostics(message, {
  refreshKb,
  channelLockRoleId,
  onProgress,
  targetVisibleMs,
  random = Math.random,
  sleepFn = sleep,
  nowFn = Date.now
} = {}) {
  const startedAt = nowFn();
  const visibleMs = Number.isFinite(targetVisibleMs)
    ? Math.max(0, Number(targetVisibleMs))
    : pickJarvisVisibleMs(random);
  const pace = (markIndex) => waitForJarvisMark({
    startedAt,
    targetVisibleMs: visibleMs,
    mark: JARVIS_PROGRESS_MARKS[markIndex] ?? 1,
    sleepFn,
    nowFn
  });
  const progress = async (stepIndex, note) => {
    if (typeof onProgress === "function") {
      await onProgress({
        stepIndex,
        stepName: JARVIS_STEPS[stepIndex],
        body: buildJarvisProgressBody(stepIndex, note),
        targetVisibleMs: visibleMs
      });
    }
  };

  await progress(0, "checking command uplink");
  await pace(1);

  await progress(1, "reading runtime status and recent logs");
  const runtimeSection = buildRuntimeSection(message);
  await pace(2);

  await progress(2, "refreshing KB and validating docs cache");
  const kbSection = await buildKbSection(refreshKb);
  await pace(3);

  await progress(3, "cross-checking false-info, suspicious, scam/trade, and link guard policy");
  await pace(4);

  await progress(4, "checking log channels, emoji db, daily tracking, no-response channels, and lockdown targets");
  const securitySection = await buildSecuritySection(message, channelLockRoleId);
  await pace(5);

  await progress(5, "compiling final report");
  await pace(6);
  const hasIssue = runtimeSection.hasIssue || kbSection.hasIssue || securitySection.hasIssue;

  const findings = terminalBlock([
    ...[runtimeSection.summaryLine, kbSection.summaryLine, securitySection.summaryLine]
      .filter(Boolean)
      .map((s) => {
        const tag = s.tone === "fail" ? "FAIL" : s.tone === "warn" ? "WARN" : "OK  ";
        const tagColor = s.tone === "fail" ? "red" : s.tone === "warn" ? "yellow" : "green";
        const labelPad = s.key.padEnd(10);
        return `${ansi("[", tagColor)}${ansi(tag, tagColor, { bold: true })}${ansi("]", tagColor)} ${ansi(labelPad, "white")} ${ansi(s.detail, "dim")}`;
      })
  ]);

  const verdict = hasIssue
    ? `${ansi("verdict", "yellow")}  ${ansi("attention needed", "yellow", { bold: true })}`
    : `${ansi("verdict", "green")}  ${ansi("all systems nominal", "green", { bold: true })}`;
  const findingsBlock = `## Findings\n${findings}\n${terminalBlock([verdict])}`;

  return {
    body: [findingsBlock, runtimeSection.text, kbSection.text, securitySection.text, "Sweep complete."].join("\n\n"),
    color: hasIssue ? WARN : SUCCESS
  };
}

module.exports = {
  buildJarvisProgressBody,
  buildIntelligenceGuardLines,
  buildModerationGuardLines,
  pickJarvisVisibleMs,
  runJarvisDiagnostics
};
