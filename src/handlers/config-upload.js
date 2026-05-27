"use strict";
const { buildPanel, buildRichPanel, WARN, DANGER, INFO, resolveAvatarURL } = require("../embed");
const { getConfigChannelId } = require("../channel-config");
const { recordRuntimeEvent } = require("../runtime-health");
const { safeReply } = require("../utils/respond");
const { sendIgnoreLogPanel } = require("../log-channel");
const { trySendDM } = require("../utils/respond");
const { getSetting } = require("../settings");
const { hasModerationBypassMessage } = require("../permissions");
const {
  getConfigWarningState,
  bumpConfigWarning,
  resetConfigWarning
} = require("../restricted-emoji-db");
const { registerSticky, ensureSticky, bumpSticky } = require("./sticky-messages");

// Video validation — file form (attachment) and URL form (hosted). GIFs are
// explicitly rejected in both. Owner requires every config submission to be
// paired with a video showcase, but accepts either an uploaded video file
// or a link to a major video host (YouTube, Streamable, TikTok, Twitch, etc.)
const VIDEO_EXT_RE = /\.(?:mp4|mov|webm|mkv|avi|flv|m4v)(?:\?|#|$)/i;
const VIDEO_HOST_RE = /\b(?:youtube\.com|youtu\.be|twitch\.tv|streamable\.com|medal\.tv|clips\.twitch\.tv|kick\.com|tiktok\.com|x\.com|twitter\.com|vimeo\.com|dailymotion\.com)\b/i;
const GIF_HOST_OR_EXT_RE = /(?:\.gif(?:\?|#|$)|tenor\.com|giphy\.com)/i;

function attachmentIsVideo(att) {
  if (!att) return false;
  const ct = String(att.contentType || "").toLowerCase();
  if (ct.startsWith("image/")) return false; // GIFs and PNGs land here
  if (ct.startsWith("video/")) return true;
  const name = String(att.name || "").toLowerCase();
  if (/\.gif(?:\?|#|$)/i.test(name)) return false;
  return VIDEO_EXT_RE.test(name);
}

function videoUrlLooksValid(url) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (GIF_HOST_OR_EXT_RE.test(u)) return false;
  return VIDEO_HOST_RE.test(u) || VIDEO_EXT_RE.test(u);
}

async function handleUploadConfigInteraction(interaction) {
  if (interaction.options.getSubcommand?.() !== "config") return false;

  const name = interaction.options.getString("name", true);
  const type = interaction.options.getString("type", true);
  const file = interaction.options.getAttachment("file", true);
  const video = interaction.options.getAttachment("video"); // now optional
  const videoLink = (interaction.options.getString("video_link") || "").trim();
  const comments = interaction.options.getString("comments") || "";

  // Caller must supply EITHER a video file OR a video URL.
  if (!video && !videoLink) {
    await interaction.reply({
      content: "You must include a showcase video — either upload it via the `video` option or paste a link via `video_link` (YouTube / Streamable / TikTok / Twitch / etc).",
      ephemeral: true
    });
    return true;
  }
  if (video && !attachmentIsVideo(video)) {
    await interaction.reply({
      content: "The `video` attachment must be an actual video file (mp4 / mov / webm / mkv / avi / flv / m4v). GIFs and images aren't accepted — use `video_link` for hosted videos.",
      ephemeral: true
    });
    return true;
  }
  if (videoLink && !videoUrlLooksValid(videoLink)) {
    await interaction.reply({
      content: "The `video_link` must point to a real video — YouTube, Streamable, TikTok, Twitch, Medal, Vimeo, Kick, or a direct .mp4/.mov/.webm/.mkv URL. GIFs (Tenor/Giphy) aren't accepted.",
      ephemeral: true
    });
    return true;
  }

  // Resolve config channel
  const channelId = getConfigChannelId();
  if (!channelId) {
    await interaction.reply({
      content: "Config channel isn't configured yet. Ping staff.",
      ephemeral: true
    });
    return true;
  }
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Use this in a server.", ephemeral: true });
    return true;
  }
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) {
    await interaction.reply({
      content: "Couldn't reach the configured config channel.",
      ephemeral: true
    });
    return true;
  }

  // Acknowledge immediately so Discord doesn't show "application didn't
  // respond" — the channel.send below can take several seconds when Discord
  // re-uploads the video file. After this reply we use followUp/editReply
  // (15 min window) for the final submission link.
  try {
    await interaction.reply({
      content: "ok will upload in a little bit 👍",
      ephemeral: true
    });
  } catch {
    // already acknowledged somehow — fall through and rely on followUp later
  }

  // Build the submission embed
  const author = {
    name: interaction.member?.displayName || interaction.user?.globalName || interaction.user?.username || "user",
    iconURL: interaction.user?.displayAvatarURL?.() || undefined
  };
  const fields = [
    { name: "name", value: String(name).slice(0, 256), inline: true },
    { name: "type", value: String(type), inline: true },
    { name: "submitted by", value: `<@${interaction.user.id}>`, inline: true }
  ];
  if (comments.trim()) {
    fields.push({ name: "additional comments", value: String(comments).slice(0, 1000), inline: false });
  }
  fields.push({ name: "config file", value: `[${file.name}](${file.url})`, inline: false });
  if (video) {
    fields.push({ name: "showcase video", value: `[${video.name}](${video.url})`, inline: false });
  }
  if (videoLink) {
    fields.push({ name: "video link", value: videoLink.slice(0, 1000), inline: false });
  }

  const panel = buildRichPanel({
    title: `Config Submission · ${name}`,
    author,
    fields,
    color: INFO
  });

  // Triple-line separator above the new submission so adjacent configs are
  // clearly distinct in the channel.
  const SEPARATOR = [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  ].join("\n");

  // Compose the post. Video link goes in content (Discord auto-embeds it
  // as a playable widget for supported hosts); attachment goes via files[].
  const sendPayload = {
    content: videoLink ? `${SEPARATOR}\n${videoLink}` : SEPARATOR,
    embeds: [panel],
    files: [{ attachment: file.url, name: file.name }],
    allowedMentions: { parse: [] }
  };
  if (video) {
    sendPayload.files.push({ attachment: video.url, name: video.name });
  }

  let posted;
  try {
    posted = await channel.send(sendPayload);
  } catch (err) {
    recordRuntimeEvent("warn", "config-upload-send", err?.message || err);
    try {
      await interaction.followUp({
        content: "Failed to post the submission. Ping staff.",
        ephemeral: true
      });
    } catch {}
    return true;
  }

  // Auto-react with check mark
  posted.react("✅").catch(() => null);

  // Re-bump the sticky so it sits BELOW the new submission. /upload config
  // posts as the bot, so the normal non-bot-message bump hook in index.js
  // doesn't fire — we trigger it explicitly here.
  try { bumpSticky(channel); } catch {}

  try {
    await interaction.followUp({
      content: `Submitted! View: ${posted.url}`,
      ephemeral: true
    });
  } catch {
    // followUp can fail if the interaction token expired; not fatal
  }

  return true;
}

async function maybeHandleConfigChannelMessage(message) {
  if (getSetting("config.guard.enabled") === false) return false;
  if (!message?.inGuild?.()) return false;
  if (message.author?.bot) return false;
  const configId = getConfigChannelId();
  if (!configId || message.channelId !== configId) return false;
  if (hasModerationBypassMessage(message)) {
    return false;
  }

  const userId = message.author.id;
  const now = Date.now();
  const decayMs = Number(getSetting("config.warning.decayMs")) || 24 * 60 * 60 * 1000;
  const threshold = Number(getSetting("config.warning.threshold")) || 2;
  const timeoutMs = Number(getSetting("config.timeout.ms")) || 24 * 60 * 60 * 1000;

  let state = { count: 0 };
  try {
    state = await getConfigWarningState(userId, { now, decayMs }) || { count: 0 };
  } catch (err) {
    recordRuntimeEvent("warn", "config-state-read", err?.message || err);
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
        await message.member.timeout(timeoutMs, "config channel: chatting repeat offense");
        timeoutResult = { applied: true };
      }
    } catch (err) {
      timeoutResult = { applied: false, reason: err?.message || "timeout failed" };
    }
    try {
      await resetConfigWarning(userId);
    } catch {}
    dmResult = await trySendDM(message.author, {
      embeds: [buildPanel({
        header: "Timeout Applied",
        body: `I've muted you for ${Math.round(timeoutMs / 3600000)}h because you kept chatting in the config submissions channel after warnings. That channel is upload-only — use \`/upload config\` to submit.`,
        color: WARN
      })]
    });
  } else {
    try {
      await bumpConfigWarning(userId, { now });
    } catch (err) {
      recordRuntimeEvent("warn", "config-warn-bump", err?.message || err);
    }
    const remaining = threshold - (state.count + 1) + 1;
    dmResult = await trySendDM(message.author, {
      embeds: [buildPanel({
        header: "Heads-up — config submissions channel",
        body: `The config submissions channel is for \`/upload config\` submissions only — no chatting. Your text message was removed. ${remaining > 0 ? `${remaining} warning${remaining === 1 ? "" : "s"} left before a 24h timeout.` : "Next offense will timeout you."}`,
        color: INFO
      })]
    });
  }

  // log to ignore-logs
  const avatar = resolveAvatarURL(message.author);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";
  const dmLabel = dmResult.sent ? "✓ sent" : `✗ ${dmResult.reason || "not sent"}`;
  const logPanel = buildRichPanel({
    title: willTimeout ? "Config Channel · Timeout" : "Config Channel · Warning",
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
  await sendIgnoreLogPanel(message.guild, logPanel).catch(() => null);

  return true;
}

function buildConfigStickyPanel() {
  const { buildRichPanel: _buildRichPanel, INFO: _INFO } = require("../embed");
  return _buildRichPanel({
    title: "📌 config submissions — read before posting",
    description: [
      "this channel is for config submissions only",
      "**do not chat here**",
      "",
      "**how to submit:**",
      "use `/upload config` and fill in the fields:",
      "• `name` — your config's name",
      "• `type` — rage / semi-rage / legit / semi-legit",
      "• `file` — the config file attachment",
      "• **video required** — either upload via `video` (mp4/mov/webm/etc.) OR paste a URL via `video_link` (YouTube / Streamable / TikTok / Twitch / Medal / Vimeo / Kick). GIFs are not accepted.",
      "• `comments` — optional notes (recommendations, etc.)"
    ].join("\n"),
    color: _INFO
  });
}

async function ensureConfigChannelSticky(guild) {
  const channelId = getConfigChannelId();
  if (!channelId || !guild) return false;
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return false;

  registerSticky(channelId, buildConfigStickyPanel);
  try {
    await ensureSticky(channel);
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "config-sticky", err?.message || err);
    return false;
  }
}

module.exports = { handleUploadConfigInteraction, maybeHandleConfigChannelMessage, ensureConfigChannelSticky };
