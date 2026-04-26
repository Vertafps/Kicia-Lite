const { PermissionFlagsBits } = require("discord.js");
const {
  BRAND,
  STAFF_ALERT_CHANNEL_ID,
  NO_RESPONSE_CHANNEL_IDS,
  CHANNEL_LOCK_TARGETS
} = require("./config");
const { getRuntimeHealthSnapshot } = require("./runtime-health");
const { getRuntimeStatus } = require("./runtime-status");

const STAFF_CHANNEL_PERMISSIONS = [
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

async function buildJarvisReport(message, { refreshKb, channelLockRoleId }) {
  const sections = [];
  const health = getRuntimeHealthSnapshot();

  const runtimeLines = [
    `**Status:** ${getRuntimeStatus()}`,
    `**Gateway Ping:** ${Number.isFinite(message.client?.ws?.ping) ? `${message.client.ws.ping}ms` : "unknown"}`,
    `**Warnings:** ${health.warnings.length}`,
    `**Recent Warnings:** ${formatRecentEvents(health.warnings)}`,
    `**Errors:** ${health.errors.length}`,
    `**Recent Errors:** ${formatRecentEvents(health.errors)}`
  ];
  sections.push(`## Runtime\n${runtimeLines.join("\n")}`);

  try {
    const kb = await refreshKb();
    const issueCount = Array.isArray(kb?.issues) ? kb.issues.length : 0;
    const executorAliases = Object.keys(kb?.executorAliasIndex || {}).length;
    sections.push(`## KB\n**Refresh:** ok\n**Issues:** ${issueCount}\n**Executor Aliases:** ${executorAliases}`);
  } catch (err) {
    sections.push(`## KB\n**Refresh:** failed\n**Error:** ${err.message}`);
  }

  if (message.inGuild?.()) {
    const guild = message.guild;
    const botMember = guild.members?.me;
    const securityLines = [];

    const staffChannel = await resolveGuildChannel(guild, STAFF_ALERT_CHANNEL_ID);
    if (!staffChannel) {
      securityLines.push(`**Staff Alerts:** missing channel ${STAFF_ALERT_CHANNEL_ID}`);
    } else {
      const missing = getMissingPermissionLabels(staffChannel, botMember, STAFF_CHANNEL_PERMISSIONS);
      securityLines.push(
        `**Staff Alerts:** ${missing.length ? `missing ${missing.join(" / ")}` : `ok <#${staffChannel.id}>`}`
      );
    }

    for (const channelId of NO_RESPONSE_CHANNEL_IDS) {
      const channel = await resolveGuildChannel(guild, channelId);
      securityLines.push(
        `**No-Response Channel ${channelId}:** ${channel ? `ok <#${channel.id}>` : "missing"}`
      );
    }

    for (const target of CHANNEL_LOCK_TARGETS) {
      const channel = await resolveGuildChannel(guild, target.id);
      if (!channel) {
        securityLines.push(`**Lock Target ${target.label}:** missing (${target.id})`);
        continue;
      }

      const missing = getMissingPermissionLabels(channel, botMember, LOCK_CHANNEL_PERMISSIONS);
      const state = describeLockState(channel, channelLockRoleId);
      securityLines.push(
        `**Lock Target ${target.label}:** ${missing.length ? `missing ${missing.join(" / ")}` : "ok"} | ${state}`
      );
    }

    securityLines.push(`**Status Channel:** [Open](${BRAND.STATUS_JUMP_URL})`);
    sections.push(`## Security\n${securityLines.join("\n")}`);
  }

  sections.push("Ready to cook boi <3");
  return sections.join("\n\n");
}

module.exports = {
  buildJarvisReport
};
