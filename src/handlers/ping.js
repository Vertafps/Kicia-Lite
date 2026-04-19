const { buildPanel, SUCCESS, DANGER, WARN, INFO } = require("../embed");
const { BRAND, TRANSCRIPT_N } = require("../config");
const { fetchKb, tryKeywordMatch } = require("../kb");
const { isCoolingDown, markReplied } = require("./cooldown");

const STRIP_USER_MENTIONS_RE = /<@!?\d+>/g;

function cleanText(text) {
  return (text || "").replace(STRIP_USER_MENTIONS_RE, " ").replace(/\s+/g, " ").trim();
}

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
        header: "👋 Use me in the main server",
        body: `I only work inside the ${BRAND.NAME} main server channels — ping me there and I'll check your question against the docs.`,
        color: INFO
      })
    ],
    allowedMentions: { repliedUser: false }
  });
}

async function handleGuildPing(message) {
  if (isCoolingDown(message.author.id)) {
    await message.react("⏸️").catch(() => null);
    return;
  }

  await message.channel.sendTyping();

  const transcript = await buildTranscript(message);
  if (!transcript) {
    await message.reply({
      embeds: [
        buildPanel({
          header: "⚠️ Describe your issue first",
          body: "I can't read minds! Send a message describing your problem, then ping me again and I'll check the docs.",
          color: WARN
        })
      ],
      allowedMentions: { repliedUser: false }
    });
    markReplied(message.author.id);
    return;
  }

  const kb = await fetchKb();
  const match = tryKeywordMatch(transcript, kb);
  const embed = match
    ? buildPanel({
        header: "📚 Found this one in the docs",
        body: `Looks like your issue matches **${match.title}** — it's already covered in our documentation.`,
        tip: `Check documentation: [jump to docs](${BRAND.DOCS_JUMP_URL})`,
        color: SUCCESS
      })
    : buildPanel({
        header: "🎫 Can't find that one in the docs",
        body:
          `Hmm — I couldn't match that to anything in our documentation.\n\n` +
          `Try opening a ticket here and our staff team (and I 💜) will help you out: **[ticket panel](${BRAND.TICKET_JUMP_URL})**`,
        tip: "When you open a ticket, include screenshots and what you've already tried — faster help that way.",
        color: INFO
      });

  await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
  markReplied(message.author.id);
}

async function replyWithError(message) {
  const channel = message.channel;
  const target = channel && typeof channel.send === "function" ? channel : null;
  if (!target) return;
  await target.send({
    embeds: [
      buildPanel({
        header: "⚠️ KB lookup is unavailable right now",
        body: `I couldn't reach the documentation index just now.\n\nIf this keeps happening, use the **[ticket panel](${BRAND.TICKET_JUMP_URL})** instead.`,
        color: DANGER
      })
    ]
  }).catch(() => null);
}

module.exports = { handleDm, handleGuildPing, replyWithError };
