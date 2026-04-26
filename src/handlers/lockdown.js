const { PermissionFlagsBits } = require("discord.js");
const {
  CHANNEL_LOCK_ROLE_ID,
  CHANNEL_LOCK_TARGETS
} = require("../config");
const { buildPanel, DANGER, SUCCESS, WARN, INFO } = require("../embed");
const { canUseLockCommands } = require("../permissions");
const { safeReact, safeReply } = require("../utils/respond");

const LOCK_REACTION = "\u274C";
const CHANNEL_PERMISSION_BITS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ManageChannels
];
const PERMISSION_LABELS = new Map([
  [PermissionFlagsBits.ViewChannel, "View Channel"],
  [PermissionFlagsBits.ManageChannels, "Manage Channels"]
]);

function parseLockCommand(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (normalized === "$lock" || normalized === "$lockdown" || normalized === "$lock on") return "lock";
  if (normalized === "$unlock" || normalized === "$lock off") return "unlock";
  return null;
}

function isLockCommandMessage(content) {
  return parseLockCommand(content) !== null;
}

function isLockOperator(message) {
  return canUseLockCommands(message);
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
  return {
    states,
    allLocked: states.every((state) => state === false),
    allUnlocked: states.every((state) => state === true)
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
  return channels.map((channel) => `<#${channel.id}>`).join(", ");
}

function buildActorLabel(message) {
  return message.member?.displayName || message.author?.tag || message.author?.username || message.author?.id || "unknown";
}

async function replyWithPanel(message, panel) {
  await safeReply(message, {
    embeds: [buildPanel(panel)],
    allowedMentions: { repliedUser: false }
  });
}

function getNextSendMessagesState(command) {
  return command === "unlock";
}

async function maybeHandleLockCommand(message) {
  const command = parseLockCommand(message.content);
  if (!command) return false;
  if (!message.inGuild?.()) return false;

  if (!isLockOperator(message)) {
    await safeReact(message, LOCK_REACTION);
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
  const nextSendMessagesState = getNextSendMessagesState(command);
  const actionLabel = nextSendMessagesState ? "unlock" : "lock";
  const pastTenseLabel = nextSendMessagesState ? "unlocked" : "locked";

  if (!nextSendMessagesState && aggregateState.allLocked) {
    await replyWithPanel(message, {
      body: `those channels are already locked: ${buildTargetChannelMentions(channels)}`,
      color: INFO
    });
    return true;
  }

  if (nextSendMessagesState && aggregateState.allUnlocked) {
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
      body: `I dont have ${missingPermissions.join(" / ")} yet so i cannot do that bro </3`,
      color: DANGER
    });
    return true;
  }

  const previousStates = new Map(channels.map((channel) => [channel.id, getOverwriteSendMessagesState(channel)]));

  try {
    for (const channel of channels) {
      await channel.permissionOverwrites.edit(
        CHANNEL_LOCK_ROLE_ID,
        { SendMessages: nextSendMessagesState },
        { reason: `${actionLabel} by ${message.author?.id || "unknown"}` }
      );
    }
  } catch (err) {
    for (const channel of channels) {
      const previousState = previousStates.get(channel.id);
      if (getOverwriteSendMessagesState(channel) === previousState) continue;

      await channel.permissionOverwrites.edit(
        CHANNEL_LOCK_ROLE_ID,
        { SendMessages: previousState },
        { reason: `rollback after failed ${actionLabel}` }
      ).catch(() => null);
    }

    const missingAfterFailure = [...new Set(channels.flatMap((channel) => getMissingChannelPermissionLabels(channel, botMember)))];
    if (missingAfterFailure.length || err.code === 50013) {
      await replyWithPanel(message, {
        body: `I dont have ${(missingAfterFailure.length ? missingAfterFailure : ["the required perms"]).join(" / ")} yet so i cannot do that bro </3`,
        color: DANGER
      });
      return true;
    }

    throw err;
  }

  await replyWithPanel(message, {
    body: `${pastTenseLabel} channels: ${buildTargetChannelMentions(channels)} successfully\nby: ${buildActorLabel(message)}`,
    color: nextSendMessagesState ? SUCCESS : WARN
  });
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
