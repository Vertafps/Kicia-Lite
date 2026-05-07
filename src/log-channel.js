const {
  getIgnoreLogChannelId,
  getLogChannelId
} = require("./channel-config");
const { buildPanel } = require("./embed");

async function resolveConfiguredLogChannel(guild, channelId) {
  if (!guild?.channels || !channelId) return null;

  const cached = guild.channels.cache?.get(channelId);
  if (cached?.send) return cached;

  if (typeof guild.channels.fetch === "function") {
    const fetched = await guild.channels.fetch(channelId).catch(() => null);
    if (fetched?.send) return fetched;
  }

  return null;
}

async function resolveLogChannel(guild) {
  return resolveConfiguredLogChannel(guild, getLogChannelId());
}

async function resolveIgnoreLogChannel(guild) {
  const ignoreLogChannelId = getIgnoreLogChannelId();
  if (ignoreLogChannelId) {
    const ignoreChannel = await resolveConfiguredLogChannel(guild, ignoreLogChannelId);
    if (ignoreChannel) return ignoreChannel;
  }

  return resolveLogChannel(guild);
}

function buildLogPayload(panel) {
  const embed = typeof panel?.embed?.toJSON === "function"
    ? panel.embed
    : typeof panel?.toJSON === "function"
      ? panel
      : buildPanel({ autoFields: true, ...panel });

  return {
    embeds: [embed],
    components: panel.components || [],
    allowedMentions: { parse: [] }
  };
}

async function sendLogPanel(guild, panel) {
  const channel = await resolveLogChannel(guild);
  if (!channel) return false;
  await channel.send(buildLogPayload(panel));
  return true;
}

async function sendIgnoreLogPanel(guild, panel) {
  const channel = await resolveIgnoreLogChannel(guild);
  if (!channel) return false;
  await channel.send(buildLogPayload(panel));
  return true;
}

module.exports = {
  get IGNORE_LOG_CHANNEL_ID() {
    return getIgnoreLogChannelId() || getLogChannelId();
  },
  get LOG_CHANNEL_ID() {
    return getLogChannelId();
  },
  resolveIgnoreLogChannel,
  resolveLogChannel,
  sendIgnoreLogPanel,
  sendLogPanel
};
