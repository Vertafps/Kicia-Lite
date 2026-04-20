const { OWNER_USER_ID } = require("../config");
const { buildPanel, SUCCESS, WARN } = require("../embed");
const { setRuntimeStatus } = require("../runtime-status");

function parseStatusCommand(content) {
  const normalized = String(content || "").trim().toLowerCase();
  if (normalized === "$status up") return "UP";
  if (normalized === "$status down") return "DOWN";
  return null;
}

function isStatusCommandMessage(content) {
  return String(content || "").trim().toLowerCase().startsWith("$status");
}

async function maybeHandleStatusCommand(message) {
  if (!isStatusCommandMessage(message.content)) return false;
  if (message.author?.id !== OWNER_USER_ID) return true;

  const nextStatus = parseStatusCommand(message.content);
  if (!nextStatus) return true;

  setRuntimeStatus(nextStatus);
  await message.reply({
    embeds: [
      buildPanel({
        body:
          nextStatus === "DOWN"
            ? "set kiciahook status to down"
            : "set kiciahook status to up",
        color: nextStatus === "DOWN" ? WARN : SUCCESS
      })
    ],
    allowedMentions: { repliedUser: false }
  });
  return true;
}

module.exports = {
  parseStatusCommand,
  isStatusCommandMessage,
  maybeHandleStatusCommand
};
