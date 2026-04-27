const { buildPanel, DANGER, WARN } = require("../embed");
const { formatDuration } = require("../duration");
const { sendLogPanel } = require("../log-channel");
const {
  getEmojiTimeoutMs,
  listRestrictedEmojis,
  matchesStoredEmoji,
  recordDailyModerationEvent
} = require("../restricted-emoji-db");
const {
  hasModerationBypassMember,
  isProtectedReactionTargetMember
} = require("../permissions");
const { recordRuntimeEvent } = require("../runtime-health");
const { safeSend } = require("../utils/respond");

function buildMessageUrl(message) {
  if (message?.url) return message.url;
  if (!message?.guildId || !message?.channelId || !message?.id) return null;
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

async function hydrateReaction(reaction, user) {
  const nextReaction = reaction?.partial ? await reaction.fetch().catch(() => null) : reaction;
  if (!nextReaction?.message) return null;

  if (nextReaction.message.partial) {
    await nextReaction.message.fetch().catch(() => null);
  }

  if (user?.partial) {
    await user.fetch().catch(() => null);
  }

  return nextReaction;
}

async function resolveGuildMember(guild, userId, fallbackMember = null) {
  if (fallbackMember) return fallbackMember;
  if (!guild || !userId) return null;

  return (
    guild.members?.cache?.get?.(userId) ||
    (typeof guild.members?.fetch === "function"
      ? await guild.members.fetch(userId).catch(() => null)
      : null)
  );
}

async function tryRemoveReaction(reaction, userId) {
  if (!reaction?.users?.remove || !userId) return false;
  try {
    await reaction.users.remove(userId);
    return true;
  } catch {
    return false;
  }
}

async function tryTimeoutMember(member, durationMs, reason) {
  if (!member?.timeout || member.moderatable === false) {
    return {
      applied: false,
      reason: "bot cannot moderate that member"
    };
  }

  try {
    await member.timeout(durationMs, reason);
    return {
      applied: true,
      reason: `timed out for ${formatDuration(durationMs)}`
    };
  } catch (err) {
    return {
      applied: false,
      reason: err?.message || "timeout failed"
    };
  }
}

async function tryDirectMessage(user, payload) {
  return safeSend(user, payload);
}

async function recordModerationStat(eventKey) {
  try {
    await recordDailyModerationEvent(eventKey);
  } catch (err) {
    recordRuntimeEvent("warn", "daily-moderation-track", err?.message || err);
  }
}

function buildUserTimeoutPayload({ message, emojiDisplay, durationMs }) {
  return {
    embeds: [
      buildPanel({
        header: "Reaction Timeout",
        body: [
          `you reacted with a restricted emoji (**${emojiDisplay}**) on a protected staff message`,
          `**Timeout:** ${formatDuration(durationMs)}`,
          `**Channel:** <#${message.channelId}>`,
          "if you think this was a mistake, talk to staff after the timeout ends"
        ].join("\n"),
        color: WARN
      })
    ]
  };
}

function buildRestrictedReactionLogPanel({
  message,
  targetMember,
  reactingUserId,
  emojiDisplay,
  durationMs,
  reactionRemoved,
  timeoutResult,
  dmSent
}) {
  const jumpUrl = buildMessageUrl(message);

  return {
    header: timeoutResult.applied ? "Restricted Reaction Timeout" : "Restricted Reaction Alert",
    body: [
      timeoutResult.applied
        ? "restricted emoji reaction removed and timeout applied"
        : "restricted emoji reaction matched, but timeout could not be applied cleanly",
      `**User:** <@${reactingUserId}>`,
      `**Emoji:** ${emojiDisplay}`,
      `**Target Staff Message:** <@${targetMember?.id || message.author?.id}> in <#${message.channelId}>`,
      jumpUrl ? `**Jump:** [Open message](${jumpUrl})` : null,
      `**Reaction Removed:** ${reactionRemoved ? "yes" : "failed"}`,
      `**Timeout:** ${timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason}`,
      `**DM:** ${dmSent ? "sent" : "not sent"}`
    ].filter(Boolean).join("\n\n"),
    color: timeoutResult.applied ? DANGER : WARN
  };
}

async function maybeHandleRestrictedReactionAdd(reaction, user, deps = {}) {
  const {
    listEmojis = listRestrictedEmojis,
    getTimeout = getEmojiTimeoutMs,
    sendLog = sendLogPanel
  } = deps;

  if (!reaction || !user || user.bot) return false;

  const hydratedReaction = await hydrateReaction(reaction, user);
  const message = hydratedReaction?.message;
  const guild = message?.guild;
  if (!hydratedReaction || !guild || !message?.author?.id || message.author.bot) return false;

  const restrictedEmojis = await listEmojis();
  if (!restrictedEmojis.length) return false;

  const matchedEmoji = restrictedEmojis.find((emoji) => matchesStoredEmoji(emoji, hydratedReaction.emoji));
  if (!matchedEmoji) return false;

  const targetMember = await resolveGuildMember(guild, message.author.id, message.member || null);
  if (!isProtectedReactionTargetMember(targetMember)) return false;

  const reactingMember = await resolveGuildMember(guild, user.id, hydratedReaction.members?.get?.(user.id) || null);
  if (!reactingMember || hasModerationBypassMember(reactingMember, user.id)) return false;

  const durationMs = await getTimeout();
  const actionReason = `restricted emoji reaction: ${matchedEmoji.display}`;
  const reactionRemoved = await tryRemoveReaction(hydratedReaction, user.id);
  const timeoutResult = await tryTimeoutMember(reactingMember, durationMs, actionReason);
  const dmSent = timeoutResult.applied
    ? await tryDirectMessage(user, buildUserTimeoutPayload({
        message,
        emojiDisplay: matchedEmoji.display,
        durationMs
      }))
    : false;

  if (!timeoutResult.applied) {
    recordRuntimeEvent("warn", "restricted-reaction-timeout", timeoutResult.reason);
  }
  await recordModerationStat(timeoutResult.applied ? "restricted_reaction_timeout" : "restricted_reaction_alert");

  await sendLog(guild, buildRestrictedReactionLogPanel({
    message,
    targetMember,
    reactingUserId: user.id,
    emojiDisplay: matchedEmoji.display,
    durationMs,
    reactionRemoved,
    timeoutResult,
    dmSent
  })).catch(() => null);

  return timeoutResult.applied || reactionRemoved;
}

module.exports = {
  maybeHandleRestrictedReactionAdd
};
