"use strict";
const { buildRichPanel, INFO } = require("../embed");
const { getConfigChannelId } = require("../channel-config");
const { recordRuntimeEvent } = require("../runtime-health");
const { safeReply } = require("../utils/respond");

async function handleUploadConfigInteraction(interaction) {
  if (interaction.options.getSubcommand?.() !== "config") return false;

  const name = interaction.options.getString("name", true);
  const type = interaction.options.getString("type", true);
  const file = interaction.options.getAttachment("file", true);
  const comments = interaction.options.getString("comments") || "";

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
  fields.push({ name: "attachment", value: `[${file.name}](${file.url})`, inline: false });

  const panel = buildRichPanel({
    title: `Config Submission · ${name}`,
    author,
    fields,
    color: INFO
  });

  let posted;
  try {
    posted = await channel.send({
      embeds: [panel],
      files: [{ attachment: file.url, name: file.name }],
      allowedMentions: { parse: [] }
    });
  } catch (err) {
    recordRuntimeEvent("warn", "config-upload-send", err?.message || err);
    await interaction.reply({
      content: "Failed to post the submission. Ping staff.",
      ephemeral: true
    });
    return true;
  }

  // Auto-react with check mark
  posted.react("✅").catch(() => null);

  await interaction.reply({
    content: `Submitted! View: ${posted.url}`,
    ephemeral: true
  });

  return true;
}

async function ensureConfigChannelSticky(guild) {
  const channelId = getConfigChannelId();
  if (!channelId || !guild) return false;
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return false;

  // Check existing pins for our sticky (by title match)
  try {
    // fetchPins() is the discord.js v15 replacement; fall back to fetchPinned()
    // for older versions in case nodemon is mid-rolling-upgrade.
    const fetcher = typeof channel.messages.fetchPins === "function"
      ? channel.messages.fetchPins()
      : channel.messages.fetchPinned();
    const pins = await fetcher.catch(() => null);
    if (pins) {
      for (const m of pins.values()) {
        if (m.author?.id === guild.client.user.id
          && m.embeds?.[0]?.title?.includes("config submissions")) {
          return false; // already pinned, nothing to do
        }
      }
    }
  } catch {}

  const sticky = buildRichPanel({
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
      "• `comments` — optional notes (recommendations, etc.)",
      "",
      "the bot reacts ✅ when your submission goes through",
      "no chatting — this channel is upload-only"
    ].join("\n"),
    color: INFO
  });

  try {
    const msg = await channel.send({ embeds: [sticky], allowedMentions: { parse: [] } });
    await msg.pin().catch(() => null);
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "config-sticky", err?.message || err);
    return false;
  }
}

module.exports = { handleUploadConfigInteraction, ensureConfigChannelSticky };
