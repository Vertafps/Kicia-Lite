const { getNoResponseChannelIds } = require("./channel-config");

function getMessageChannelId(message) {
  return message?.channelId || message?.channel?.id || null;
}

function isNoResponseChannel(channelId) {
  return !!channelId && new Set(getNoResponseChannelIds()).has(String(channelId));
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
