const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");

const MODLOG_VIEW_PREFIX = "modlog:messages:";
const MODLOG_REVERT_PREFIX = "modlog:revert:";
const NICKMOD_RENAME_PREFIX = "nickmod:rename:";
const NICKMOD_MODAL_PREFIX = "nickmod:rename-submit:";
const NICKMOD_NICKNAME_INPUT_ID = "nickmod:nickname";
const OUTAGE_CONFIRM_PREFIX = "outage:confirm:";
const OUTAGE_DISMISS_PREFIX = "outage:dismiss:";
const SCAM_REVIEW_TRUE_PREFIX = "scam_review_true:";
const SCAM_REVIEW_FALSE_PREFIX = "scam_review_false:";
const SCAM_FEEDBACK_PREFIX = "scam_review_feedback:";

const SCAM_FEEDBACK_CATEGORIES = [
  { value: "casual_mention", label: "Casual mention",   description: "User mentioned something in passing, not selling." },
  { value: "asking",         label: "Asking, not selling", description: "User was asking about a thing, not offering it." },
  { value: "buying",         label: "Buying, not selling", description: "User was the buyer side, not the scammer." },
  { value: "joke_or_quote",  label: "Joke or quote",    description: "Sarcasm, meme, or quoting someone else." },
  { value: "other",          label: "Other",            description: "Something else — just flag it as a miss." }
];

function isValidHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildLinkButtonRows(buttons = []) {
  const validButtons = (buttons || [])
    .filter((button) => button?.label && isValidHttpUrl(button.url))
    .slice(0, 5);

  if (!validButtons.length) return [];

  return [
    new ActionRowBuilder().addComponents(
      validButtons.map((button) =>
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(String(button.label).slice(0, 80))
          .setURL(button.url)
      )
    )
  ];
}

function buildModerationLogButtonRows(actionId, {
  canRevert = true,
  disabled = false
} = {}) {
  const id = String(actionId || "").trim();
  if (!id) return [];

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${MODLOG_VIEW_PREFIX}${id}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("\u{1F50E}")
        .setLabel("View Context")
        .setDisabled(Boolean(disabled)),
      new ButtonBuilder()
        .setCustomId(`${MODLOG_REVERT_PREFIX}${id}`)
        .setStyle(ButtonStyle.Danger)
        .setEmoji("\u21A9\uFE0F")
        .setLabel("Undo Timeout")
        .setDisabled(Boolean(disabled) || !canRevert)
    )
  ];
}

function buildOutageReviewButtonRows(reviewId, { disabled = false } = {}) {
  const id = String(reviewId || "").trim();
  if (!id) return [];

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${OUTAGE_CONFIRM_PREFIX}${id}`)
        .setStyle(ButtonStyle.Danger)
        .setEmoji("\u{1F6A8}")
        .setLabel("Confirm Outage")
        .setDisabled(Boolean(disabled)),
      new ButtonBuilder()
        .setCustomId(`${OUTAGE_DISMISS_PREFIX}${id}`)
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅")
        .setLabel("False Alarm")
        .setDisabled(Boolean(disabled))
    )
  ];
}

function buildScamReviewButtonRows(auditId, { disabled = false } = {}) {
  const id = String(auditId || "").trim();
  if (!id) return [];

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${SCAM_REVIEW_TRUE_PREFIX}${id}`)
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅")
        .setLabel("Correct")
        .setDisabled(Boolean(disabled)),
      new ButtonBuilder()
        .setCustomId(`${SCAM_REVIEW_FALSE_PREFIX}${id}`)
        .setStyle(ButtonStyle.Danger)
        .setEmoji("❌")
        .setLabel("False Positive")
        .setDisabled(Boolean(disabled))
    )
  ];
}

function buildNicknameModerationButtonRows(userId, { disabled = false } = {}) {
  const id = String(userId || "").trim();
  if (!id) return [];

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${NICKMOD_RENAME_PREFIX}${id}`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Set Nickname")
        .setDisabled(Boolean(disabled))
    )
  ];
}

function buildScamFeedbackSelectRows(auditId, { disabled = false } = {}) {
  const id = String(auditId || "").trim();
  if (!id) return [];

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${SCAM_FEEDBACK_PREFIX}${id}`)
    .setPlaceholder("Tell the bot why this was wrong (helps the model)")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(Boolean(disabled));

  for (const opt of SCAM_FEEDBACK_CATEGORIES) {
    select.addOptions({
      label: opt.label,
      value: opt.value,
      description: opt.description
    });
  }

  return [new ActionRowBuilder().addComponents(select)];
}

/**
 * Generic paginated button row — Prev / Page indicator / Next.
 * Custom ID format: `${prefix}page:${pageNumber}` (zero-indexed).
 * Caller wires the matching handler.
 */
function buildPaginationButtonRows(prefix, { currentPage = 0, totalPages = 1, disabled = false } = {}) {
  const safePrefix = String(prefix || "").trim();
  if (!safePrefix) return [];
  const total = Math.max(1, totalPages);
  const page = Math.max(0, Math.min(total - 1, currentPage));

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${safePrefix}page:${page - 1}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("◀️")
        .setLabel("Prev")
        .setDisabled(Boolean(disabled) || page <= 0),
      new ButtonBuilder()
        .setCustomId(`${safePrefix}page:indicator`)
        .setStyle(ButtonStyle.Secondary)
        .setLabel(`${page + 1} / ${total}`)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`${safePrefix}page:${page + 1}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("▶️")
        .setLabel("Next")
        .setDisabled(Boolean(disabled) || page >= total - 1)
    )
  ];
}

module.exports = {
  MODLOG_REVERT_PREFIX,
  MODLOG_VIEW_PREFIX,
  NICKMOD_MODAL_PREFIX,
  NICKMOD_NICKNAME_INPUT_ID,
  NICKMOD_RENAME_PREFIX,
  OUTAGE_CONFIRM_PREFIX,
  OUTAGE_DISMISS_PREFIX,
  SCAM_REVIEW_TRUE_PREFIX,
  SCAM_REVIEW_FALSE_PREFIX,
  SCAM_FEEDBACK_PREFIX,
  SCAM_FEEDBACK_CATEGORIES,
  buildNicknameModerationButtonRows,
  buildModerationLogButtonRows,
  buildOutageReviewButtonRows,
  buildScamReviewButtonRows,
  buildScamFeedbackSelectRows,
  buildPaginationButtonRows,
  buildLinkButtonRows
};
