const path = require("path");
const { buildPanel, DANGER, INFO, SUCCESS, WARN } = require("../embed");
const { formatDuration, parseDurationInput } = require("../duration");
const { isKernelMessage, canUseEmojiCommands } = require("../permissions");
const {
  parseEmojiInput,
  getEmojiTimeoutMs,
  setEmojiTimeoutMs,
  listRestrictedEmojis,
  addRestrictedEmoji,
  removeRestrictedEmojiByKey,
  getRestrictedEmojiDatabaseSnapshot
} = require("../restricted-emoji-db");
const { safeReply } = require("../utils/respond");

function isCommandsListMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  return normalized === "$cmd" || normalized === "$commands";
}

function isDatabaseMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  return normalized === "$db" || normalized === "$database";
}

function parseConfigMessage(content) {
  const trimmed = String(content || "").trim();
  const match = trimmed.match(/^\$config(?:\s+emoji(?:\s+(.+))?)?$/i);
  if (!match) return null;

  return {
    scope: "emoji",
    value: match[1] ? match[1].trim() : ""
  };
}

function parseEmojiMessage(content) {
  const trimmed = String(content || "").trim();
  if (!/^\$emoji(?:\s|$)/i.test(trimmed)) return null;

  const removeMatch = trimmed.match(/^\$emoji\s+remove\s+(.+)$/i);
  if (removeMatch) {
    return {
      action: "remove",
      value: removeMatch[1].trim()
    };
  }

  if (/^\$emoji$/i.test(trimmed)) {
    return {
      action: "list",
      value: ""
    };
  }

  const addMatch = trimmed.match(/^\$emoji\s+(.+)$/i);
  return addMatch
    ? {
        action: "add",
        value: addMatch[1].trim()
      }
    : null;
}

function formatEmojiList(emojis) {
  if (!Array.isArray(emojis) || !emojis.length) return "none yet";
  return emojis.map((emoji) => emoji.display).join(" ");
}

function buildCommandsBody() {
  return [
    "## Kernel Only",
    "`$cmd` show this command list",
    "`$status` show the current public status reply",
    "`$status up` mark status as up",
    "`$status down` mark status as down",
    "`$fetch` refresh the KB cache",
    "`$jarvis` run runtime, log, and security diagnostics",
    "`$config emoji <time>` set the reaction-timeout length",
    "`$db` / `$database` inspect the SQLite moderation database",
    "",
    "## Kernel + Owner Role",
    "`$lock` lock the configured chat channels",
    "`$unlock` unlock the configured chat channels",
    "",
    "## Kernel + Staff / Mod / Admin / Owner",
    "`$emoji` list restricted emojis",
    "`$emoji <emoji>` add a restricted emoji",
    "`$emoji remove <emoji>` remove a restricted emoji"
  ].join("\n");
}

async function replyWithCommandPanel(message, panel) {
  await safeReply(message, {
    embeds: [buildPanel(panel)],
    allowedMentions: { repliedUser: false }
  });
}

async function handleCommandsList(message) {
  await replyWithCommandPanel(message, {
    header: "Kernel Commands",
    body: buildCommandsBody(),
    color: INFO
  });
  return true;
}

async function handleDatabaseCommand(message, {
  getSnapshot = getRestrictedEmojiDatabaseSnapshot
} = {}) {
  const snapshot = await getSnapshot();
  const relativePath = path.relative(process.cwd(), snapshot.path) || snapshot.path;

  await replyWithCommandPanel(message, {
    header: "SQLite Database",
    body: [
      `**Path:** \`${relativePath}\``,
      `**Config Rows:** ${snapshot.tableCounts.appConfig}`,
      `**Restricted Emoji Rows:** ${snapshot.tableCounts.restrictedEmojis}`,
      `**Timeout:** ${formatDuration(snapshot.emojiTimeoutMs)}`,
      `**Restricted Emojis:** ${formatEmojiList(snapshot.emojis)}`
    ].join("\n"),
    color: INFO
  });
  return true;
}

async function handleConfigCommand(message, command, {
  getTimeout = getEmojiTimeoutMs,
  setTimeout = setEmojiTimeoutMs
} = {}) {
  if (command.scope !== "emoji") {
    await replyWithCommandPanel(message, {
      body: "usage: `$config emoji <time>`",
      color: WARN
    });
    return true;
  }

  if (!command.value) {
    await replyWithCommandPanel(message, {
      header: "Emoji Timeout Config",
      body: `current timeout: **${formatDuration(await getTimeout())}**\nusage: \`$config emoji 10m\``,
      color: INFO
    });
    return true;
  }

  const durationMs = parseDurationInput(command.value);
  if (!durationMs) {
    await replyWithCommandPanel(message, {
      header: "Emoji Timeout Config",
      body: "invalid duration bro, try something like `10m`, `15m`, `1h`, or `600s`",
      color: DANGER
    });
    return true;
  }

  const savedDuration = await setTimeout(durationMs);
  await replyWithCommandPanel(message, {
    header: "Emoji Timeout Config",
    body: `emoji timeout is now **${formatDuration(savedDuration)}**`,
    color: SUCCESS
  });
  return true;
}

async function handleEmojiCommand(message, command, {
  getTimeout = getEmojiTimeoutMs,
  listEmojis = listRestrictedEmojis,
  addEmoji = addRestrictedEmoji,
  removeEmoji = removeRestrictedEmojiByKey
} = {}) {
  if (command.action === "list") {
    const emojis = await listEmojis();
    await replyWithCommandPanel(message, {
      header: "Restricted Emojis",
      body: [
        `**Timeout:** ${formatDuration(await getTimeout())}`,
        `**Count:** ${emojis.length}`,
        `**List:** ${formatEmojiList(emojis)}`
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  const parsedEmoji = parseEmojiInput(command.value);
  if (!parsedEmoji) {
    await replyWithCommandPanel(message, {
      header: "Restricted Emojis",
      body: "send a normal emoji or custom emoji like `<:name:id>`\nusage: `$emoji 😭` or `$emoji remove 😭`",
      color: DANGER
    });
    return true;
  }

  if (command.action === "remove") {
    const result = await removeEmoji(parsedEmoji.key);
    const emojis = await listEmojis();
    await replyWithCommandPanel(message, {
      header: "Restricted Emojis",
      body: [
        result.removed
          ? `removed **${parsedEmoji.display}** from the restricted batch`
          : `that emoji was not in the restricted batch: **${parsedEmoji.display}**`,
        `**Count:** ${emojis.length}`,
        `**List:** ${formatEmojiList(emojis)}`
      ].join("\n"),
      color: result.removed ? SUCCESS : WARN
    });
    return true;
  }

  const result = await addEmoji(parsedEmoji);
  const emojis = await listEmojis();
  await replyWithCommandPanel(message, {
    header: "Restricted Emojis",
    body: [
      result.added
        ? `added **${parsedEmoji.display}** to the restricted batch`
        : `that emoji is already restricted: **${parsedEmoji.display}**`,
      `**Count:** ${emojis.length}`,
      `**List:** ${formatEmojiList(emojis)}`
    ].join("\n"),
    color: result.added ? SUCCESS : WARN
  });
  return true;
}

async function maybeHandleControlCommand(message, deps = {}) {
  const emojiCommand = parseEmojiMessage(message.content);
  if (emojiCommand) {
    if (!canUseEmojiCommands(message)) return true;
    return handleEmojiCommand(message, emojiCommand, deps);
  }

  if (isCommandsListMessage(message.content)) {
    if (!isKernelMessage(message)) return true;
    return handleCommandsList(message);
  }

  if (isDatabaseMessage(message.content)) {
    if (!isKernelMessage(message)) return true;
    return handleDatabaseCommand(message, deps);
  }

  const configCommand = parseConfigMessage(message.content);
  if (configCommand) {
    if (!isKernelMessage(message)) return true;
    return handleConfigCommand(message, configCommand, deps);
  }

  return false;
}

module.exports = {
  isCommandsListMessage,
  isDatabaseMessage,
  parseConfigMessage,
  parseEmojiMessage,
  maybeHandleControlCommand
};
