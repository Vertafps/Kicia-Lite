"use strict";
const { buildPanel, buildRichPanel, WARN, DANGER, INFO, resolveAvatarURL } = require("../embed");
const { getClipsChannelId } = require("../channel-config");
const { sendIgnoreLogPanel } = require("../log-channel");
const { trySendDM } = require("../utils/respond");
const { recordRuntimeEvent } = require("../runtime-health");
const { getSetting } = require("../settings");
const { hasModerationBypassMessage } = require("../permissions");
const {
  getClipsWarningState,
  bumpClipsWarning,
  resetClipsWarning
} = require("../restricted-emoji-db");

const URL_RE = /https?:\/\/\S+|www\.\S+/i;

function hasMedia(message) {
  if (message.attachments?.size > 0) return true;
  if (message.embeds?.length > 0) return true;
  if (URL_RE.test(message.content || "")) return true;
  return false;
}

async function maybeHandleClipsMessage(message) {
  if (getSetting("clips.guard.enabled") === false) return false;
  if (!message?.inGuild?.()) return false;
  if (message.author?.bot) return false;
  const clipsId = getClipsChannelId();
  if (!clipsId || message.channelId !== clipsId) return false;
  if (hasModerationBypassMessage(message)) {
    // bypass users still get the ✅ auto-react if they post media
    if (hasMedia(message)) {
      message.react("✅").catch(() => null);
    }
    return false;
  }

  if (hasMedia(message)) {
    // valid clip — react and exit
    message.react("✅").catch(() => null);
    return true;
  }

  // text-only message in clips channel - warn or escalate
  const userId = message.author.id;
  const now = Date.now();
  const decayMs = Number(getSetting("clips.warning.decayMs")) || 24 * 60 * 60 * 1000;
  const threshold = Number(getSetting("clips.warning.threshold")) || 2;
  const timeoutMs = Number(getSetting("clips.timeout.ms")) || 24 * 60 * 60 * 1000;

  let state = { count: 0 };
  try {
    state = await getClipsWarningState(userId, { now, decayMs }) || { count: 0 };
  } catch (err) {
    recordRuntimeEvent("warn", "clips-state-read", err?.message || err);
  }

  // delete the offending message regardless of action
  const deleteResult = await message.delete()
    .then(() => ({ deleted: true }))
    .catch((err) => ({ deleted: false, reason: err?.message || "delete failed" }));

  const willTimeout = state.count >= threshold;
  let timeoutResult = { applied: false, reason: "warn-only" };
  let dmResult = { sent: false, reason: null };

  if (willTimeout) {
    try {
      if (message.member?.timeout) {
        await message.member.timeout(timeoutMs, "clips channel: text-only repeat offense");
        timeoutResult = { applied: true };
      }
    } catch (err) {
      timeoutResult = { applied: false, reason: err?.message || "timeout failed" };
    }
    try {
      await resetClipsWarning(userId);
    } catch {}
    dmResult = await trySendDM(message.author, {
      embeds: [buildPanel({
        header: "Timeout Applied",
        body: `I've muted you for ${Math.round(timeoutMs / 3600000)}h because you kept sending non-clip messages in the clips channel after warnings. That channel is for clips only.`,
        color: WARN
      })]
    });
  } else {
    try {
      await bumpClipsWarning(userId, { now });
    } catch (err) {
      recordRuntimeEvent("warn", "clips-warn-bump", err?.message || err);
    }
    const remaining = threshold - (state.count + 1) + 1;
    dmResult = await trySendDM(message.author, {
      embeds: [buildPanel({
        header: "Heads-up — clips channel",
        body: `The clips channel is for clip uploads only (attachments, video links, embeds). Your text-only message was removed. ${remaining > 0 ? `${remaining} warning${remaining === 1 ? "" : "s"} left before a 24h timeout.` : "Next text-only message will timeout you."}`,
        color: INFO
      })]
    });
  }

  // log to ignore-logs
  const avatar = resolveAvatarURL(message.author);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";
  const dmLabel = dmResult.sent ? "✓ sent" : `✗ ${dmResult.reason || "not sent"}`;
  const panel = buildRichPanel({
    title: willTimeout ? "Clips Channel · Timeout" : "Clips Channel · Warning",
    author: { name: displayName, iconURL: avatar || undefined },
    fields: [
      { name: "User", value: `<@${message.author.id}>`, inline: true },
      { name: "Warning count", value: String(state.count + 1), inline: true },
      { name: "Action", value: willTimeout
          ? `timeout ${Math.round(timeoutMs / 3600000)}h · delete ${deleteResult.deleted ? "ok" : deleteResult.reason || "skipped"} · dm ${dmLabel}`
          : `warn · delete ${deleteResult.deleted ? "ok" : deleteResult.reason || "skipped"} · dm ${dmLabel}`,
        inline: false },
      { name: "Removed text", value: String(message.content || "").slice(0, 500) || "—" }
    ],
    color: willTimeout ? DANGER : WARN
  });
  await sendIgnoreLogPanel(message.guild, panel).catch(() => null);

  return true;
}

async function ensureClipsChannelSticky(guild) {
  const channelId = getClipsChannelId();
  if (!channelId || !guild) return false;
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return false;

  try {
    const pins = await channel.messages.fetchPinned().catch(() => null);
    if (pins) {
      for (const m of pins.values()) {
        if (m.author?.id === guild.client.user.id
          && m.embeds?.[0]?.title?.includes("clips channel")) {
          return false;
        }
      }
    }
  } catch {}

  const sticky = buildRichPanel({
    title: "🎬 clips channel",
    description: [
      "**hii, you can upload your clips here**",
      "",
      "post clips as **attachments**, **video links**, or **embeds**.",
      "refrain from typing in this channel — **clips only**.",
      "",
      "**rules:**",
      "• text-only messages get auto-removed and warned",
      "• 2 warnings, then a 24h timeout on the third",
      "• the bot reacts ✅ to valid clip uploads",
      "",
      "the post with the most reactions at the end of the day gets posted as **clip of the day**.",
      "good luck!"
    ].join("\n"),
    color: INFO
  });

  try {
    const msg = await channel.send({ embeds: [sticky], allowedMentions: { parse: [] } });
    await msg.pin().catch(() => null);
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "clips-sticky", err?.message || err);
    return false;
  }
}

module.exports = { maybeHandleClipsMessage, ensureClipsChannelSticky };
