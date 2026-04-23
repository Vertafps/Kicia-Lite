const { OWNER_USER_ID } = require("../config");
const { buildPanel, DANGER, SUCCESS, WARN, INFO } = require("../embed");
const { forceRefreshKb } = require("../kb");
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

function isFetchCommandMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  // IMPROVEMENT: accept $refresh as an alias for $fetch
  return normalized === "$fetch" || normalized === "$refresh";
}

function isOwnerCommandMessage(content) {
  return isStatusCommandMessage(content) || isFetchCommandMessage(content);
}

async function maybeHandleStatusCommand(message, { refreshKb = forceRefreshKb } = {}) {
  if (!isOwnerCommandMessage(message.content)) return false;
  // Silently swallow owner commands from non-owners so the command isn't revealed
  if (message.author?.id !== OWNER_USER_ID) return true;

  if (isFetchCommandMessage(message.content)) {
    try {
      await refreshKb();
      await message.reply({
        embeds: [
          buildPanel({
            body: "fetched latest kb and refreshed cache",
            color: SUCCESS
          })
        ],
        allowedMentions: { repliedUser: false }
      });
    } catch {
      await message.reply({
        embeds: [
          buildPanel({
            body: "couldn't fetch latest kb rn",
            color: DANGER
          })
        ],
        allowedMentions: { repliedUser: false }
      });
    }
    return true;
  }

  const nextStatus = parseStatusCommand(message.content);

  // BUG FIX: previously returned true with no reply when owner sent $status
  // with an invalid/missing argument — silent failure. Now sends usage hint.
  if (!nextStatus) {
    await message.reply({
      embeds: [
        buildPanel({
          body: "usage: `$status up` or `$status down`",
          color: INFO
        })
      ],
      allowedMentions: { repliedUser: false }
    });
    return true;
  }

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
  isFetchCommandMessage,
  isStatusCommandMessage,
  isOwnerCommandMessage,
  maybeHandleStatusCommand
};
