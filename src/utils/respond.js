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
    return await message.reply(payload) || true;
  } catch (replyErr) {
    const channelId = message?.channelId || message?.channel?.id;
    if (!fallbackToChannel || !message?.channel?.send || isNoResponseChannel(channelId)) {
      throw replyErr;
    }
  }

  return await message.channel.send(payload) || true;
}

async function safeSend(target, payload) {
  try {
    await target?.send?.(payload);
    return true;
  } catch {
    return false;
  }
}

async function safeEdit(message, payload) {
  if (typeof message?.edit !== "function") return false;
  try {
    return await message.edit(payload) || true;
  } catch {
    return false;
  }
}

module.exports = {
  safeReact,
  safeReply,
  safeSend,
  safeEdit
};
