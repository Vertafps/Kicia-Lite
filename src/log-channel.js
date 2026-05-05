const { LOG_CHANNEL_ID } = require("./config");
const { buildPanel } = require("./embed");

async function resolveLogChannel(guild) {
  if (!guild?.channels) return null;

  const cached = guild.channels.cache?.get(LOG_CHANNEL_ID);
  if (cached?.send) return cached;

  if (typeof guild.channels.fetch === "function") {
    const fetched = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (fetched?.send) return fetched;
  }

  return null;
}

async function sendLogPanel(guild, panel) {
  const channel = await resolveLogChannel(guild);
  if (!channel) return false;
  const embed = typeof panel?.embed?.toJSON === "function"
    ? panel.embed
    : typeof panel?.toJSON === "function"
      ? panel
      : buildPanel(panel);

  await channel.send({
    embeds: [embed],
    components: panel.components || [],
    allowedMentions: { parse: [] }
  });
  return true;
}

module.exports = {
  LOG_CHANNEL_ID,
  resolveLogChannel,
  sendLogPanel
};
