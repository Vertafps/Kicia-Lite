const path = require("path");
const { buildPanel, DANGER, INFO, SUCCESS, WARN } = require("../embed");
const {
  canUseEmojiCommands,
  canUseOwnerCommands,
  canUseTrustedLinkCommands
} = require("../permissions");
const {
  parseEmojiInput,
  listRestrictedEmojis,
  addRestrictedEmoji,
  removeRestrictedEmojiByKey,
  listTrustedLinks,
  addTrustedLink,
  removeTrustedLinkByKey,
  getRestrictedEmojiDatabaseSnapshot
} = require("../restricted-emoji-db");
const { normalizeUrlCandidate } = require("../link-policy");
const { safeReply } = require("../utils/respond");

function isCommandsListMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  return normalized === "$cmd" || normalized === "$commands";
}

function isDatabaseMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  return normalized === "$db" || normalized === "$database";
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

function parseTrustedLinkMessage(content) {
  const trimmed = String(content || "").trim();
  if (/^\$allowlink$/i.test(trimmed)) {
    return {
      action: "list",
      value: ""
    };
  }

  const addMatch = trimmed.match(/^\$allowlink\s+(.+)$/i);
  if (addMatch) {
    return {
      action: "add",
      value: addMatch[1].trim()
    };
  }

  const removeMatch = trimmed.match(/^\$removelink\s+(.+)$/i);
  if (removeMatch) {
    return {
      action: "remove",
      value: removeMatch[1].trim()
    };
  }

  return null;
}

function formatEmojiList(emojis) {
  if (!Array.isArray(emojis) || !emojis.length) return "none yet";
  return emojis.map((emoji) => emoji.display).join(" ");
}

function formatTrustedLinkList(links) {
  if (!Array.isArray(links) || !links.length) return "none yet";
  return links.map((link) => `- ${link.url}`).join("\n");
}

function buildCommandsBody() {
  return [
    "## Everyone",
    "`$status` show the current KiciaHook status",
    "Ping me after describing an issue and I will match the docs",
    "",
    "## Owners",
    "`$cmd` show this command list",
    "`$status up` mark status as up",
    "`$status down` mark status as down",
    "`$fetch` refresh the KB cache",
    "`$jarvis` run runtime, log, false-info, suspicious-alert, and security diagnostics",
    "`$db` / `$database` inspect the SQLite moderation database",
    "`$lock` lock the configured chat channels",
    "`$unlock` unlock the configured chat channels",
    "",
    "## Staff + Higher",
    "`$allowlink` list trusted links",
    "`$allowlink <url>` add a trusted link",
    "`$removelink <url>` remove a trusted link",
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
    header: "Bot Commands",
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
      `**Trusted Link Rows:** ${snapshot.tableCounts.trustedLinks || 0}`,
      `**Daily User Rows:** ${snapshot.tableCounts.dailyUsers}`,
      `**Daily Channel Rows:** ${snapshot.tableCounts.dailyChannels}`,
      `**Daily Staff Rows:** ${snapshot.tableCounts.dailyStaff}`,
      `**Daily Moderation Rows:** ${snapshot.tableCounts.dailyModeration || 0}`,
      "**Restricted Reaction Action:** remove reaction + DM warning",
      `**Window Start:** ${snapshot.dailyStats.windowStartedAt ? `<t:${Math.floor(snapshot.dailyStats.windowStartedAt / 1000)}:f>` : "unset"}`,
      `**Restricted Emojis:** ${formatEmojiList(snapshot.emojis)}`
    ].join("\n"),
    color: INFO
  });
  return true;
}

async function handleEmojiCommand(message, command, {
  listEmojis = listRestrictedEmojis,
  addEmoji = addRestrictedEmoji,
  removeEmoji = removeRestrictedEmojiByKey
} = {}) {
  if (command.action === "list") {
    const emojis = await listEmojis();
    await replyWithCommandPanel(message, {
      header: "Restricted Emojis",
      body: [
        "**Action:** remove reaction + DM warning",
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

async function handleTrustedLinkCommand(message, command, {
  listLinks = listTrustedLinks,
  addLink = addTrustedLink,
  removeLink = removeTrustedLinkByKey
} = {}) {
  if (command.action === "list") {
    const links = await listLinks();
    await replyWithCommandPanel(message, {
      header: "Trusted Links",
      body: [
        `**Count:** ${links.length}`,
        formatTrustedLinkList(links)
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  const parsedUrl = normalizeUrlCandidate(command.value);
  if (!parsedUrl) {
    await replyWithCommandPanel(message, {
      header: "Trusted Links",
      body: "send a valid http/https link\nusage: `$allowlink https://example.com/` or `$removelink https://example.com/`",
      color: DANGER
    });
    return true;
  }

  if (command.action === "remove") {
    const result = await removeLink(parsedUrl.key);
    const links = await listLinks();
    await replyWithCommandPanel(message, {
      header: "Trusted Links",
      body: [
        result.removed
          ? `removed trusted link **${result.link.url}**`
          : `that link was not in the trusted list: **${parsedUrl.raw}**`,
        `**Count:** ${links.length}`,
        formatTrustedLinkList(links)
      ].join("\n"),
      color: result.removed ? SUCCESS : WARN
    });
    return true;
  }

  const result = await addLink({
    key: parsedUrl.key,
    url: parsedUrl.url
  });
  const links = await listLinks();
  await replyWithCommandPanel(message, {
    header: "Trusted Links",
    body: [
      result.added
        ? `added trusted link **${parsedUrl.url}**`
        : `that link is already trusted: **${result.link.url}**`,
      `**Count:** ${links.length}`,
      formatTrustedLinkList(links)
    ].join("\n"),
    color: result.added ? SUCCESS : WARN
  });
  return true;
}

async function maybeHandleControlCommand(message, deps = {}) {
  const trustedLinkCommand = parseTrustedLinkMessage(message.content);
  if (trustedLinkCommand) {
    if (!canUseTrustedLinkCommands(message)) return true;
    return handleTrustedLinkCommand(message, trustedLinkCommand, deps);
  }

  const emojiCommand = parseEmojiMessage(message.content);
  if (emojiCommand) {
    if (!canUseEmojiCommands(message)) return true;
    return handleEmojiCommand(message, emojiCommand, deps);
  }

  if (isCommandsListMessage(message.content)) {
    if (!canUseOwnerCommands(message)) return true;
    return handleCommandsList(message);
  }

  if (isDatabaseMessage(message.content)) {
    if (!canUseOwnerCommands(message)) return true;
    return handleDatabaseCommand(message, deps);
  }

  return false;
}

module.exports = {
  isCommandsListMessage,
  isDatabaseMessage,
  parseEmojiMessage,
  parseTrustedLinkMessage,
  maybeHandleControlCommand
};
