const { PermissionFlagsBits } = require("discord.js");
const { CHANNEL_LOCK_ROLE_ID } = require("../config");
const { getChannelLockTargets } = require("../channel-config");
const {
  buildPanel,
  DANGER,
  SUCCESS,
  WARN,
  INFO,
  brandAuthor,
  ansi,
  terminalBlock,
  kpi
} = require("../embed");
const viz = require("../embed-viz");
const ui = require("../ui");
const { sendLogPanel } = require("../log-channel");
const { canUseLockCommands } = require("../permissions");
const { recordRuntimeEvent } = require("../runtime-health");
const { safeEdit, safeReact, safeReply } = require("../utils/respond");

const LOCK_REACTION = "❌";
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

const lockMutex = new Map();

async function withGuildLockMutex(guildId, fn) {
  const key = String(guildId || "global");
  const previous = lockMutex.get(key) || Promise.resolve();
  let release;
  const next = previous.then(() => new Promise((resolve) => {
    release = resolve;
  }));
  lockMutex.set(key, next);

  try {
    await previous.catch(() => null);
    return await fn();
  } finally {
    if (lockMutex.get(key) === next) lockMutex.delete(key);
    release?.();
  }
}

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

  for (const target of getChannelLockTargets()) {
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

function describeLockState(state) {
  if (state === false) return "🔒 locked";
  if (state === true) return "🔓 unlocked";
  return "➖ neutral";
}

function buildLockdownAnsiGrid(channels, stateOverrides = null) {
  if (!channels.length) return terminalBlock([ansi("no configured lock targets resolved", "dim")]);
  const lines = channels.map((entry) => {
    const overrideState = stateOverrides?.get?.(entry.channel.id);
    const state = overrideState !== undefined
      ? overrideState
      : getOverwriteSendMessagesState(entry.channel);
    const tag = state === false ? "LOCKED  " : state === true ? "UNLOCKED" : "NEUTRAL ";
    const tone = state === false ? "red" : state === true ? "green" : "dim";
    const label = entry.target.label.padEnd(22).slice(0, 22);
    return `${ansi("[", tone)}${ansi(tag, tone, { bold: true })}${ansi("]", tone)} ${ansi(label, "white")} ${ansi(`#${entry.channel.name || entry.channel.id}`, "dim")}`;
  });
  return terminalBlock(lines);
}

function getAggregateLockState(channels) {
  const states = channels.map((entry) => getOverwriteSendMessagesState(entry.channel || entry));
  return {
    states,
    allLocked: states.length > 0 && states.every((state) => state === false),
    allUnlocked: states.length > 0 && states.every((state) => state === true),
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

function panelToPayload(panel) {
  if (panel && panel.__payload) {
    return { ...panel.__payload, allowedMentions: panel.__payload.allowedMentions || { repliedUser: false } };
  }
  const payload = {
    embeds: [buildPanel(panel)],
    allowedMentions: { repliedUser: false }
  };
  if (Array.isArray(panel?.files) && panel.files.length) payload.files = panel.files;
  return payload;
}

async function replyWithPanel(message, panel) {
  return safeReply(message, panelToPayload(panel));
}

async function editPanelReply(sentMessage, panel) {
  return safeEdit(sentMessage, panelToPayload(panel));
}

async function deliverFinalLockPanel(message, existingReply, panel, eventName) {
  if (existingReply && await editPanelReply(existingReply, panel)) return true;
  try {
    await replyWithPanel(message, panel);
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", eventName, err?.message || err);
    return false;
  }
}

function getNextSendMessagesState(command) {
  if (command === "lock") return false;
  if (command === "unlock") return true;
  return undefined;
}

function needsLockEdit(currentState, desiredState) {
  return currentState !== desiredState;
}

function formatChannelStateLines(channels, stateOverrides = null) {
  if (!channels.length) return "no configured lock targets resolved";
  return channels
    .map((entry) => {
      const overrideState = stateOverrides?.get?.(entry.channel.id);
      const state = overrideState !== undefined
        ? overrideState
        : getOverwriteSendMessagesState(entry.channel);
      return `- **${entry.target.label}:** <#${entry.channel.id}> — ${describeLockState(state)}`;
    })
    .join("\n");
}

function formatResolveFailures(failures) {
  return failures
    .map((failure) => `- **${failure.target?.label || failure.target?.id || "unknown"}:** ${failure.reason}`)
    .join("\n");
}

function channelsForViz(channels, stateOverrides = null) {
  return channels.map((entry) => {
    const overrideState = stateOverrides?.get?.(entry.channel.id);
    const state = overrideState !== undefined ? overrideState : getOverwriteSendMessagesState(entry.channel);
    return {
      name: entry.target.label || entry.channel.name || "channel",
      status: state === false ? "locked" : state === true ? "unlocked" : "untouched"
    };
  });
}

function buildLockStatusPanel({ channels, failures }) {
  const vizChannels = channelsForViz(channels);
  const lockedNow = vizChannels.filter((c) => c.status === "locked").length;
  const stats = {
    changed: 0,
    already: lockedNow,
    untouched: vizChannels.length - lockedNow
  };
  const built = ui.buildLockdownEmbed({
    channels: vizChannels,
    intent: "status",
    title: "Channel Lock Status",
    reason: failures.length ? "status check · with issues" : "status check",
    actor: "system",
    stats,
    summaryLine: `Lock targets: ${vizChannels.length} · ${lockedNow} currently locked`
  });
  const embed = built.embeds[0];
  const stateLines = formatChannelStateLines(channels);
  embed.setDescription(`${embed.data.description || ""}\n\n${stateLines}`.trim());
  return {
    __payload: {
      embeds: [embed],
      files: built.files
    }
  };
}

function buildLockAuditPanel({ command, actor, channels, failures = [], error = null, finalStates = null }) {
  return {
    header: command === "lock" ? "Channel Lock Applied" : command === "unlock" ? "Channel Unlock Applied" : "Channel Lock Check",
    body: [
      `**Actor:** ${actor}`,
      `**Command:** ${command}`,
      `**Targets:**\n${formatChannelStateLines(channels, finalStates)}`,
      failures.length ? `**Resolve Issues:**\n${formatResolveFailures(failures)}` : null,
      error ? `**Error:** ${error}` : null
    ].filter(Boolean).join("\n\n"),
    color: error ? DANGER : command === "lock" ? WARN : command === "status" ? INFO : SUCCESS
  };
}

function buildLockResultPanel({ command, success, pastTenseLabel, resolved, result, actor, finalStates }) {
  const vizChannels = channelsForViz(resolved.channels, finalStates);
  const intent = command === "unlock" ? "unlock" : "lock";
  const title = success
    ? command === "lock" ? "Channels Locked — Manual" : "Channels Unlocked — Manual"
    : "Channel Lock Needs Review";
  const stats = {
    changed: result.changed.length,
    already: result.skipped.length,
    untouched: 0
  };
  const channelMentions = buildTargetChannelMentions(resolved.channels);
  const verb = command === "lock" ? "Locked" : "Unlocked";
  const summaryLine = `${verb} ${result.changed.length}/${vizChannels.length} · ${result.skipped.length} already · by ${actor}`;
  const built = ui.buildLockdownEmbed({
    channels: vizChannels,
    intent,
    title,
    reason: command === "lock"
      ? (success ? "manual lockdown" : "manual lockdown · partial")
      : (success ? "manual unlock" : "manual unlock · partial"),
    actor,
    stats,
    summaryLine
  });
  const embed = built.embeds[0];
  const statsLine = `**Changed:** ${result.changed.length} · **Skipped:** ${result.skipped.length} · **By:** ${actor}`;
  embed.setDescription(`${embed.data.description || ""}\n\n**${verb} channels:** ${channelMentions}\n${statsLine}`.trim());
  return {
    __payload: {
      embeds: [embed],
      files: built.files
    }
  };
}

async function sendLockAuditLog(message, panel) {
  try {
    await sendLogPanel(message.guild, panel);
  } catch (err) {
    recordRuntimeEvent("warn", "lock-audit-log", err?.message || err);
  }
}

async function sendAutomaticLockAuditLog(guild, panel, sendLog = sendLogPanel) {
  try {
    await sendLog(guild, panel);
  } catch (err) {
    recordRuntimeEvent("warn", "auto-lock-audit-log", err?.message || err);
  }
}

async function applyLockState(channels, desiredState, actorId, actionLabel, previousStates) {
  const changed = [];
  const skipped = [];
  const finalStates = new Map();

  for (const entry of channels) {
    const currentState = previousStates.has(entry.channel.id)
      ? previousStates.get(entry.channel.id)
      : getOverwriteSendMessagesState(entry.channel);

    if (!needsLockEdit(currentState, desiredState)) {
      skipped.push(entry);
      finalStates.set(entry.channel.id, currentState);
      continue;
    }

    await entry.channel.permissionOverwrites.edit(
      CHANNEL_LOCK_ROLE_ID,
      { SendMessages: desiredState },
      { reason: `${actionLabel} by ${actorId || "unknown"}` }
    );
    changed.push(entry);
    finalStates.set(entry.channel.id, desiredState);
  }

  return {
    previousStates,
    changed,
    skipped,
    finalStates
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

function snapshotPreviousStates(channels) {
  return new Map(
    channels.map((entry) => [entry.channel.id, getOverwriteSendMessagesState(entry.channel)])
  );
}

async function applyAutomaticChannelTransition(guild, desiredState, {
  actorId,
  actor,
  reason,
  sendLog = sendLogPanel,
  command = desiredState === true ? "unlock" : "lock"
} = {}) {
  if (!guild) {
    return {
      ok: false,
      command,
      actor,
      channels: [],
      failures: [],
      error: "missing guild"
    };
  }

  return withGuildLockMutex(guild.id, async () => {
    const resolved = await resolveTargetChannels(guild);
    const expectedTargets = getChannelLockTargets().length;
    if (resolved.failures.length || resolved.channels.length !== expectedTargets) {
      const error = "target resolution failed";
      await sendAutomaticLockAuditLog(guild, buildLockAuditPanel({
        command,
        actor,
        ...resolved,
        error
      }), sendLog);

      return {
        ok: false,
        command,
        actor,
        ...resolved,
        error
      };
    }

    const preflightIssues = getPreflightIssues(guild, resolved.channels);
    if (preflightIssues.length) {
      const error = preflightIssues.join(" | ");
      await sendAutomaticLockAuditLog(guild, buildLockAuditPanel({
        command,
        actor,
        ...resolved,
        error
      }), sendLog);

      return {
        ok: false,
        command,
        actor,
        ...resolved,
        error,
        preflightIssues
      };
    }

    const previousStates = snapshotPreviousStates(resolved.channels);
    let result;
    try {
      result = await applyLockState(
        resolved.channels,
        desiredState,
        actorId,
        `auto ${command}: ${reason}`,
        previousStates
      );
    } catch (err) {
      await rollbackLockState(resolved.channels, previousStates, `auto ${command}`);
      const error = err?.message || "unknown permission overwrite failure";
      await sendAutomaticLockAuditLog(guild, buildLockAuditPanel({
        command,
        actor,
        ...resolved,
        error
      }), sendLog);

      return {
        ok: false,
        command,
        actor,
        ...resolved,
        error,
        result: {
          previousStates,
          changed: [],
          skipped: [],
          finalStates: new Map()
        }
      };
    }

    const ok = [...result.finalStates.values()].every((state) => state === desiredState);
    const error = ok ? null : "final state verification failed";
    await sendAutomaticLockAuditLog(guild, buildLockAuditPanel({
      command,
      actor,
      ...resolved,
      finalStates: result.finalStates,
      error
    }), sendLog);

    return {
      ok,
      command,
      actor,
      ...resolved,
      error,
      result
    };
  });
}

async function applyAutomaticLockdown(guild, options = {}) {
  return applyAutomaticChannelTransition(guild, false, {
    actorId: "auto-detection",
    actor: "Auto Detection",
    reason: "automatic outage detection",
    ...options,
    command: "lock"
  });
}

async function applyAutomaticUnlockdown(guild, options = {}) {
  return applyAutomaticChannelTransition(guild, true, {
    actorId: "auto-detection",
    actor: "Auto Detection",
    reason: "automatic outage all-clear",
    ...options,
    command: "unlock"
  });
}

async function maybeHandleLockCommand(message) {
  const command = parseLockCommand(message.content);
  if (!command) return false;
  if (!message.inGuild?.()) return false;

  if (!isLockOperator(message)) {
    await safeReact(message, LOCK_REACTION);
    return true;
  }

  return withGuildLockMutex(message.guild?.id, () => runLockCommand(message, command));
}

async function runLockCommand(message, command) {
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

  if (resolved.failures.length || resolved.channels.length !== getChannelLockTargets().length) {
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
  let lockProgressReply = null;

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

  if (command === "lock") {
    lockProgressReply = await replyWithPanel(message, {
      header: "Locking Channels",
      body: [
        `Locking channels: ${buildTargetChannelMentions(resolved.channels)}`,
        `**By:** ${actor}`,
        "",
        "Final result will update here.",
        formatChannelStateLines(resolved.channels)
      ].join("\n"),
      color: WARN
    }).catch((err) => {
      recordRuntimeEvent("warn", "lock-progress-reply", err?.message || err);
      return null;
    });
  }

  let result;
  const previousStates = snapshotPreviousStates(resolved.channels);
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

    const failurePanel = {
      header: "Channel Lock Failed",
      body: [
        "I rolled back any partial channel changes.",
        errorBody
      ].join("\n\n"),
      color: DANGER
    };
    await deliverFinalLockPanel(message, lockProgressReply, failurePanel, "lock-failure-reply");
    await sendLockAuditLog(message, buildLockAuditPanel({
      command,
      actor,
      ...resolved,
      error: errorBody
    }));
    return true;
  }

  const finalStates = result.finalStates;
  const success = [...finalStates.values()].every((state) => state === desiredState);

  const resultPanel = buildLockResultPanel({
    command,
    success,
    pastTenseLabel,
    resolved,
    result,
    actor,
    finalStates
  });
  await deliverFinalLockPanel(message, lockProgressReply, resultPanel, "lock-result-reply");

  await sendLockAuditLog(message, buildLockAuditPanel({
    command,
    actor,
    ...resolved,
    finalStates,
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
  applyAutomaticLockdown,
  applyAutomaticUnlockdown,
  maybeHandleLockCommand
};
