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
  // Pass-through path: most callers (the whole moderation pipeline via
  // attachLogButtons) hand us a fully-formed Discord payload with
  // {embeds:[EmbedBuilder], components, allowedMentions}. Without this
  // branch the legacy `...panel` spread below silently dropped the real
  // embed and replaced it with an empty buildPanel() result — that's
  // the "bot name + timestamp, nothing else" symptom in the log channel.
  if (panel && Array.isArray(panel.embeds) && panel.embeds.length) {
    const out = {
      embeds: panel.embeds,
      components: Array.isArray(panel.components) ? panel.components : [],
      allowedMentions: panel.allowedMentions || { parse: [] }
    };
    if (Array.isArray(panel.files) && panel.files.length) out.files = panel.files;
    if (typeof panel.content === "string" && panel.content.length) out.content = panel.content;
    return out;
  }

  // Legacy paths: bare EmbedBuilder, {embed: EmbedBuilder}, or buildPanel
  // options. Kept for callers that haven't been migrated to the payload shape.
  const embed = typeof panel?.embed?.toJSON === "function"
    ? panel.embed
    : typeof panel?.toJSON === "function"
      ? panel
      : buildPanel({ autoFields: true, ...panel });

  const payload = {
    embeds: [embed],
    components: Array.isArray(panel?.components) ? panel.components : [],
    allowedMentions: { parse: [] }
  };
  if (Array.isArray(panel?.files) && panel.files.length) {
    payload.files = panel.files;
  }
  return payload;
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
