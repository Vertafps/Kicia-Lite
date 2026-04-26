const { NO_RESPONSE_CHANNEL_IDS } = require("./config");

const noResponseChannelIds = new Set(NO_RESPONSE_CHANNEL_IDS);

function getMessageChannelId(message) {
  return message?.channelId || message?.channel?.id || null;
}

function isNoResponseChannel(channelId) {
  return !!channelId && noResponseChannelIds.has(String(channelId));
}

function isNoResponseMessage(message) {
  if (!message?.inGuild?.()) return false;
  return isNoResponseChannel(getMessageChannelId(message));
}

module.exports = {
  getMessageChannelId,
  isNoResponseChannel,
  isNoResponseMessage
};
