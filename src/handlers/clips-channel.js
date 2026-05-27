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
const { registerSticky, ensureSticky } = require("./sticky-messages");

const VIDEO_HOST_RE = /\b(?:youtube\.com|youtu\.be|twitch\.tv|streamable\.com|medal\.tv|clips\.twitch\.tv|kick\.com|tiktok\.com|x\.com|twitter\.com|vimeo\.com|dailymotion\.com|reddit\.com\/r\/\S+\/comments)\b/i;
const VIDEO_EXT_RE = /\.(?:mp4|mov|webm|mkv|avi|flv|m4v)(?:\?|#|$)/i;

function hasVideoClip(message) {
  // Attachments: must be video content type, or video file extension
  if (message.attachments?.size > 0) {
    for (const att of message.attachments.values()) {
      const ct = String(att.contentType || "").toLowerCase();
      if (ct.startsWith("video/")) return true;
      const name = String(att.name || "").toLowerCase();
      if (VIDEO_EXT_RE.test(name)) return true;
    }
  }
  // Embeds: only those with a video field, NOT gifv (which is animated GIF)
  if (message.embeds?.length > 0) {
    for (const em of message.embeds) {
      if (em.type === "gifv") continue;   // GIFs are not clips
      if (em.video?.url) return true;
      if (em.url && (VIDEO_HOST_RE.test(em.url) || VIDEO_EXT_RE.test(em.url))) return true;
    }
  }
  // Raw URLs in content
  const urls = String(message.content || "").match(/https?:\/\/\S+/gi) || [];
  for (const url of urls) {
    if (VIDEO_HOST_RE.test(url) || VIDEO_EXT_RE.test(url)) return true;
  }
  return false;
}

async function maybeHandleClipsMessage(message) {
  if (getSetting("clips.guard.enabled") === false) return false;
  if (!message?.inGuild?.()) return false;
  if (message.author?.bot) return false;
  const clipsId = getClipsChannelId();
  if (!clipsId || message.channelId !== clipsId) return false;
  if (hasModerationBypassMessage(message)) {
    // bypass users still get the ✅ auto-react if they post a video clip
    if (hasVideoClip(message)) {
      message.react("✅").catch(() => null);
    }
    return false;
  }

  if (hasVideoClip(message)) {
    // valid clip — react and exit
    message.react("✅").catch(() => null);
    return true;
  }

  // non-video message in clips channel - warn or escalate
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
        await message.member.timeout(timeoutMs, "clips channel: non-video repeat offense");
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
        body: `I've muted you for ${Math.round(timeoutMs / 3600000)}h because you kept sending non-clip messages in the clips channel after warnings. That channel is for videos only.`,
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
        body: `The clips channel is for video clips only (video attachments, YouTube/Twitch/Streamable links, etc). Images, GIFs, and text get auto-removed. Your message was deleted. ${remaining > 0 ? `${remaining} warning${remaining === 1 ? "" : "s"} left before a 24h timeout.` : "Next offense will timeout you."}`,
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

function buildClipsStickyPanel() {
  const { buildRichPanel: _buildRichPanel, INFO: _INFO } = require("../embed");
  return _buildRichPanel({
    title: "clips only",
    description: "drop your clips here. most reactions wins clip of the day.",
    color: _INFO
  });
}

async function ensureClipsChannelSticky(guild) {
  const channelId = getClipsChannelId();
  if (!channelId || !guild) return false;
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return false;

  registerSticky(channelId, buildClipsStickyPanel);
  try {
    await ensureSticky(channel);
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "clips-sticky", err?.message || err);
    return false;
  }
}

module.exports = { maybeHandleClipsMessage, ensureClipsChannelSticky };
