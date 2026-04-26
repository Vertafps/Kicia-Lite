const { isNoResponseChannel } = require("../channel-policy");

async function safeReact(message, emoji) {
  try {
    await message.react?.(emoji);
    return true;
  } catch {
    return false;
  }
}

async function safeReply(message, payload, { fallbackToChannel = true } = {}) {
  try {
    await message.reply(payload);
    return true;
  } catch (replyErr) {
    const channelId = message?.channelId || message?.channel?.id;
    if (!fallbackToChannel || !message?.channel?.send || isNoResponseChannel(channelId)) {
      throw replyErr;
    }
  }

  await message.channel.send(payload);
  return true;
}

module.exports = {
  safeReact,
  safeReply
};
