const { PermissionFlagsBits } = require("discord.js");
const {
  CHANNEL_LOCK_ROLE_ID,
  CHANNEL_LOCK_TARGETS
} = require("../config");
const { buildPanel, DANGER, SUCCESS, WARN, INFO } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const { canUseLockCommands } = require("../permissions");
const { recordRuntimeEvent } = require("../runtime-health");
const { safeReact, safeReply } = require("../utils/respond");

const LOCK_REACTION = "\u274C";
const CHANNEL_PERMISSION_BITS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles
];
const PERMISSION_LABELS = new Map([
  [PermissionFlagsBits.ViewChannel, "View Channel"],
  [PermissionFlagsBits.ManageChannels, "Manage Channels"],
  [PermissionFlagsBits.ManageRoles, "Manage Roles"]
]);

function parseLockCommand(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (normalized === "$lock" || normalized === "$lockdown" || normalized === "$lock on") return "lock";
  if (normalized === "$unlock" || normalized === "$lock off") return "unlock";
  if (normalized === "$lock status" || normalized === "$lock check" || normalized === "$lock state") return "status";
  return null;
}

function isLockCommandMessage(content) {
  return parseLockCommand(content) !== null;
}

function isLockOperator(message) {
  return canUseLockCommands(message);
}

async function fetchGuildChannel(guild, channelId) {
  const cached = guild?.channels?.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild?.channels?.fetch === "function") {
    return guild.channels.fetch(channelId).catch(() => null);
  }
  return null;
}

async function resolveTargetChannels(guild) {
  const channels = [];
  const failures = [];
  const seen = new Set();

  for (const target of CHANNEL_LOCK_TARGETS) {
    if (!target?.id || seen.has(target.id)) {
      failures.push({
        target,
        reason: target?.id ? "duplicate target id" : "missing target id"
      });
      continue;
    }
    seen.add(target.id);

    const channel = await fetchGuildChannel(guild, target.id);
    if (!channel) {
      failures.push({
        target,
        reason: "channel not found"
      });
      continue;
    }
    if (!channel.permissionOverwrites?.edit || typeof channel.permissionsFor !== "function") {
      failures.push({
        target,
        reason: "channel permissions unavailable"
      });
      continue;
    }

    channels.push({
      target,
      channel
    });
  }

  return {
    channels,
    failures
  };
}

function getOverwriteSendMessagesState(channel) {
  const overwrite = channel.permissionOverwrites.cache.get(CHANNEL_LOCK_ROLE_ID);
  if (overwrite?.deny?.has(PermissionFlagsBits.SendMessages)) return false;
  if (overwrite?.allow?.has(PermissionFlagsBits.SendMessages)) return true;
  return null;
}

function getLockStateLabel(state) {
  if (state === false) return "locked";
  if (state === true) return "explicit allow";
  return "unlocked";
}

function getAggregateLockState(channels) {
  const states = channels.map((entry) => getOverwriteSendMessagesState(entry.channel || entry));
  return {
    states,
    allLocked: states.length > 0 && states.every((state) => state === false),
    allUnlocked: states.length > 0 && states.every((state) => state === null),
    hasExplicitAllow: states.some((state) => state === true),
    mixed: new Set(states).size > 1
  };
}

function getMissingChannelPermissionLabels(channel, botMember) {
  const permissions = channel.permissionsFor(botMember);
  if (!permissions) {
    return CHANNEL_PERMISSION_BITS.map((bit) => PERMISSION_LABELS.get(bit));
  }

  return CHANNEL_PERMISSION_BITS
    .filter((bit) => !permissions.has(bit))
    .map((bit) => PERMISSION_LABELS.get(bit));
}

function buildTargetChannelMentions(channels) {
  return channels.map((entry) => `<#${(entry.channel || entry).id}>`).join(", ");
}

function buildActorLabel(message) {
  return message.member?.displayName || message.author?.tag || message.author?.username || message.author?.id || "unknown";
}

function getTargetRoleHierarchyIssue(guild) {
  const botMember = guild?.members?.me;
  const targetRole = guild?.roles?.cache?.get?.(CHANNEL_LOCK_ROLE_ID);
  const botHighestRole = botMember?.roles?.highest;

  if (!targetRole || !botHighestRole || typeof botHighestRole.comparePositionTo !== "function") {
    return null;
  }

  return botHighestRole.comparePositionTo(targetRole) > 0
    ? null
    : `bot role must be above <@&${CHANNEL_LOCK_ROLE_ID}>`;
}

function getPreflightIssues(guild, channels) {
  const botMember = guild?.members?.me;
  const issues = [];

  for (const entry of channels) {
    const missing = getMissingChannelPermissionLabels(entry.channel, botMember);
    if (missing.length) {
      issues.push(`${entry.target.label}: missing ${missing.join(" / ")}`);
    }
  }

  const hierarchyIssue = getTargetRoleHierarchyIssue(guild);
  if (hierarchyIssue) issues.push(hierarchyIssue);

  return issues;
}

async function replyWithPanel(message, panel) {
  await safeReply(message, {
    embeds: [buildPanel(panel)],
    allowedMentions: { repliedUser: false }
  });
}

function getNextSendMessagesState(command) {
  if (command === "lock") return false;
  if (command === "unlock") return null;
  return undefined;
}

function needsLockEdit(currentState, desiredState) {
  return currentState !== desiredState;
}

function formatChannelStateLines(channels) {
  if (!channels.length) return "no configured lock targets resolved";
  return channels
    .map((entry) => {
      const state = getOverwriteSendMessagesState(entry.channel);
      return `- **${entry.target.label}:** <#${entry.channel.id}> - ${getLockStateLabel(state)}`;
    })
    .join("\n");
}

function formatResolveFailures(failures) {
  return failures
    .map((failure) => `- **${failure.target?.label || failure.target?.id || "unknown"}:** ${failure.reason}`)
    .join("\n");
}

function buildLockStatusPanel({ channels, failures }) {
  const body = [
    "## Targets",
    formatChannelStateLines(channels),
    failures.length ? `\n## Resolve Issues\n${formatResolveFailures(failures)}` : null,
    "",
    "`$lock` denies Send Messages for the configured member role.",
    "`$unlock` clears that override back to neutral."
  ].filter(Boolean).join("\n");

  return {
    header: "Channel Lock Status",
    body,
    color: failures.length ? WARN : INFO
  };
}

function buildLockAuditPanel({ command, actor, channels, failures = [], error = null }) {
  return {
    header: command === "lock" ? "Channel Lock Applied" : command === "unlock" ? "Channel Unlock Applied" : "Channel Lock Check",
    body: [
      `**Actor:** ${actor}`,
      `**Command:** ${command}`,
      `**Targets:**\n${formatChannelStateLines(channels)}`,
      failures.length ? `**Resolve Issues:**\n${formatResolveFailures(failures)}` : null,
      error ? `**Error:** ${error}` : null
    ].filter(Boolean).join("\n\n"),
    color: error ? DANGER : command === "lock" ? WARN : command === "status" ? INFO : SUCCESS
  };
}

async function sendLockAuditLog(message, panel) {
  try {
    await sendLogPanel(message.guild, panel);
  } catch (err) {
    recordRuntimeEvent("warn", "lock-audit-log", err?.message || err);
  }
}

async function applyLockState(channels, desiredState, actorId, actionLabel, previousStates) {
  const changed = [];
  const skipped = [];

  for (const entry of channels) {
    const currentState = getOverwriteSendMessagesState(entry.channel);

    if (!needsLockEdit(currentState, desiredState)) {
      skipped.push(entry);
      continue;
    }

    await entry.channel.permissionOverwrites.edit(
      CHANNEL_LOCK_ROLE_ID,
      { SendMessages: desiredState },
      { reason: `${actionLabel} by ${actorId || "unknown"}` }
    );
    changed.push(entry);
  }

  return {
    previousStates,
    changed,
    skipped
  };
}

async function rollbackLockState(channels, previousStates, actionLabel) {
  for (const entry of channels) {
    if (!previousStates.has(entry.channel.id)) continue;
    const previousState = previousStates.get(entry.channel.id);
    if (getOverwriteSendMessagesState(entry.channel) === previousState) continue;

    await entry.channel.permissionOverwrites.edit(
      CHANNEL_LOCK_ROLE_ID,
      { SendMessages: previousState },
      { reason: `rollback after failed ${actionLabel}` }
    ).catch(() => null);
  }
}

async function maybeHandleLockCommand(message) {
  const command = parseLockCommand(message.content);
  if (!command) return false;
  if (!message.inGuild?.()) return false;

  if (!isLockOperator(message)) {
    await safeReact(message, LOCK_REACTION);
    return true;
  }

  const resolved = await resolveTargetChannels(message.guild);
  const actor = buildActorLabel(message);

  if (command === "status") {
    const panel = buildLockStatusPanel(resolved);
    await replyWithPanel(message, panel);
    await sendLockAuditLog(message, buildLockAuditPanel({
      command,
      actor,
      ...resolved
    }));
    return true;
  }

  if (resolved.failures.length || resolved.channels.length !== CHANNEL_LOCK_TARGETS.length) {
    const panel = {
      header: "Channel Lock Blocked",
      body: [
        "I could not resolve every configured lock target, so I did not change anything.",
        formatResolveFailures(resolved.failures)
      ].filter(Boolean).join("\n\n"),
      color: DANGER
    };
    await replyWithPanel(message, panel);
    await sendLockAuditLog(message, buildLockAuditPanel({
      command,
      actor,
      ...resolved,
      error: "target resolution failed"
    }));
    return true;
  }

  const preflightIssues = getPreflightIssues(message.guild, resolved.channels);
  if (preflightIssues.length) {
    await replyWithPanel(message, {
      header: "Channel Lock Blocked",
      body: [
        "I am missing something needed to safely update both channels, so I did not change anything.",
        preflightIssues.map((issue) => `- ${issue}`).join("\n")
      ].join("\n\n"),
      color: DANGER
    });
    await sendLockAuditLog(message, buildLockAuditPanel({
      command,
      actor,
      ...resolved,
      error: preflightIssues.join(" | ")
    }));
    return true;
  }

  const aggregateState = getAggregateLockState(resolved.channels);
  const desiredState = getNextSendMessagesState(command);
  const actionLabel = command === "unlock" ? "unlock" : "lock";
  const pastTenseLabel = command === "unlock" ? "unlocked" : "locked";

  if (command === "lock" && aggregateState.allLocked) {
    await replyWithPanel(message, {
      header: "Channels Already Locked",
      body: [
        `Already locked: ${buildTargetChannelMentions(resolved.channels)}`,
        formatChannelStateLines(resolved.channels)
      ].join("\n\n"),
      color: INFO
    });
    return true;
  }

  if (command === "unlock" && aggregateState.allUnlocked) {
    await replyWithPanel(message, {
      header: "Channels Already Unlocked",
      body: [
        `Already unlocked: ${buildTargetChannelMentions(resolved.channels)}`,
        formatChannelStateLines(resolved.channels)
      ].join("\n\n"),
      color: INFO
    });
    return true;
  }

  let result;
  const previousStates = new Map(
    resolved.channels.map((entry) => [entry.channel.id, getOverwriteSendMessagesState(entry.channel)])
  );
  try {
    result = await applyLockState(
      resolved.channels,
      desiredState,
      message.author?.id,
      actionLabel,
      previousStates
    );
  } catch (err) {
    await rollbackLockState(resolved.channels, previousStates, actionLabel);

    const missingAfterFailure = getPreflightIssues(message.guild, resolved.channels);
    const errorBody = missingAfterFailure.length
      ? missingAfterFailure.map((issue) => `- ${issue}`).join("\n")
      : err?.message || "unknown permission overwrite failure";

    await replyWithPanel(message, {
      header: "Channel Lock Failed",
      body: [
        "I rolled back any partial channel changes.",
        errorBody
      ].join("\n\n"),
      color: DANGER
    });
    await sendLockAuditLog(message, buildLockAuditPanel({
      command,
      actor,
      ...resolved,
      error: errorBody
    }));
    return true;
  }

  const finalAggregateState = getAggregateLockState(resolved.channels);
  const success = command === "lock"
    ? finalAggregateState.allLocked
    : finalAggregateState.allUnlocked;

  await replyWithPanel(message, {
    header: success
      ? command === "lock" ? "Channels Locked" : "Channels Unlocked"
      : "Channel Lock Needs Review",
    body: [
      success
        ? `${pastTenseLabel} channels: ${buildTargetChannelMentions(resolved.channels)}`
        : "I applied the command, but the final state was not exactly what I expected.",
      `**Changed:** ${result.changed.length}`,
      `**Skipped:** ${result.skipped.length}`,
      `**By:** ${actor}`,
      "",
      formatChannelStateLines(resolved.channels)
    ].join("\n"),
    color: success ? command === "lock" ? WARN : SUCCESS : DANGER
  });

  await sendLockAuditLog(message, buildLockAuditPanel({
    command,
    actor,
    ...resolved,
    error: success ? null : "final state verification failed"
  }));
  return true;
}

module.exports = {
  parseLockCommand,
  isLockCommandMessage,
  isLockOperator,
  getOverwriteSendMessagesState,
  getAggregateLockState,
  getNextSendMessagesState,
  maybeHandleLockCommand
};
