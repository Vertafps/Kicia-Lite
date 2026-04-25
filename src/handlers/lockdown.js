const { PermissionFlagsBits } = require("discord.js");
const {
  CHANNEL_LOCK_ROLE_ID,
  CHANNEL_LOCK_TARGETS,
  CHANNEL_LOCK_OPERATOR_ROLE_IDS,
  CHANNEL_LOCK_OPERATOR_USER_IDS
} = require("../config");
const { buildPanel, DANGER, SUCCESS, WARN, INFO } = require("../embed");

const LOCK_REACTION = "\u274C";
const CHANNEL_PERMISSION_BITS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels
];
const PERMISSION_LABELS = new Map([
  [PermissionFlagsBits.ViewChannel, "View Channel"],
  [PermissionFlagsBits.ManageChannels, "Manage Channels"],
  [PermissionFlagsBits.ManageRoles, "Manage Roles"]
]);

function parseLockCommand(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (normalized === "$lock") return "toggle";
  if (normalized === "$lockdown" || normalized === "$lock on") return "lock";
  if (normalized === "$unlock" || normalized === "$lock off") return "unlock";
  return null;
}

function isLockCommandMessage(content) {
  return parseLockCommand(content) !== null;
}

function isLockOperator(message) {
  if (CHANNEL_LOCK_OPERATOR_USER_IDS.includes(message.author?.id)) return true;
  return CHANNEL_LOCK_OPERATOR_ROLE_IDS.some((roleId) => message.member?.roles?.cache?.has?.(roleId));
}

async function resolveTargetChannels(guild) {
  const channels = [];

  for (const target of CHANNEL_LOCK_TARGETS) {
    const channel =
      guild.channels?.cache?.get(target.id) ||
      (typeof guild.channels?.fetch === "function" ? await guild.channels.fetch(target.id) : null);

    if (!channel?.permissionOverwrites?.edit || typeof channel.permissionsFor !== "function") {
      throw new Error(`Missing or invalid target channel: ${target.id}`);
    }

    channels.push(channel);
  }

  return channels;
}

function getOverwriteSendMessagesState(channel) {
  const overwrite = channel.permissionOverwrites.cache.get(CHANNEL_LOCK_ROLE_ID);
  if (overwrite?.deny?.has(PermissionFlagsBits.SendMessages)) return false;
  if (overwrite?.allow?.has(PermissionFlagsBits.SendMessages)) return true;
  return null;
}

function getAggregateLockState(channels) {
  const states = channels.map((channel) => getOverwriteSendMessagesState(channel));
  const allLocked = states.every((state) => state === false);
  const allUnlocked = states.every((state) => state === true);

  return {
    states,
    allLocked,
    allUnlocked
  };
}

function getDesiredLockState(command, aggregateState) {
  if (command === "lock") return false;
  if (command === "unlock") return true;
  return aggregateState.allLocked;
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
  return channels.map((channel) => `<#${channel.id}>`).join(", ");
}

function buildActorLabel(message) {
  return message.member?.displayName || message.author?.tag || message.author?.username || message.author?.id || "unknown";
}

async function replyWithPanel(message, panel) {
  await message.reply({
    embeds: [buildPanel(panel)],
    allowedMentions: { repliedUser: false }
  });
}

async function maybeHandleLockCommand(message) {
  const command = parseLockCommand(message.content);
  if (!command) return false;
  if (!message.inGuild?.()) return false;

  if (!isLockOperator(message)) {
    await message.react(LOCK_REACTION).catch(() => null);
    return true;
  }

  let channels;
  try {
    channels = await resolveTargetChannels(message.guild);
  } catch {
    await replyWithPanel(message, {
      body: "I couldn't find the channels needed for that rn",
      color: DANGER
    });
    return true;
  }

  const aggregateState = getAggregateLockState(channels);
  const desiredLockedState = getDesiredLockState(command, aggregateState);
  const actionLabel = desiredLockedState ? "unlocked" : "locked";

  if (!desiredLockedState && aggregateState.allLocked && command !== "toggle") {
    await replyWithPanel(message, {
      body: `those channels are already locked: ${buildTargetChannelMentions(channels)}`,
      color: INFO
    });
    return true;
  }

  if (desiredLockedState && aggregateState.allUnlocked && command !== "toggle") {
    await replyWithPanel(message, {
      body: `those channels are already unlocked: ${buildTargetChannelMentions(channels)}`,
      color: INFO
    });
    return true;
  }

  const botMember = message.guild.members?.me;
  const missingPermissions = [...new Set(channels.flatMap((channel) => getMissingChannelPermissionLabels(channel, botMember)))];
  if (missingPermissions.length) {
    await replyWithPanel(message, {
      body: `I dont have ${missingPermissions.join(" / ")} yet so i cannto do that bro </3`,
      color: DANGER
    });
    return true;
  }

  const previousStates = new Map(channels.map((channel) => [channel.id, getOverwriteSendMessagesState(channel)]));

  try {
    for (const channel of channels) {
      await channel.permissionOverwrites.edit(CHANNEL_LOCK_ROLE_ID, { SendMessages: desiredLockedState }, {
        reason: `${actionLabel} by ${message.author?.id || "unknown"}`
      });
    }
  } catch (err) {
    for (const channel of channels) {
      const previousState = previousStates.get(channel.id);
      if (getOverwriteSendMessagesState(channel) === previousState) continue;

      await channel.permissionOverwrites.edit(CHANNEL_LOCK_ROLE_ID, { SendMessages: previousState }, {
        reason: `rollback after failed ${actionLabel}`
      }).catch(() => null);
    }

    const missingAfterFailure = [...new Set(channels.flatMap((channel) => getMissingChannelPermissionLabels(channel, botMember)))];
    if (missingAfterFailure.length || err.code === 50013) {
      await replyWithPanel(message, {
        body: `I dont have ${(missingAfterFailure.length ? missingAfterFailure : ["the required perms"]).join(" / ")} yet so i cannto do that bro </3`,
        color: DANGER
      });
      return true;
    }

    throw err;
  }

  await replyWithPanel(message, {
    body: `${actionLabel} channels: ${buildTargetChannelMentions(channels)} successfully\nby: ${buildActorLabel(message)}`,
    color: desiredLockedState ? SUCCESS : WARN
  });
  return true;
}

module.exports = {
  parseLockCommand,
  isLockCommandMessage,
  isLockOperator,
  getOverwriteSendMessagesState,
  getAggregateLockState,
  getDesiredLockState,
  maybeHandleLockCommand
};
