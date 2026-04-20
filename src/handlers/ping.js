const { buildPanel, SUCCESS, DANGER, WARN, INFO } = require("../embed");
const { BRAND, TRANSCRIPT_N } = require("../config");
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

async function buildTranscript(message) {
  const recent = await message.channel.messages.fetch({ limit: 30 });
  return recent
    .filter((m) => m.author.id === message.author.id)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .last(TRANSCRIPT_N)
    .map((m) => cleanText(m.content))
    .filter(Boolean)
    .join("\n");
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

  await message.channel.sendTyping();

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

async function replyWithError(message) {
  const channel = message.channel;
  const target = channel && typeof channel.send === "function" ? channel : null;
  if (!target) return;
  await target
    .send({
      embeds: [
        buildPanel({
          header: "⚠️ Docs Lookup Is Down Right Now",
          body: `I couldn't reach the docs index just now.\n\nUse the **[ticket panel](${BRAND.TICKET_JUMP_URL})** instead.`,
          color: DANGER
        })
      ]
    })
    .catch(() => null);
}

module.exports = { handleDm, handleGuildPing, replyWithError };
