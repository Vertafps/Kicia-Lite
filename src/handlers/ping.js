const { buildPanel, SUCCESS, DANGER, WARN, INFO, brandAuthor } = require("../embed");
const ui = require("../ui");
const { buildLinkButtonRows } = require("../components");
const { BRAND, RECENT_CHANNEL_MESSAGES_N, TRANSCRIPT_N } = require("../config");
const { getTicketJumpUrl } = require("../channel-config");
const { fetchKb } = require("../kb");
const { classifyTranscript } = require("../router");
const { getRuntimeStatus } = require("../runtime-status");
const { cleanText } = require("../text");
const { safeReact, safeReply } = require("../utils/respond");
const { getCooldownReaction, markGuildReply } = require("./cooldown");

const COLOR_BY_NAME = {
  success: SUCCESS,
  danger: DANGER,
  warn: WARN,
  info: INFO
};

async function buildTranscript(message) {
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const now = Date.now();

  try {
    const recent = await message.channel.messages.fetch({ limit: RECENT_CHANNEL_MESSAGES_N });
    const transcriptMessages = recent
      .filter((m) => m.author.id === message.author.id && now - m.createdTimestamp < TEN_MINUTES_MS)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .last(TRANSCRIPT_N);

    const lines = transcriptMessages
      .map((m) => cleanText(m.content))
      .filter(Boolean);

    if (lines.length) return lines.join("\n");
  } catch (err) {
    console.warn("buildTranscript: channel fetch failed, falling back to message content:", err.message);
  }

  return cleanText(message.content);
}

async function handleDm(message) {
  await safeReply(message, {
    embeds: [
      buildPanel({
        header: "\u{1F44B} Use Me In The Main Server",
        body: `I only work inside the ${BRAND.NAME} main server channels. Ping me there and I'll check the docs.`,
        color: INFO,
        author: brandAuthor("DM · REDIRECT")
      })
    ],
    allowedMentions: { repliedUser: false }
  });
}

async function handleGuildPing(message) {
  const cooldownEmoji = getCooldownReaction(message.author.id);
  if (cooldownEmoji) {
    await safeReact(message, cooldownEmoji);
    return;
  }

  await message.channel.sendTyping().catch(() => null);

  const transcript = await buildTranscript(message);
  const kb = await fetchKb();
  const route = classifyTranscript(transcript, kb, getRuntimeStatus());

  if (route.kind === "docs" && route.kb) {
    const built = ui.buildKbMatchEmbed({
      question: transcript,
      title: route.kb.title,
      tag: route.kb.tag,
      steps: route.kb.steps,
      step: 1,
      match: route.kb.match,
      source: route.kb.source,
      url: route.kb.url
    });
    await safeReply(message, {
      embeds: built.embeds,
      components: buildLinkButtonRows(route.buttons),
      files: built.files,
      allowedMentions: { repliedUser: false }
    });
    markGuildReply(message.author.id);
    return;
  }

  if (route.kind === "ticket" && route.kb) {
    const built = ui.buildKbNoMatchEmbed({
      question: transcript,
      score: route.kb.score,
      ticketUrl: getTicketJumpUrl(),
      closestArticles: route.kb.closestArticles
    });
    await safeReply(message, {
      embeds: built.embeds,
      components: buildLinkButtonRows(route.buttons),
      files: built.files,
      allowedMentions: { repliedUser: false }
    });
    markGuildReply(message.author.id);
    return;
  }

  if (route.kind === "executor_list" && Array.isArray(route.executors) && route.executors.length) {
    const { AttachmentBuilder } = require("discord.js");
    const buf = ui.canvas.renderExecutorList({ executors: route.executors });
    const img = new AttachmentBuilder(buf, { name: "executor-list.png" });
    const embed = buildPanel({
      header: route.header,
      body: route.body,
      tip: route.tip,
      tipStyle: route.tipStyle,
      tipLevel: route.tipLevel,
      extra: route.extra,
      color: COLOR_BY_NAME[route.color] || INFO,
      author: brandAuthor("KB · EXECUTOR")
    });
    embed.setImage("attachment://executor-list.png");
    await safeReply(message, {
      embeds: [embed],
      components: buildLinkButtonRows(route.buttons),
      files: [img],
      allowedMentions: { repliedUser: false }
    });
    markGuildReply(message.author.id);
    return;
  }

  const sectionLabel = route.kind === "executor" || route.kind === "executor_unknown" || route.kind === "executor_list"
    ? "EXECUTOR"
    : route.kind === "status"
      ? "STATUS"
      : route.kind === "ticket"
        ? "TICKET"
        : route.kind === "docs"
          ? "DOCS"
          : "REPLY";
  const embed = buildPanel({
    header: route.header,
    body: route.body,
    tip: route.tip,
    tipStyle: route.tipStyle,
    tipLevel: route.tipLevel,
    extra: route.extra,
    color: COLOR_BY_NAME[route.color] || INFO,
    author: brandAuthor(`KB · ${sectionLabel}`)
  });

  await safeReply(message, {
    embeds: [embed],
    components: buildLinkButtonRows(route.buttons),
    allowedMentions: { repliedUser: false }
  });
  markGuildReply(message.author.id);
}

async function replyWithError(message) {
  const errorEmbed = buildPanel({
    header: "\u26A0\uFE0F Docs Lookup Is Down Right Now",
    body: `I couldn't reach the docs index just now.\n\nUse the **[ticket panel](${getTicketJumpUrl()})** instead.`,
    color: DANGER,
    author: brandAuthor("KB \u00B7 OFFLINE")
  });

  try {
    await safeReply(message, {
      embeds: [errorEmbed],
      components: buildLinkButtonRows([{ label: "Open Ticket Panel", url: getTicketJumpUrl() }]),
      allowedMentions: { repliedUser: false }
    });
  } catch {
    // Nothing we can do at this point.
  }
}

module.exports = { handleDm, handleGuildPing, replyWithError };
