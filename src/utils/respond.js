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
    const result = await target?.send?.(payload);
    // `target?.send?.(...)` returns undefined when target is null or has no
    // .send method — that's a no-op, not a successful send. Only count it
    // as sent when send() actually resolved with a Message-like value.
    return result != null;
  } catch (err) {
    try {
      const { recordRuntimeEvent } = require("../runtime-health");
      const code = err?.code || err?.rawError?.code;
      const httpStatus = err?.status || err?.httpStatus;
      const name = err?.name || "Error";
      const msg = err?.message || String(err);
      recordRuntimeEvent(
        "warn",
        "safe-send",
        `${name}${code ? ` (${code})` : ""}${httpStatus ? ` HTTP ${httpStatus}` : ""}: ${msg}`
      );
    } catch {}
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

// Verbose variant of safeSend for user-DM paths where the caller wants to
// know WHY a DM failed (so the moderation log can show "user has DMs
// disabled" instead of just "✗"). Returns {sent, code, reason} — sent is
// the boolean equivalent to safeSend's return.
async function trySendDM(user, payload) {
  try {
    const result = await user?.send?.(payload);
    if (result != null) return { sent: true, code: null, reason: null };
    return { sent: false, code: null, reason: "no send target" };
  } catch (err) {
    const code = err?.code || err?.rawError?.code || null;
    // Map common Discord DM rejection codes to short human reasons.
    let reason;
    switch (code) {
      case 50007: reason = "user DMs disabled"; break;
      case 40003: reason = "rate limited"; break;
      case 50001: reason = "missing access"; break;
      case 50013: reason = "missing permissions"; break;
      default: reason = err?.message?.slice(0, 80) || "send failed";
    }
    try {
      const { recordRuntimeEvent } = require("../runtime-health");
      recordRuntimeEvent("warn", "dm-send", `code=${code || "none"} · ${reason}`);
    } catch {}
    return { sent: false, code, reason };
  }
}

module.exports = {
  safeReact,
  safeReply,
  safeSend,
  safeEdit,
  trySendDM
};
