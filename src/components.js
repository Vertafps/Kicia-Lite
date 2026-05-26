const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const MODLOG_VIEW_PREFIX = "modlog:messages:";
const MODLOG_REVERT_PREFIX = "modlog:revert:";
const NICKMOD_RENAME_PREFIX = "nickmod:rename:";
const NICKMOD_MODAL_PREFIX = "nickmod:rename-submit:";
const NICKMOD_NICKNAME_INPUT_ID = "nickmod:nickname";
const OUTAGE_CONFIRM_PREFIX = "outage:confirm:";
const OUTAGE_DISMISS_PREFIX = "outage:dismiss:";
const TRAIN_LABEL_NEG_PREFIX = "train:neg:";
const TRAIN_SCAM_LIGHT_PREFIX = "train:scam:light:";
const TRAIN_SCAM_MEDIUM_PREFIX = "train:scam:medium:";
const TRAIN_SCAM_SEVERE_PREFIX = "train:scam:severe:";
const TRAIN_RESPECT_LIGHT_PREFIX = "train:respect:light:";
const TRAIN_RESPECT_MEDIUM_PREFIX = "train:respect:medium:";
const TRAIN_RESPECT_SEVERE_PREFIX = "train:respect:severe:";
const TRAIN_RESPECT_WARN_PREFIX = "train:respect:warn:";
const TRAIN_NOTE_PREFIX = "train:note:";
const TRAIN_NOTE_MODAL_PREFIX = "train:note-submit:";
const TRAIN_NOTE_INPUT_ID = "train:note:input";
const TRAIN_UNDO_PREFIX = "train:undo:";
const TRAIN_LIFT_PREFIX = "train:lift:";

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
        .setEmoji("↩️")
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

function buildTrainingFeedbackButtonRows(sampleId, classifier = "scam", sample = {}) {
  const id = String(sampleId || "").trim();
  if (!id) return [];
  const disabled = Boolean(sample.label);

  const rows = [];

  // "action" = auto-timeout, "warn" = auto-warn (delete + DM, no mute).
  // Both already applied moderation, so both surface the lift/re-tier flow.
  if (sample.decision === "action" || sample.decision === "warn") {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${TRAIN_LIFT_PREFIX}${id}`)
        .setStyle(ButtonStyle.Danger).setLabel("Wrongful (Lift)").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_SCAM_LIGHT_PREFIX}${id}`)
        .setStyle(ButtonStyle.Secondary).setLabel("Re-tier Light").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_SCAM_MEDIUM_PREFIX}${id}`)
        .setStyle(ButtonStyle.Primary).setLabel("Re-tier Medium").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_SCAM_SEVERE_PREFIX}${id}`)
        .setStyle(ButtonStyle.Danger).setLabel("Re-tier Severe").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_NOTE_PREFIX}${id}`)
        .setStyle(ButtonStyle.Secondary).setLabel("Note").setDisabled(disabled)
    );
    rows.push(row1);
    return rows;
  }

  if (classifier === "respect") {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${TRAIN_LABEL_NEG_PREFIX}${id}`)
        .setStyle(ButtonStyle.Secondary).setLabel("Not Disrespect").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_RESPECT_WARN_PREFIX}${id}`)
        .setStyle(ButtonStyle.Success).setLabel("Warn DM").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_RESPECT_LIGHT_PREFIX}${id}`)
        .setStyle(ButtonStyle.Primary).setLabel("Light (15m)").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_RESPECT_SEVERE_PREFIX}${id}`)
        .setStyle(ButtonStyle.Danger).setLabel("Severe (24h)").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_NOTE_PREFIX}${id}`)
        .setStyle(ButtonStyle.Secondary).setLabel("Note").setDisabled(disabled)
    ));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${TRAIN_LABEL_NEG_PREFIX}${id}`)
        .setStyle(ButtonStyle.Secondary).setLabel("Not Scam").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_SCAM_LIGHT_PREFIX}${id}`)
        .setStyle(ButtonStyle.Success).setLabel("Light (1h)").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_SCAM_MEDIUM_PREFIX}${id}`)
        .setStyle(ButtonStyle.Primary).setLabel("Medium (12h)").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_SCAM_SEVERE_PREFIX}${id}`)
        .setStyle(ButtonStyle.Danger).setLabel("Severe (24h)").setDisabled(disabled),
      new ButtonBuilder().setCustomId(`${TRAIN_NOTE_PREFIX}${id}`)
        .setStyle(ButtonStyle.Secondary).setLabel("Note").setDisabled(disabled)
    ));
  }
  return rows;
}

function buildTrainingNoteModal(sampleId) {
  const { ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
  const modal = new ModalBuilder()
    .setCustomId(`${TRAIN_NOTE_MODAL_PREFIX}${sampleId}`)
    .setTitle("Training note");
  const input = new TextInputBuilder()
    .setCustomId(TRAIN_NOTE_INPUT_ID)
    .setLabel("Note for this sample (optional)")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(400)
    .setRequired(false);
  modal.addComponents(
    new (require("discord.js").ActionRowBuilder)().addComponents(input)
  );
  return modal;
}

module.exports = {
  MODLOG_REVERT_PREFIX,
  MODLOG_VIEW_PREFIX,
  NICKMOD_MODAL_PREFIX,
  NICKMOD_NICKNAME_INPUT_ID,
  NICKMOD_RENAME_PREFIX,
  OUTAGE_CONFIRM_PREFIX,
  OUTAGE_DISMISS_PREFIX,
  TRAIN_LABEL_NEG_PREFIX,
  TRAIN_LIFT_PREFIX,
  TRAIN_NOTE_INPUT_ID,
  TRAIN_NOTE_MODAL_PREFIX,
  TRAIN_NOTE_PREFIX,
  TRAIN_RESPECT_LIGHT_PREFIX,
  TRAIN_RESPECT_MEDIUM_PREFIX,
  TRAIN_RESPECT_SEVERE_PREFIX,
  TRAIN_RESPECT_WARN_PREFIX,
  TRAIN_SCAM_LIGHT_PREFIX,
  TRAIN_SCAM_MEDIUM_PREFIX,
  TRAIN_SCAM_SEVERE_PREFIX,
  TRAIN_UNDO_PREFIX,
  buildNicknameModerationButtonRows,
  buildModerationLogButtonRows,
  buildOutageReviewButtonRows,
  buildPaginationButtonRows,
  buildLinkButtonRows,
  buildTrainingFeedbackButtonRows,
  buildTrainingNoteModal
};
