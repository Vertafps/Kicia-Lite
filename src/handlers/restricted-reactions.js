const { buildPanel, WARN } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const {
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

function buildUserWarningPayload({ message, emojiDisplay }) {
  return {
    embeds: [
      buildPanel({
        header: "Reaction Removed",
        body: [
          `you reacted with a restricted emoji (**${emojiDisplay}**) on a protected staff message`,
          "I removed the reaction. Please don't use restricted reactions on staff messages again.",
          `**Channel:** <#${message.channelId}>`,
          "if you think this was a mistake, talk to staff"
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
  reactionRemoved,
  dmSent
}) {
  const jumpUrl = buildMessageUrl(message);

  return {
    header: "Restricted Reaction Warning",
    body: [
      "restricted emoji reaction removed and user warned in DM",
      `**User:** <@${reactingUserId}>`,
      `**Emoji:** ${emojiDisplay}`,
      `**Target Staff Message:** <@${targetMember?.id || message.author?.id}> in <#${message.channelId}>`,
      jumpUrl ? `**Jump:** [Open message](${jumpUrl})` : null,
      `**Reaction Removed:** ${reactionRemoved ? "yes" : "failed"}`,
      `**DM:** ${dmSent ? "sent" : "not sent"}`
    ].filter(Boolean).join("\n\n"),
    color: WARN
  };
}

async function maybeHandleRestrictedReactionAdd(reaction, user, deps = {}) {
  const {
    listEmojis = listRestrictedEmojis,
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

  const reactionRemoved = await tryRemoveReaction(hydratedReaction, user.id);
  const dmSent = await tryDirectMessage(user, buildUserWarningPayload({
    message,
    emojiDisplay: matchedEmoji.display
  }));

  if (!reactionRemoved) {
    recordRuntimeEvent("warn", "restricted-reaction-remove", "reaction removal failed");
  }
  await recordModerationStat("restricted_reaction_alert");

  await sendLog(guild, buildRestrictedReactionLogPanel({
    message,
    targetMember,
    reactingUserId: user.id,
    emojiDisplay: matchedEmoji.display,
    reactionRemoved,
    dmSent
  })).catch(() => null);

  return reactionRemoved || dmSent;
}

module.exports = {
  maybeHandleRestrictedReactionAdd
};
