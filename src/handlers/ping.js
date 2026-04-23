const { buildPanel, SUCCESS, DANGER, WARN, INFO } = require("../embed");
const { BRAND, RECENT_CHANNEL_MESSAGES_N, TRANSCRIPT_N } = require("../config");
const { fetchKb } = require("../kb");
const { classifyTranscript } = require("../router");
const { getRuntimeStatus } = require("../runtime-status");
const { cleanText } = require("../text");
const { getCooldownReaction, markGuildReply } = require("./cooldown");

const COLOR_BY_NAME = {
  success: SUCCESS,
  danger: DANGER,
  warn: WARN,
  info: INFO
};

// BUG FIX: wrapped channel.messages.fetch in try/catch so a permission error
// or API hiccup doesn't crash the entire message handler. Falls back to just
// the current message content so the bot can still attempt a reply.
async function buildTranscript(message) {
  try {
    const recent = await message.channel.messages.fetch({ limit: RECENT_CHANNEL_MESSAGES_N });
    const transcriptMessages = recent
      .filter((m) => m.author.id === message.author.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .last(TRANSCRIPT_N);

    const lines = transcriptMessages
      .map((m) => cleanText(m.content))
      .filter(Boolean);

    if (lines.length) return lines.join("\n");
  } catch (err) {
    console.warn("buildTranscript: channel fetch failed, falling back to message content:", err.message);
  }

  // Fallback: use just the current message so we still have something to classify
  return cleanText(message.content);
}

async function handleDm(message) {
  await message.reply({
    embeds: [
      buildPanel({
        header: "👋 Use Me In The Main Server",
        body: `I only work inside the ${BRAND.NAME} main server channels. Ping me there and I'll check the docs.`,
        color: INFO
      })
    ],
    allowedMentions: { repliedUser: false }
  });
}

async function handleGuildPing(message) {
  const cooldownEmoji = getCooldownReaction(message.author.id);
  if (cooldownEmoji) {
    await message.react(cooldownEmoji).catch(() => null);
    return;
  }

  await message.channel.sendTyping().catch(() => null);

  const transcript = await buildTranscript(message);
  const kb = await fetchKb();
  const route = classifyTranscript(transcript, kb, getRuntimeStatus());
  const embed = buildPanel({
    header: route.header,
    body: route.body,
    tip: route.tip,
    tipStyle: route.tipStyle,
    tipLevel: route.tipLevel,
    extra: route.extra,
    color: COLOR_BY_NAME[route.color] || INFO
  });

  await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  markGuildReply(message.author.id);
}

// BUG FIX: try message.reply first (keeps thread context), fall back to
// channel.send if the message was deleted or reply throws, and swallow
// errors from the fallback too so nothing propagates.
async function replyWithError(message) {
  const errorEmbed = buildPanel({
    header: "⚠️ Docs Lookup Is Down Right Now",
    body: `I couldn't reach the docs index just now.\n\nUse the **[ticket panel](${BRAND.TICKET_JUMP_URL})** instead.`,
    color: DANGER
  });

  try {
    await message.reply({ embeds: [errorEmbed], allowedMentions: { repliedUser: false } });
    return;
  } catch {
    // Message may have been deleted — try channel.send instead
  }

  try {
    await message.channel?.send({ embeds: [errorEmbed] });
  } catch {
    // Nothing we can do at this point
  }
}

module.exports = { handleDm, handleGuildPing, replyWithError };
