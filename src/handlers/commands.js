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
  listModerationWhitelistedUsers,
  addModerationWhitelistedUser,
  removeModerationWhitelistedUser,
  listNicknamePatterns,
  addNicknamePattern,
  removeNicknamePatternById,
  getRestrictedEmojiDatabaseSnapshot,
  listScamDecisionAudit,
  getBotPresenceState,
  setBotPresenceState,
  resetBotPresenceState
} = require("../restricted-emoji-db");
const { normalizeUrlCandidate } = require("../link-policy");
const { sendLogPanel } = require("../log-channel");
const {
  MAX_PRESENCE_STATE_LENGTH,
  applyConfiguredPresenceState,
  validatePresenceState
} = require("../presence-state");
const { safeReply } = require("../utils/respond");

function isCommandsListMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  return normalized === "$cmd" || normalized === "$commands";
}

function isDatabaseMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  return normalized === "$db" || normalized === "$database";
}

function parseScamAuditMessage(content) {
  const trimmed = String(content || "").trim();
  const match = trimmed.match(/^\$(?:scamaudit|audit)(?:\s+(\d{1,2}))?$/i);
  if (!match) return null;
  const limit = Math.min(25, Math.max(1, Math.round(Number(match[1]) || 10)));
  return { limit };
}

function parseStateMessage(content) {
  const match = String(content || "").match(/^\$state(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const value = String(match[1] || "");
  const trimmed = value.trim();
  if (!trimmed) {
    return {
      action: "show",
      value: ""
    };
  }

  if (/^(?:reset|default)$/i.test(trimmed)) {
    return {
      action: "reset",
      value: ""
    };
  }

  return {
    action: "set",
    value
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

function parseNickMessage(content) {
  const trimmed = String(content || "").trim();
  if (!/^\$nick(?:\s|$)/i.test(trimmed)) return null;
  if (/^\$nick$/i.test(trimmed)) {
    return {
      action: "list"
    };
  }

  const removeMatch = trimmed.match(/^\$nick\s+(?:remove|delete|del)\s+(\d+)$/i);
  if (removeMatch) {
    return {
      action: "remove",
      id: Number(removeMatch[1])
    };
  }

  const addMatch = trimmed.match(/^\$nick\s+add\s+\/((?:\\\/|[^/])+)\/([a-z]*)\s*->\s*(.+)$/i);
  if (addMatch) {
    return {
      action: "add",
      pattern: addMatch[1].replace(/\\\//g, "/"),
      flags: addMatch[2] || "i",
      renameTo: addMatch[3].trim()
    };
  }

  return {
    action: "help"
  };
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

function parseUserIdInput(input) {
  const trimmed = String(input || "").trim();
  const mentionMatch = trimmed.match(/^<@!?(\d{16,22})>$/);
  if (mentionMatch) return mentionMatch[1];
  if (/^\d{16,22}$/.test(trimmed)) return trimmed;
  return null;
}

function parseWhitelistMessage(content) {
  const trimmed = String(content || "").trim();
  if (!/^\$(?:whitelist|unwhitelist)(?:\s|$)/i.test(trimmed)) return null;

  const unwhitelistMatch = trimmed.match(/^\$unwhitelist\s+(.+)$/i);
  if (unwhitelistMatch) {
    return {
      action: "remove",
      value: unwhitelistMatch[1].trim()
    };
  }

  if (/^\$whitelist$/i.test(trimmed) || /^\$whitelist\s+list$/i.test(trimmed)) {
    return {
      action: "list",
      value: ""
    };
  }

  const removeMatch = trimmed.match(/^\$whitelist\s+(?:remove|delete|del)\s+(.+)$/i);
  if (removeMatch) {
    return {
      action: "remove",
      value: removeMatch[1].trim()
    };
  }

  const addMatch = trimmed.match(/^\$whitelist\s+(.+)$/i);
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

function formatNicknamePatternList(patterns) {
  if (!Array.isArray(patterns) || !patterns.length) return "none yet";
  return patterns
    .slice(0, 25)
    .map((entry) => `- #${entry.id} ${entry.display}`)
    .join("\n");
}

function formatTrustedLinkList(links) {
  if (!Array.isArray(links) || !links.length) return "none yet";
  return links.map((link) => `- ${link.url}`).join("\n");
}

function formatWhitelistList(users) {
  if (!Array.isArray(users) || !users.length) return "none yet";
  return users
    .slice(0, 25)
    .map((entry) => {
      const createdBy = entry.createdBy ? ` by <@${entry.createdBy}>` : "";
      return `- <@${entry.userId}> (${entry.userId})${createdBy}`;
    })
    .join("\n");
}

function trimCommandExcerpt(text, max = 120) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "(no text)";
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 3))}...`;
}

function formatAuditVerdict(label, result) {
  if (!result?.model && !result?.answer && typeof result?.verdict === "undefined") return null;
  const answer = result.answer || (result.verdict === true ? "TRUE" : result.verdict === false ? "FALSE" : "BORDERLINE");
  const model = result.model ? ` ${result.model}` : "";
  const suffix = result.skipped ? ` (${result.skipped})` : "";
  return `${label}${model}: ${answer}${suffix}`;
}

function formatScamAuditList(records) {
  if (!Array.isArray(records) || !records.length) return "none yet";
  return records
    .slice(0, 25)
    .map((entry) => {
      const when = entry.createdAt ? `<t:${Math.floor(entry.createdAt / 1000)}:R>` : "unknown time";
      const user = entry.userId ? `<@${entry.userId}>` : "unknown user";
      const channel = entry.channelId ? ` <#${entry.channelId}>` : "";
      const local = formatAuditVerdict("local", entry.local);
      const ai = formatAuditVerdict("ai", entry.ai);
      const verdicts = [local, ai].filter(Boolean).join(" | ") || "no classifier verdict";
      const result = entry.handled ? "acted" : "cleared";
      return [
        `- ${when} **${result}** \`${entry.action}\` ${user}${channel}`,
        `  ${verdicts}`,
        `  ${trimCommandExcerpt(entry.messageContent)}`
      ].join("\n");
    })
    .join("\n");
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
    "`$state` show the bot presence text",
    "`$state <message>` set the bot presence text",
    "`$state reset` restore the default bot presence text",
    "`$fetch` refresh the KB cache",
    "`$jarvis` run runtime, KB, link, scam AI, whitelist, lockdown, and security diagnostics",
    "`$testpromax` run the extended diagnostics sweep",
    "`$role all <roleid>` assign a safe role to every human member missing it",
    "`$role <@user|userid> <roleid>` assign a role to one member",
    "`$db` / `$database` inspect the SQLite moderation database",
    "`$scamaudit` inspect recent scam/trade classifier decisions",
    "`$whitelist` list manual moderation whitelist users",
    "`$whitelist <user>` exempt a user from message moderation tracking",
    "`$whitelist remove <user>` remove a manual moderation whitelist user",
    "`$lock` lock the configured chat channels",
    "`$unlock` unlock the configured chat channels",
    "",
    "## Staff + Higher",
    "`$allowlink` list trusted links",
    "`$allowlink <url>` add a trusted link",
    "`$removelink <url>` remove a trusted link",
    "`$emoji` list restricted emojis",
    "`$emoji <emoji>` add a restricted emoji",
    "`$emoji remove <emoji>` remove a restricted emoji",
    "`$nick` list nickname patterns",
    "`$nick add /^!.*/i -> wawa` rename members matching pattern",
    "`$nick remove <id>` remove a nickname pattern by id"
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
      `**Manual Whitelist Rows:** ${snapshot.tableCounts.moderationWhitelist || 0}`,
      `**Daily User Rows:** ${snapshot.tableCounts.dailyUsers}`,
      `**Daily Channel Rows:** ${snapshot.tableCounts.dailyChannels}`,
      `**Daily Staff Rows:** ${snapshot.tableCounts.dailyStaff}`,
      `**Daily Moderation Rows:** ${snapshot.tableCounts.dailyModeration || 0}`,
      `**Scam Audit Rows:** ${snapshot.tableCounts.scamDecisionAudit || 0}`,
      `**Open Action Reviews:** ${snapshot.tableCounts.moderationActions || 0}`,
      "**Restricted Reaction Action:** remove reaction + DM warning",
      `**Window Start:** ${snapshot.dailyStats.windowStartedAt ? `<t:${Math.floor(snapshot.dailyStats.windowStartedAt / 1000)}:f>` : "unset"}`,
      `**Restricted Emojis:** ${formatEmojiList(snapshot.emojis)}`,
      `**Manual Whitelist:** ${snapshot.moderationWhitelist?.length || 0}`
    ].join("\n"),
    color: INFO
  });
  return true;
}

async function handleScamAuditCommand(message, command, {
  listAudit = listScamDecisionAudit
} = {}) {
  const records = await listAudit({ limit: command.limit });
  await replyWithCommandPanel(message, {
    header: "Scam Audit",
    body: [
      `**Showing:** ${records.length}/${command.limit}`,
      formatScamAuditList(records)
    ].join("\n\n"),
    color: INFO
  });
  return true;
}

function getCommandActorLabel(message) {
  return message.member?.displayName || message.author?.tag || message.author?.username || message.author?.id || "unknown";
}

function buildStateAuditPanel({ message, state, action, applied }) {
  return {
    header: action === "reset" ? "Bot State Reset" : "Bot State Updated",
    body: [
      `**Actor:** ${message.author?.id ? `<@${message.author.id}>` : getCommandActorLabel(message)}`,
      `**Action:** ${action}`,
      `**Presence:** ${state}`,
      `**Applied Now:** ${applied ? "yes" : "pending"}`
    ].join("\n"),
    color: SUCCESS
  };
}

async function handleStateCommand(message, command, {
  getPresenceState = getBotPresenceState,
  setPresenceState = setBotPresenceState,
  resetPresenceState = resetBotPresenceState,
  applyPresenceState = applyConfiguredPresenceState,
  sendLog = sendLogPanel
} = {}) {
  if (command.action === "show") {
    const state = await getPresenceState();
    await replyWithCommandPanel(message, {
      header: "Bot State",
      body: [
        `**Current:** ${state}`,
        `**Max Length:** ${MAX_PRESENCE_STATE_LENGTH}`,
        "**Usage:** `$state <message>` or `$state reset`"
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  const nextState = command.action === "reset" ? await resetPresenceState() : null;
  const validation = command.action === "set" ? validatePresenceState(command.value) : { ok: true, state: nextState };
  if (!validation.ok) {
    await replyWithCommandPanel(message, {
      header: "Bot State Rejected",
      body: [
        validation.error,
        `**Max Length:** ${MAX_PRESENCE_STATE_LENGTH}`,
        "**Usage:** `$state <message>` or `$state reset`"
      ].join("\n"),
      color: DANGER
    });
    return true;
  }

  const state = command.action === "set" ? await setPresenceState(validation.state) : nextState;
  const applied = await applyPresenceState(message.client?.user, state);

  await replyWithCommandPanel(message, {
    header: command.action === "reset" ? "Bot State Reset" : "Bot State Updated",
    body: [
      `**Presence:** ${state}`,
      `**Applied Now:** ${applied ? "yes" : "pending until the bot is ready"}`
    ].join("\n"),
    color: SUCCESS
  });

  if (message.guild) {
    await sendLog(message.guild, buildStateAuditPanel({
      message,
      state,
      action: command.action,
      applied
    })).catch(() => null);
  }

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

function validateNicknamePatternCommand(command) {
  const pattern = String(command.pattern || "").trim();
  const flags = String(command.flags || "i").trim() || "i";
  const renameTo = String(command.renameTo || "").replace(/\s+/g, " ").trim();
  if (!pattern || pattern.length > 120) {
    return { ok: false, error: "nickname regex must be 1-120 chars" };
  }
  if (!/^[imu]*$/.test(flags) || new Set(flags).size !== flags.length) {
    return { ok: false, error: "nickname regex flags can only use unique `i`, `m`, and `u`" };
  }
  if (!renameTo || renameTo.length > 32) {
    return { ok: false, error: "rename target must be 1-32 chars" };
  }
  if (/[^\x20-\x7E]/.test(renameTo)) {
    return { ok: false, error: "rename target must use plain visible ASCII for now" };
  }
  if (/\([^)]*[+*][^)]*\)[+*?{]/.test(pattern)) {
    return { ok: false, error: "nested quantified groups are blocked for nickname regex safety" };
  }
  try {
    new RegExp(pattern, flags);
  } catch (err) {
    return { ok: false, error: `invalid regex: ${err?.message || err}` };
  }
  return { ok: true, pattern, flags, renameTo };
}

async function handleNickCommand(message, command, {
  listPatterns = listNicknamePatterns,
  addPattern = addNicknamePattern,
  removePattern = removeNicknamePatternById
} = {}) {
  if (command.action === "list") {
    const patterns = await listPatterns();
    await replyWithCommandPanel(message, {
      header: "Nickname Moderation",
      body: [
        `**Count:** ${patterns.length}`,
        formatNicknamePatternList(patterns)
      ].join("\n\n"),
      color: INFO
    });
    return true;
  }

  if (command.action === "remove") {
    const result = await removePattern(command.id);
    const patterns = await listPatterns();
    await replyWithCommandPanel(message, {
      header: "Nickname Moderation",
      body: [
        result.removed ? `removed rule #${command.id}` : `no nickname rule found for #${command.id}`,
        `**Count:** ${patterns.length}`
      ].join("\n"),
      color: result.removed ? SUCCESS : WARN
    });
    return true;
  }

  if (command.action === "add") {
    const validation = validateNicknamePatternCommand(command);
    if (!validation.ok) {
      await replyWithCommandPanel(message, {
        header: "Nickname Pattern Rejected",
        body: [
          validation.error,
          "**Usage:** `$nick add /^!.*/i -> wawa`"
        ].join("\n"),
        color: DANGER
      });
      return true;
    }

    const result = await addPattern(validation);
    const patterns = await listPatterns();
    await replyWithCommandPanel(message, {
      header: "Nickname Moderation",
      body: [
        result.added ? `added ${result.pattern.display}` : `that rule already exists: ${result.pattern.display}`,
        `**Count:** ${patterns.length}`
      ].join("\n"),
      color: result.added ? SUCCESS : WARN
    });
    return true;
  }

  await replyWithCommandPanel(message, {
    header: "Nickname Moderation",
    body: [
      "**Usage:**",
      "`$nick`",
      "`$nick add /^!.*/i -> wawa`",
      "`$nick remove <id>`"
    ].join("\n"),
    color: INFO
  });
  return true;
}

async function handleWhitelistCommand(message, command, {
  listWhitelist = listModerationWhitelistedUsers,
  addWhitelistUser = addModerationWhitelistedUser,
  removeWhitelistUser = removeModerationWhitelistedUser
} = {}) {
  if (command.action === "list") {
    const users = await listWhitelist();
    await replyWithCommandPanel(message, {
      header: "Moderation Whitelist",
      body: [
        "Manual whitelist users are skipped by message moderation guards.",
        "Channel lockdown permissions are unchanged.",
        `**Count:** ${users.length}`,
        formatWhitelistList(users)
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  const userId = parseUserIdInput(command.value);
  if (!userId) {
    await replyWithCommandPanel(message, {
      header: "Moderation Whitelist",
      body: "send a user ping or raw user id\nusage: `$whitelist @user`, `$whitelist 123456789012345678`, or `$whitelist remove @user`",
      color: DANGER
    });
    return true;
  }

  if (command.action === "remove") {
    const result = await removeWhitelistUser(userId);
    const users = await listWhitelist();
    await replyWithCommandPanel(message, {
      header: "Moderation Whitelist",
      body: [
        result.removed
          ? `removed <@${userId}> from the manual moderation whitelist`
          : `<@${userId}> was not on the manual moderation whitelist`,
        "Channel lockdown permissions are unchanged.",
        `**Count:** ${users.length}`
      ].join("\n"),
      color: result.removed ? SUCCESS : WARN
    });
    return true;
  }

  const result = await addWhitelistUser(userId, {
    createdBy: message.author?.id || null
  });
  const users = await listWhitelist();
  await replyWithCommandPanel(message, {
    header: "Moderation Whitelist",
    body: [
      result.added
        ? `added <@${userId}> to the manual moderation whitelist`
        : `<@${userId}> is already on the manual moderation whitelist`,
      "They will be skipped for links, suspicious-message checks, scam/trade checks, fake-info checks, and raid tracking.",
      "Channel lockdown permissions are unchanged.",
      `**Count:** ${users.length}`
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
  const stateCommand = parseStateMessage(message.content);
  if (stateCommand) {
    if (!canUseOwnerCommands(message)) return true;
    return handleStateCommand(message, stateCommand, deps);
  }

  const whitelistCommand = parseWhitelistMessage(message.content);
  if (whitelistCommand) {
    if (!canUseOwnerCommands(message)) return true;
    return handleWhitelistCommand(message, whitelistCommand, deps);
  }

  const scamAuditCommand = parseScamAuditMessage(message.content);
  if (scamAuditCommand) {
    if (!canUseOwnerCommands(message)) return true;
    return handleScamAuditCommand(message, scamAuditCommand, deps);
  }

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

  const nickCommand = parseNickMessage(message.content);
  if (nickCommand) {
    if (!canUseEmojiCommands(message)) return true;
    return handleNickCommand(message, nickCommand, deps);
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
  parseScamAuditMessage,
  parseStateMessage,
  parseEmojiMessage,
  parseNickMessage,
  parseTrustedLinkMessage,
  parseWhitelistMessage,
  parseUserIdInput,
  handleStateCommand,
  handleNickCommand,
  maybeHandleControlCommand
};
