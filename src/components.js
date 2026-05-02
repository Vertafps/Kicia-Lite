const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

const MODLOG_VIEW_PREFIX = "modlog:messages:";
const MODLOG_REVERT_PREFIX = "modlog:revert:";

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

module.exports = {
  MODLOG_REVERT_PREFIX,
  MODLOG_VIEW_PREFIX,
  buildModerationLogButtonRows,
  buildLinkButtonRows
};
