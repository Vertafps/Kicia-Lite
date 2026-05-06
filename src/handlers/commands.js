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
  listContentFilterRules,
  addContentFilterRule,
  removeContentFilterRuleById,
  listNicknamePatterns,
  addNicknamePattern,
  removeNicknamePatternById,
  getRestrictedEmojiDatabaseSnapshot,
  listChannelSettings,
  setChannelSetting,
  resetChannelSetting,
  listScamDecisionAudit,
  labelScamDecisionAudit,
  normalizeScamAuditLabel,
  getBotPresenceState,
  setBotPresenceState,
  resetBotPresenceState
} = require("../restricted-emoji-db");
const {
  CHANNEL_CONFIG_SLOTS,
  getChannelSlotDefinition,
  normalizeChannelSlotKey,
  parseChannelIdInput
} = require("../channel-config");
const {
  KNOWN_BAD_WORD_CATEGORIES,
  detectContentFilterSignal,
  listDefaultContentFilterRules,
  validateBadWordRuleInput
} = require("../content-filter");
const { normalizeUrlCandidate } = require("../link-policy");
const { sendLogPanel } = require("../log-channel");
const {
  MAX_PRESENCE_STATE_LENGTH,
  applyConfiguredPresenceState,
  validatePresenceState
} = require("../presence-state");
const {
  DEFAULT_NICKNAME_RENAME_SENTINEL,
  formatNicknameRenameTarget
} = require("../nickname-policy");
const { buildNormalizedTextForms } = require("../text");
const { safeReply } = require("../utils/respond");

const DEFAULT_NICKNAME_RENAME = DEFAULT_NICKNAME_RENAME_SENTINEL;

function escapeRegexLiteral(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  const labelMatch = trimmed.match(/^\$(?:scamaudit|audit)\s+label\s+(\d+)\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (labelMatch) {
    return {
      action: "label",
      id: Number(labelMatch[1]),
      label: labelMatch[2],
      note: String(labelMatch[3] || "").trim()
    };
  }

  const match = trimmed.match(/^\$(?:scamaudit|audit)(?:\s+(\d{1,2}))?$/i);
  if (!match) return null;
  const limit = Math.min(25, Math.max(1, Math.round(Number(match[1]) || 10)));
  return { action: "list", limit };
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

function parseSetChannelMessage(content) {
  const trimmed = String(content || "").trim();
  if (/^\$set\s+channels?$/i.test(trimmed)) {
    return {
      action: "list"
    };
  }

  const match = trimmed.match(/^\$set\s+channels?\s+(\S+)(?:\s+([\s\S]+))?$/i);
  if (!match) return null;

  const rawSlot = match[1];
  const value = String(match[2] || "").trim();
  const slot = normalizeChannelSlotKey(rawSlot);
  if (!slot) {
    return {
      action: "invalid_slot",
      slot: rawSlot,
      value
    };
  }

  if (!value) {
    return {
      action: "help",
      slot,
      value: ""
    };
  }

  if (/^(?:reset|default)$/i.test(value)) {
    return {
      action: "reset",
      slot,
      value: ""
    };
  }

  return {
    action: "set",
    slot,
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

  const simpleAddMatch = trimmed.match(/^\$nick\s+add\s+(.+)$/i);
  if (simpleAddMatch) {
    const raw = simpleAddMatch[1].trim();
    const arrowIndex = raw.indexOf("->");
    const literal = (arrowIndex >= 0 ? raw.slice(0, arrowIndex) : raw).trim();
    const renameTo = (arrowIndex >= 0 ? raw.slice(arrowIndex + 2) : DEFAULT_NICKNAME_RENAME).trim();
    if (!literal) return { action: "help" };
    return {
      action: "add",
      pattern: escapeRegexLiteral(literal),
      flags: "i",
      renameTo: renameTo || DEFAULT_NICKNAME_RENAME,
      literal
    };
  }

  return {
    action: "help"
  };
}

function parseBadWordMessage(content) {
  const trimmed = String(content || "").trim();
  if (!/^\$badword(?:\s|$)/i.test(trimmed)) return null;
  if (/^\$badword$/i.test(trimmed)) {
    return {
      action: "list"
    };
  }

  const removeMatch = trimmed.match(/^\$badword\s+(?:remove|delete|del)\s+(\d+)$/i);
  if (removeMatch) {
    return {
      action: "remove",
      id: Number(removeMatch[1])
    };
  }

  const testMatch = trimmed.match(/^\$badword\s+test\s+([\s\S]+)$/i);
  if (testMatch) {
    return {
      action: "test",
      text: testMatch[1].trim()
    };
  }

  const addMatch = trimmed.match(/^\$badword\s+add\s+([\s\S]+)$/i);
  if (addMatch) {
    const raw = addMatch[1].trim();
    const tokens = raw.split(/\s+/);
    const maybeCategory = tokens.length > 1
      ? tokens[tokens.length - 1].toLowerCase().replace(/[\s-]+/g, "_")
      : "";
    const category = KNOWN_BAD_WORD_CATEGORIES.has(maybeCategory) ? maybeCategory : "custom";
    const term = category === "custom" ? raw : tokens.slice(0, -1).join(" ");
    return {
      action: "add",
      term,
      category
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

function formatBadWordRuleList(rules) {
  if (!Array.isArray(rules) || !rules.length) return "none yet";
  return rules
    .slice(0, 25)
    .map((entry) => `- #${entry.id} \`${entry.term}\` (${entry.category})`)
    .join("\n");
}

function formatBadWordTestResult(signal) {
  if (!signal) return "no match";
  return [
    `**Action:** ${signal.action}`,
    `**Confidence:** ${signal.confidence}%`,
    `**Why:**\n${(signal.reasons || [signal.reason]).map((reason) => `- ${reason}`).join("\n")}`
  ].join("\n");
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
      const reviewLabel = entry.review?.label ? ` | label: \`${entry.review.label}\`` : "";
      return [
        `- ${when} **${result}** \`${entry.action}\` #${entry.id}${reviewLabel} ${user}${channel}`,
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
    "`$set channels` inspect configured bot channels",
    "`$set channel <slot> <#channel|channelid>` update a bot channel slot",
    "`$set channel <slot> reset` restore a channel slot default",
    "`$fetch` refresh the KB cache",
    "`$jarvis` run runtime, KB, link, scam AI, whitelist, lockdown, and security diagnostics",
    "`$testpromax` run the extended diagnostics sweep",
    "`$role all <roleid>` assign a safe role to every human member missing it",
    "`$role <@user|userid> <roleid>` assign a role to one member",
    "`$db` / `$database` inspect the SQLite moderation database",
    "`$scamaudit` inspect recent scam/trade classifier decisions",
    "`$scamaudit label <id> <tp|fp|missed|safe|unsure> [note]` label detector outcomes",
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
    "`$nick add <word>` add a simple nickname rule",
    "`$nick add <word> -> <name>` add a simple nickname rule with a custom rename",
    "`$nick add /^!.*/i -> wawa` rename members matching pattern",
    "`$nick remove <id>` remove a nickname pattern by id",
    "`$badword` list custom content-filter rules",
    "`$badword add <term> [category]` add a literal content-filter rule",
    "`$badword remove <id>` disable a custom content-filter rule",
    "`$badword test <text>` show normalization and matches without deleting"
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
      `**Channel Config:** ${(snapshot.channelSettings || []).filter((entry) => entry.source === "custom").length}/${(snapshot.channelSettings || []).length} custom`,
      `**Restricted Emoji Rows:** ${snapshot.tableCounts.restrictedEmojis}`,
      `**Trusted Link Rows:** ${snapshot.tableCounts.trustedLinks || 0}`,
      `**Manual Whitelist Rows:** ${snapshot.tableCounts.moderationWhitelist || 0}`,
      `**Content Filter Rules:** ${snapshot.tableCounts.contentFilterRules || 0}`,
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
  listAudit = listScamDecisionAudit,
  labelAudit = labelScamDecisionAudit
} = {}) {
  if (command.action === "label") {
    const normalizedLabel = normalizeScamAuditLabel(command.label);
    if (!normalizedLabel) {
      await replyWithCommandPanel(message, {
        header: "Scam Audit Label",
        body: [
          "unknown label",
          "**Usage:** `$scamaudit label <id> <tp|fp|missed|safe|unsure> [note]`"
        ].join("\n"),
        color: WARN
      });
      return true;
    }

    const result = await labelAudit({
      id: command.id,
      label: normalizedLabel,
      note: command.note,
      reviewedBy: message.author?.id || null
    });
    if (!result.updated) {
      await replyWithCommandPanel(message, {
        header: "Scam Audit Label",
        body: result.reason === "not_found"
          ? `no audit row found for id \`${command.id}\``
          : "could not label that audit row",
        color: WARN
      });
      return true;
    }

    await replyWithCommandPanel(message, {
      header: "Scam Audit Labeled",
      body: [
        `**Audit ID:** #${result.record.id}`,
        `**Label:** \`${result.record.review.label}\``,
        result.record.review.note ? `**Note:** ${trimCommandExcerpt(result.record.review.note, 180)}` : null,
        `**Action:** \`${result.record.action}\``,
        `**Message:** ${trimCommandExcerpt(result.record.messageContent, 180)}`
      ].filter(Boolean).join("\n"),
      color: SUCCESS
    });
    return true;
  }

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

function formatSetChannelUsage() {
  return [
    "**Usage:**",
    "`$set channels`",
    "`$set channel general <#channel|channelid>`",
    "`$set channel support <#channel|channelid>`",
    "`$set channel logs <#channel|channelid>`",
    "`$set channel <slot> reset`",
    `**Slots:** ${CHANNEL_CONFIG_SLOTS.map((slot) => slot.key).join(", ")}`
  ].join("\n");
}

function formatConfiguredChannelLine(entry, status = "unchecked") {
  const target = entry.id ? `<#${entry.id}> \`${entry.id}\`` : "`unset`";
  const source = entry.source === "custom" ? "custom" : "default";
  const uses = (entry.uses || []).join(", ");
  return `- **${entry.key}:** ${target} - ${status} - ${source}${uses ? ` - ${uses}` : ""}`;
}

async function resolveGuildChannel(guild, channelId) {
  if (!guild?.channels || !channelId) return null;
  const cached = guild.channels.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild.channels.fetch === "function") {
    return guild.channels.fetch(channelId).catch(() => null);
  }
  return null;
}

async function getChannelSettingStatuses(guild, settings, resolveChannel = resolveGuildChannel) {
  const rows = [];
  for (const entry of settings) {
    if (!entry.id) {
      rows.push({ entry, status: entry.required ? "not set" : "unset" });
      continue;
    }

    const channel = await resolveChannel(guild, entry.id);
    rows.push({
      entry,
      status: channel ? "ok" : "missing"
    });
  }
  return rows;
}

function buildChannelsPanel(rows) {
  const missing = rows.filter((row) => row.status !== "ok");
  return {
    header: missing.length ? "Channel Setup Needs Attention" : "Channel Setup",
    body: [
      `**Missing / Unset:** ${missing.length}`,
      rows.map((row) => formatConfiguredChannelLine(row.entry, row.status)).join("\n"),
      "",
      formatSetChannelUsage()
    ].join("\n"),
    color: missing.length ? WARN : SUCCESS
  };
}

function buildChannelAuditPanel({ message, entry, action }) {
  return {
    header: action === "reset" ? "Channel Config Reset" : "Channel Config Updated",
    body: [
      `**Actor:** ${message.author?.id ? `<@${message.author.id}>` : getCommandActorLabel(message)}`,
      `**Action:** ${action}`,
      `**Slot:** ${entry.key}`,
      `**Channel:** ${entry.id ? `<#${entry.id}> (${entry.id})` : "unset"}`,
      `**Source:** ${entry.source}`
    ].join("\n"),
    color: action === "reset" ? WARN : SUCCESS
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

async function handleSetChannelCommand(message, command, {
  listChannels = listChannelSettings,
  setChannel = setChannelSetting,
  resetChannel = resetChannelSetting,
  resolveChannel = resolveGuildChannel,
  sendLog = sendLogPanel
} = {}) {
  if (!message.inGuild?.() || !message.guild) {
    await replyWithCommandPanel(message, {
      header: "Server Only",
      body: "channel setup commands only work inside the server",
      color: WARN
    });
    return true;
  }

  if (command.action === "list") {
    const settings = await listChannels();
    const rows = await getChannelSettingStatuses(message.guild, settings, resolveChannel);
    await replyWithCommandPanel(message, buildChannelsPanel(rows));
    return true;
  }

  if (command.action === "invalid_slot") {
    await replyWithCommandPanel(message, {
      header: "Unknown Channel Slot",
      body: [
        `I do not know the slot \`${command.slot}\`.`,
        formatSetChannelUsage()
      ].join("\n\n"),
      color: DANGER
    });
    return true;
  }

  if (command.action === "help") {
    const slot = getChannelSlotDefinition(command.slot);
    await replyWithCommandPanel(message, {
      header: "Channel Setup",
      body: [
        slot ? `**Slot:** ${slot.key} - ${slot.label}` : null,
        formatSetChannelUsage()
      ].filter(Boolean).join("\n\n"),
      color: INFO
    });
    return true;
  }

  if (command.action === "reset") {
    const entry = await resetChannel(command.slot);
    if (!entry) {
      await replyWithCommandPanel(message, {
        header: "Unknown Channel Slot",
        body: formatSetChannelUsage(),
        color: DANGER
      });
      return true;
    }

    const rows = await getChannelSettingStatuses(message.guild, [entry], resolveChannel);
    await replyWithCommandPanel(message, {
      header: "Channel Config Reset",
      body: [
        formatConfiguredChannelLine(entry, rows[0]?.status || "unchecked"),
        "",
        "`$set channels` shows the full setup panel."
      ].join("\n"),
      color: WARN
    });

    await sendLog(message.guild, buildChannelAuditPanel({ message, entry, action: "reset" })).catch(() => null);
    return true;
  }

  const channelId = parseChannelIdInput(command.value);
  if (!channelId) {
    await replyWithCommandPanel(message, {
      header: "Channel Rejected",
      body: [
        "send a channel mention, raw channel id, or Discord channel link",
        formatSetChannelUsage()
      ].join("\n\n"),
      color: DANGER
    });
    return true;
  }

  const channel = await resolveChannel(message.guild, channelId);
  if (!channel) {
    await replyWithCommandPanel(message, {
      header: "Channel Not Found",
      body: [
        `I could not find \`${channelId}\` in this server, so I did not save it.`,
        "Use a channel from this server."
      ].join("\n"),
      color: DANGER
    });
    return true;
  }

  const entry = await setChannel(command.slot, channel.id || channelId);
  if (!entry) {
    await replyWithCommandPanel(message, {
      header: "Channel Rejected",
      body: formatSetChannelUsage(),
      color: DANGER
    });
    return true;
  }

  await replyWithCommandPanel(message, {
    header: "Channel Config Updated",
    body: [
      formatConfiguredChannelLine(entry, "ok"),
      "",
      "`$set channels` shows the full setup panel."
    ].join("\n"),
    color: SUCCESS
  });

  await sendLog(message.guild, buildChannelAuditPanel({ message, entry, action: "set" })).catch(() => null);
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
          "**Usage:** `$nick add femboy`, `$nick add femboy -> Kicia User`, or `$nick add /^!.*/i -> wawa`"
        ].join("\n"),
        color: DANGER
      });
      return true;
    }

    const result = await addPattern(validation);
    const patterns = await listPatterns();
    const display = result.pattern?.display || `/${validation.pattern}/${validation.flags} -> ${formatNicknameRenameTarget(validation.renameTo)}`;
    await replyWithCommandPanel(message, {
      header: "Nickname Moderation",
      body: [
        result.added ? `added ${display}` : `that rule already exists: ${display}`,
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
      "`$nick add femboy` -> default BADNAME number",
      "`$nick add femboy -> Kicia User`",
      "`$nick add /^!.*/i -> wawa`",
      "`$nick remove <id>`"
    ].join("\n"),
    color: INFO
  });
  return true;
}

async function handleBadWordCommand(message, command, {
  listRules = listContentFilterRules,
  addRule = addContentFilterRule,
  removeRule = removeContentFilterRuleById
} = {}) {
  if (command.action === "list") {
    const rules = await listRules({ includeDisabled: false });
    const defaultRules = listDefaultContentFilterRules();
    await replyWithCommandPanel(message, {
      header: "Content Filter Rules",
      body: [
        `**Default Rules:** ${defaultRules.length}`,
        `**Custom Rules:** ${rules.length}`,
        formatBadWordRuleList(rules),
        "",
        "**Usage:** `$badword add <term> [hate_slur|adult_content|adult_promo|custom]`, `$badword remove <id>`, `$badword test <text>`"
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  if (command.action === "remove") {
    const result = await removeRule(command.id);
    const rules = await listRules({ includeDisabled: false });
    await replyWithCommandPanel(message, {
      header: "Content Filter Rules",
      body: [
        result.removed ? `disabled rule #${command.id}` : `no enabled custom rule found for #${command.id}`,
        `**Custom Rules:** ${rules.length}`
      ].join("\n"),
      color: result.removed ? SUCCESS : WARN
    });
    return true;
  }

  if (command.action === "add") {
    const validation = validateBadWordRuleInput(command);
    if (!validation.ok) {
      await replyWithCommandPanel(message, {
        header: "Content Filter Rule Rejected",
        body: [
          validation.error,
          "**Usage:** `$badword add <term> [hate_slur|adult_content|adult_promo|custom]`"
        ].join("\n"),
        color: DANGER
      });
      return true;
    }

    const result = await addRule({
      term: validation.term,
      category: validation.category,
      normalizedKey: validation.normalizedKey,
      createdBy: message.author?.id || null
    });
    const rules = await listRules({ includeDisabled: false });
    await replyWithCommandPanel(message, {
      header: "Content Filter Rules",
      body: [
        result.added
          ? `added #${result.rule.id} \`${result.rule.term}\` (${result.rule.category})`
          : `that custom rule already exists: #${result.rule.id} \`${result.rule.term}\` (${result.rule.category})`,
        `**Custom Rules:** ${rules.length}`
      ].join("\n"),
      color: result.added ? SUCCESS : WARN
    });
    return true;
  }

  if (command.action === "test") {
    const rules = await listRules({ includeDisabled: false });
    const forms = buildNormalizedTextForms(command.text);
    const signal = detectContentFilterSignal(command.text, { rules });
    await replyWithCommandPanel(message, {
      header: "Content Filter Test",
      body: [
        `**Input:** ${trimCommandExcerpt(command.text, 180)}`,
        `**Normalized:** \`${trimCommandExcerpt(forms.normalized, 240)}\``,
        `**Compact:** \`${trimCommandExcerpt(forms.compact, 240)}\``,
        `**Collapsed:** \`${trimCommandExcerpt(forms.collapsed, 240)}\``,
        `**Mixed Scripts:** ${forms.scriptMix.hasMixedScripts ? forms.scriptMix.usedScripts.join(", ") : "no"}`,
        formatBadWordTestResult(signal)
      ].join("\n"),
      color: signal ? WARN : SUCCESS
    });
    return true;
  }

  await replyWithCommandPanel(message, {
    header: "Content Filter Rules",
    body: [
      "**Usage:**",
      "`$badword`",
      "`$badword add <term> [hate_slur|adult_content|adult_promo|custom]`",
      "`$badword remove <id>`",
      "`$badword test <text>`"
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

  const setChannelCommand = parseSetChannelMessage(message.content);
  if (setChannelCommand) {
    if (!canUseOwnerCommands(message)) return true;
    return handleSetChannelCommand(message, setChannelCommand, deps);
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

  const badWordCommand = parseBadWordMessage(message.content);
  if (badWordCommand) {
    if (!canUseEmojiCommands(message)) return true;
    return handleBadWordCommand(message, badWordCommand, deps);
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
  parseSetChannelMessage,
  parseEmojiMessage,
  parseNickMessage,
  parseBadWordMessage,
  parseTrustedLinkMessage,
  parseWhitelistMessage,
  parseUserIdInput,
  handleStateCommand,
  handleSetChannelCommand,
  handleNickCommand,
  handleBadWordCommand,
  maybeHandleControlCommand
};
