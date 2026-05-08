const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const MODLOG_VIEW_PREFIX = "modlog:messages:";
const MODLOG_REVERT_PREFIX = "modlog:revert:";
const NICKMOD_RENAME_PREFIX = "nickmod:rename:";
const NICKMOD_MODAL_PREFIX = "nickmod:rename-submit:";
const NICKMOD_NICKNAME_INPUT_ID = "nickmod:nickname";
const OUTAGE_CONFIRM_PREFIX = "outage:confirm:";
const OUTAGE_DISMISS_PREFIX = "outage:dismiss:";
const SCAM_REVIEW_TRUE_PREFIX = "scam_review_true:";
const SCAM_REVIEW_FALSE_PREFIX = "scam_review_false:";

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
  buildNicknameModerationButtonRows,
  buildModerationLogButtonRows,
  buildOutageReviewButtonRows,
  buildScamReviewButtonRows,
  buildLinkButtonRows
};
