"use strict";

/**
 * Restricted reactions handler.
 *
 * On a restricted emoji reaction to a protected staff member's message:
 *  1. Remove the reaction.
 *  2. Record telemetry (restricted_emoji_usage).
 *  3. Bump per-user spam state and apply tiered escalation:
 *       tier 1 (3 in 30s)   → 5min timeout
 *       tier 2 (5 in 60s)   → 30min timeout
 *       tier 3 (8 in 5min)  → staff manual-review flag (no auto-timeout)
 *  4. DM the user with the appropriate severity.
 *  5. Log to the configured log channel only.
 *
 * Strict log routing: nothing here ever lands in the channel where the
 * reaction happened. The user's DM is the only direct-to-user surface.
 */

const {
  EMOJI_SPAM_TIER1_WINDOW_MS,
  EMOJI_SPAM_TIER1_COUNT,
  EMOJI_SPAM_TIER1_TIMEOUT_MS,
  EMOJI_SPAM_TIER2_WINDOW_MS,
  EMOJI_SPAM_TIER2_COUNT,
  EMOJI_SPAM_TIER2_TIMEOUT_MS,
  EMOJI_SPAM_TIER3_WINDOW_MS,
  EMOJI_SPAM_TIER3_COUNT
} = require("../config");
const { buildPanel, buildRichPanel, WARN, DANGER, resolveAvatarURL } = require("../embed");
const { formatDuration } = require("../duration");
const { sendLogPanel } = require("../log-channel");
const {
  bumpEmojiSpamState,
  listRestrictedEmojis,
  matchesStoredEmoji,
  recordDailyModerationEvent,
  recordRestrictedEmojiUsage
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
    return { applied: false, reason: "bot cannot moderate that member" };
  }
  try {
    await member.timeout(durationMs, reason);
    return { applied: true, reason: `timed out ${Math.round(durationMs / 1000)}s` };
  } catch (err) {
    return { applied: false, reason: err?.message || "timeout failed" };
  }
}

async function recordModerationStat(eventKey) {
  try {
    await recordDailyModerationEvent(eventKey);
  } catch (err) {
    recordRuntimeEvent("warn", "daily-moderation-track", err?.message || err);
  }
}

function buildUserWarningPayload({ message, emojiDisplay, tier, timeoutResult, durationMs }) {
  if (tier === 0) {
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

  if (tier === 3) {
    return {
      embeds: [
        buildPanel({
          header: "Restricted Reactions — Staff Review",
          body: [
            `you've used a restricted emoji (**${emojiDisplay}**) repeatedly.`,
            "staff have been flagged to manually review the pattern.",
            "please stop using restricted reactions on staff messages.",
            `**Channel:** <#${message.channelId}>`
          ].join("\n"),
          color: DANGER
        })
      ]
    };
  }

  // Tier 1 or 2 — auto timeout
  const timeoutNote = timeoutResult?.applied
    ? `Timed out for **${formatDuration(durationMs)}**.`
    : `Auto-timeout failed (${timeoutResult?.reason || "unknown"}). Staff have been notified.`;

  return {
    embeds: [
      buildPanel({
        header: "Restricted Reaction Timeout",
        body: [
          `you reacted with a restricted emoji (**${emojiDisplay}**) on a protected staff message.`,
          "this is your **" + (tier === 1 ? "first" : "second") + "** escalation in a short window.",
          timeoutNote,
          `**Channel:** <#${message.channelId}>`,
          "stop reacting with restricted emojis on staff messages. If this was a mistake, talk to staff."
        ].join("\n"),
        color: DANGER
      })
    ]
  };
}

function buildRestrictedReactionLogPanel({
  message,
  targetMember,
  reactingUser,
  reactingUserId,
  emojiDisplay,
  emojiKey,
  reactionRemoved,
  dmSent,
  tier,
  countInWindow,
  timeoutResult,
  durationMs
}) {
  const jumpUrl = buildMessageUrl(message);
  const tierLabel =
    tier === 3 ? "Tier 3 · Staff Flag" :
    tier === 2 ? "Tier 2 · 30min Auto" :
    tier === 1 ? "Tier 1 · 5min Auto"  :
                 "Tier 0 · Warn Only";
  const tone = tier >= 2 ? DANGER : WARN;

  return buildRichPanel({
    title: tier >= 1 ? "Restricted Reaction Escalation" : "Restricted Reaction Warning",
    color: tone,
    description: tier === 3
      ? "user hit the staff-review threshold for restricted reactions"
      : tier >= 1
        ? `auto-escalation triggered (${tierLabel})`
        : "restricted emoji reaction removed and user warned in DM",
    thumbnail: resolveAvatarURL(reactingUser),
    fields: [
      { name: "User", value: `<@${reactingUserId}>`, inline: true },
      { name: "Emoji", value: emojiDisplay, inline: true },
      { name: "Window Count", value: String(countInWindow), inline: true },
      { name: "Target", value: `<@${targetMember?.id || message.author?.id}> in <#${message.channelId}>`, inline: false },
      jumpUrl ? { name: "Jump", value: `[Open message](${jumpUrl})`, inline: false } : null,
      { name: "Tier", value: tierLabel, inline: true },
      { name: "Reaction Removed", value: reactionRemoved ? "yes" : "failed", inline: true },
      { name: "DM Sent", value: dmSent ? "sent" : "not sent", inline: true },
      tier >= 1 && tier <= 2
        ? { name: "Auto Timeout", value: timeoutResult?.applied ? `${formatDuration(durationMs)}` : `failed · ${timeoutResult?.reason || "unknown"}`, inline: true }
        : null
    ].filter(Boolean)
  });
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

  // Telemetry — record every restricted-reaction hit for $emoji top and $jarvis.
  recordRestrictedEmojiUsage({
    userId: user.id,
    emojiKey: matchedEmoji.key,
    channelId: message.channelId
  }).catch((err) => recordRuntimeEvent("warn", "restricted-emoji-telemetry", err?.message || err));

  // Spam escalation — determine tier
  const escalation = await bumpEmojiSpamState({
    userId: user.id,
    tier1Window: EMOJI_SPAM_TIER1_WINDOW_MS,
    tier1Count: EMOJI_SPAM_TIER1_COUNT,
    tier2Window: EMOJI_SPAM_TIER2_WINDOW_MS,
    tier2Count: EMOJI_SPAM_TIER2_COUNT,
    tier3Window: EMOJI_SPAM_TIER3_WINDOW_MS,
    tier3Count: EMOJI_SPAM_TIER3_COUNT
  }).catch((err) => {
    recordRuntimeEvent("warn", "emoji-spam-state", err?.message || err);
    return { tier: 0, count: 1 };
  });

  let timeoutResult = null;
  let durationMs = 0;
  if (escalation.tier === 1) {
    durationMs = EMOJI_SPAM_TIER1_TIMEOUT_MS;
    timeoutResult = await tryTimeoutMember(reactingMember, durationMs, "restricted emoji spam (tier 1)");
  } else if (escalation.tier === 2) {
    durationMs = EMOJI_SPAM_TIER2_TIMEOUT_MS;
    timeoutResult = await tryTimeoutMember(reactingMember, durationMs, "restricted emoji spam (tier 2)");
  }

  const dmSent = await safeSend(user, buildUserWarningPayload({
    message,
    emojiDisplay: matchedEmoji.display,
    tier: escalation.tier,
    timeoutResult,
    durationMs
  }));

  if (!reactionRemoved) {
    recordRuntimeEvent("warn", "restricted-reaction-remove", "reaction removal failed");
  }

  // Stat keys mirror the daily-stats counters.
  if (escalation.tier === 0) {
    await recordModerationStat("restricted_reaction_alert");
  } else if (escalation.tier === 1 || escalation.tier === 2) {
    await recordModerationStat("restricted_reaction_timeout");
    await recordModerationStat("emoji_spam_timeout");
  } else if (escalation.tier === 3) {
    await recordModerationStat("emoji_spam_flag");
  }

  await sendLog(guild, buildRestrictedReactionLogPanel({
    message,
    targetMember,
    reactingUserId: user.id,
    reactingUser: user,
    emojiDisplay: matchedEmoji.display,
    emojiKey: matchedEmoji.key,
    reactionRemoved,
    dmSent,
    tier: escalation.tier,
    countInWindow: escalation.count,
    timeoutResult,
    durationMs
  })).catch(() => null);

  return reactionRemoved || dmSent || escalation.tier > 0;
}

module.exports = {
  maybeHandleRestrictedReactionAdd
};
