const { PermissionFlagsBits } = require("discord.js");
const {
  BRAND,
  DAILY_STATS_CHANNEL_ID,
  LINK_MODERATION_TIMEOUT_MS,
  LOG_CHANNEL_ID,
  NO_RESPONSE_CHANNEL_IDS,
  CHANNEL_LOCK_TARGETS,
  SUSPICIOUS_ALERT_WINDOW_MS,
  SUSPICIOUS_TIMEOUT_THRESHOLD,
  SUSPICIOUS_TIMEOUT_MS,
  SELLING_CONFIDENCE_TIMEOUT_THRESHOLD,
  SELLING_LOW_CONFIDENCE_THRESHOLD,
  SELLING_REPEAT_WINDOW_MS,
  SELLING_REPEAT_TIMEOUT_THRESHOLD,
  SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD,
  SELLING_TIMEOUT_MS
} = require("./config");
const { formatDuration } = require("./duration");
const { SUCCESS, WARN } = require("./embed");
const { getRestrictedEmojiDatabaseSnapshot } = require("./restricted-emoji-db");
const { getRuntimeHealthSnapshot } = require("./runtime-health");
const { getRuntimeStatus } = require("./runtime-status");

const JARVIS_STEPS = [
  "Wake core",
  "Runtime and log scan",
  "KB refresh",
  "Moderation matrix",
  "Security audit",
  "Final compile"
];
const JARVIS_STEP_DELAY_MS = 1_800;
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
  const progressWidth = 12;
  const filled = Math.round((completed / Math.max(1, JARVIS_STEPS.length - 1)) * progressWidth);
  const progressBar = `${"#".repeat(filled)}${"-".repeat(Math.max(0, progressWidth - filled))}`;
  const lines = [
    "JARVIS // diagnostic sweep online",
    `Core heat: [${progressBar}]`,
    "Running staged checks; max sweep target is under 15 seconds.",
    "",
    ...JARVIS_STEPS.map((step, index) => {
      if (index < stepIndex) return `[ok] ${step}`;
      if (index === stepIndex) return `[scan] ${step}`;
      return `[wait] ${step}`;
    })
  ];

  if (note) {
    lines.push("", `**Current:** ${note}`);
  }

  return lines.join("\n");
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

  return {
    text: `## Runtime\n${runtimeLines.join("\n")}`,
    hasIssue: health.errors.length > 0
  };
}

function buildModerationGuardLines() {
  return [
    `**Link Guard:** docs allowlist + trusted extras + tenor | timeout ${formatDuration(LINK_MODERATION_TIMEOUT_MS)}`,
    "**False Info Guard:** status + executor claim mismatch alerts to logs",
    [
      "**Suspicious Alerts:**",
      `timeout at ${SUSPICIOUS_TIMEOUT_THRESHOLD} in ${formatDuration(SUSPICIOUS_ALERT_WINDOW_MS)}`,
      `timeout ${formatDuration(SUSPICIOUS_TIMEOUT_MS)}`
    ].join(" "),
    "**Suspicious Rules:** private DM steering, credential asks, cracked/leaked/free premium, paste/run/download prompts",
    [
      "**Selling Guard:**",
      `timeout when confidence > ${SELLING_CONFIDENCE_TIMEOUT_THRESHOLD}%`,
      `or ${SELLING_REPEAT_TIMEOUT_THRESHOLD} hits in ${formatDuration(SELLING_REPEAT_WINDOW_MS)}`,
      `(${SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD} hits if confidence < ${SELLING_LOW_CONFIDENCE_THRESHOLD}%)`,
      `timeout ${formatDuration(SELLING_TIMEOUT_MS)}`
    ].join(" ")
  ];
}

async function buildKbSection(refreshKb) {
  try {
    const kb = await refreshKb();
    const issueCount = Array.isArray(kb?.issues) ? kb.issues.length : 0;
    const executorAliases = Object.keys(kb?.executorAliasIndex || {}).length;
    return {
      text: `## KB\n**Refresh:** ok\n**Issues:** ${issueCount}\n**Executor Aliases:** ${executorAliases}`,
      hasIssue: false
    };
  } catch (err) {
    return {
      text: `## KB\n**Refresh:** failed\n**Error:** ${err.message}`,
      hasIssue: true
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

  const logChannel = await resolveGuildChannel(guild, LOG_CHANNEL_ID);
  if (!logChannel) {
    securityLines.push(`**Logs Channel:** missing channel ${LOG_CHANNEL_ID}`);
    hasIssue = true;
  } else {
    const missing = getMissingPermissionLabels(logChannel, botMember, LOG_CHANNEL_PERMISSIONS);
    if (missing.length) hasIssue = true;
    securityLines.push(
      `**Logs Channel:** ${missing.length ? `missing ${missing.join(" / ")}` : `ok <#${logChannel.id}>`}`
    );
  }

  const dailyStatsChannel = await resolveGuildChannel(guild, DAILY_STATS_CHANNEL_ID);
  if (!dailyStatsChannel) {
    securityLines.push(`**Daily Stats Channel:** missing channel ${DAILY_STATS_CHANNEL_ID}`);
    hasIssue = true;
  } else {
    const missing = getMissingPermissionLabels(dailyStatsChannel, botMember, LOG_CHANNEL_PERMISSIONS);
    if (missing.length) hasIssue = true;
    securityLines.push(
      `**Daily Stats Channel:** ${missing.length ? `missing ${missing.join(" / ")}` : `ok <#${dailyStatsChannel.id}>`}`
    );
  }

  for (const channelId of NO_RESPONSE_CHANNEL_IDS) {
    const channel = await resolveGuildChannel(guild, channelId);
    if (!channel) hasIssue = true;
    securityLines.push(
      `**No-Response Channel ${channelId}:** ${channel ? `ok <#${channel.id}>` : "missing"}`
    );
  }

  for (const target of CHANNEL_LOCK_TARGETS) {
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
      `**Daily Tracking DB:** users ${emojiDb.tableCounts.dailyUsers} | channels ${emojiDb.tableCounts.dailyChannels} | staff ${emojiDb.tableCounts.dailyStaff}`
    );
    securityLines.push(
      ...buildModerationGuardLines()
    );
  } catch (err) {
    securityLines.push(`**Emoji DB:** failed (${err.message})`);
    hasIssue = true;
  }

  securityLines.push(`**Status Channel:** [Open](${BRAND.STATUS_JUMP_URL})`);

  return {
    text: `## Security\n${securityLines.join("\n")}`,
    hasIssue
  };
}

async function runJarvisDiagnostics(message, {
  refreshKb,
  channelLockRoleId,
  onProgress,
  stepDelayMs = JARVIS_STEP_DELAY_MS
} = {}) {
  const progress = async (stepIndex, note) => {
    if (typeof onProgress === "function") {
      await onProgress({
        stepIndex,
        stepName: JARVIS_STEPS[stepIndex],
        body: buildJarvisProgressBody(stepIndex, note)
      });
    }
  };

  await progress(0, "warming up fake arc reactor and checking command uplink");
  await sleep(stepDelayMs);

  await progress(1, "reading runtime status and recent logs");
  const runtimeSection = buildRuntimeSection(message);
  await sleep(stepDelayMs);

  await progress(2, "refreshing KB and validating docs cache");
  const kbSection = await buildKbSection(refreshKb);
  await sleep(stepDelayMs);

  await progress(3, "cross-checking false-info, suspicious, selling, and link guard policy");
  await sleep(stepDelayMs);

  await progress(4, "checking log channels, emoji db, daily tracking, no-response channels, and lockdown targets");
  const securitySection = await buildSecuritySection(message, channelLockRoleId);
  await sleep(Math.min(stepDelayMs, 1_200));

  await progress(5, "compiling final report");
  const hasIssue = runtimeSection.hasIssue || kbSection.hasIssue || securitySection.hasIssue;

  return {
    body: [runtimeSection.text, kbSection.text, securitySection.text, "Ready to cook boi <3"].join("\n\n"),
    color: hasIssue ? WARN : SUCCESS
  };
}

module.exports = {
  buildJarvisProgressBody,
  buildModerationGuardLines,
  runJarvisDiagnostics
};
