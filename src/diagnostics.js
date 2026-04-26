const { PermissionFlagsBits } = require("discord.js");
const {
  BRAND,
  DAILY_STATS_CHANNEL_ID,
  LOG_CHANNEL_ID,
  NO_RESPONSE_CHANNEL_IDS,
  CHANNEL_LOCK_TARGETS
} = require("./config");
const { formatDuration } = require("./duration");
const { SUCCESS, WARN } = require("./embed");
const { getRestrictedEmojiDatabaseSnapshot } = require("./restricted-emoji-db");
const { getRuntimeHealthSnapshot } = require("./runtime-health");
const { getRuntimeStatus } = require("./runtime-status");

const JARVIS_STEPS = [
  "Runtime and log scan",
  "KB refresh",
  "Security audit",
  "Final compile"
];
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
  const lines = [
    "Jarvis is running checks...",
    "",
    ...JARVIS_STEPS.map((step, index) => {
      if (index < stepIndex) return `✅ ${step}`;
      if (index === stepIndex) return `🟡 ${step}`;
      return `⚪ ${step}`;
    })
  ];

  if (note) {
    lines.push("", `**Current:** ${note}`);
  }

  return lines.join("\n");
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
      text: `## Security\n**Scope:** dm mode, guild security checks skipped`,
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

async function runJarvisDiagnostics(message, { refreshKb, channelLockRoleId, onProgress } = {}) {
  const progress = async (stepIndex, note) => {
    if (typeof onProgress === "function") {
      await onProgress({
        stepIndex,
        stepName: JARVIS_STEPS[stepIndex],
        body: buildJarvisProgressBody(stepIndex, note)
      });
    }
  };

  await progress(0, "reading runtime status and recent logs");
  const runtimeSection = buildRuntimeSection(message);

  await progress(1, "refreshing KB and validating docs cache");
  const kbSection = await buildKbSection(refreshKb);

  await progress(2, "checking log channels, emoji db, daily tracking, no-response channels, and lockdown targets");
  const securitySection = await buildSecuritySection(message, channelLockRoleId);

  await progress(3, "compiling final report");
  const hasIssue = runtimeSection.hasIssue || kbSection.hasIssue || securitySection.hasIssue;

  return {
    body: [runtimeSection.text, kbSection.text, securitySection.text, "Ready to cook boi <3"].join("\n\n"),
    color: hasIssue ? WARN : SUCCESS
  };
}

module.exports = {
  buildJarvisProgressBody,
  runJarvisDiagnostics
};
