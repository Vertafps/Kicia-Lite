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
  listRestrictedEmojiTopOffenders,
  listRestrictedEmojiTopUsage,
  getRestrictedEmojiCountSince,
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
  listChannelSettings,
  setChannelSetting,
  resetChannelSetting,
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
const { safeReply } = require("../utils/respond");

const DEFAULT_NICKNAME_RENAME = DEFAULT_NICKNAME_RENAME_SENTINEL;

function escapeRegexLiteral(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseCommandsListMessage(content) {
  const match = String(content || "").match(/^\$(?:cmd|commands|help)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const arg = (match[1] || "").trim().toLowerCase();
  return { category: arg || "menu" };
}

function isCommandsListMessage(content) {
  return parseCommandsListMessage(content) !== null;
}

const TOGGLE_ALIASES = {
  // user-facing answer flows
  support:        "support.answer.enabled",
  kb:             "support.answer.enabled",
  ping:           "support.answer.enabled",
  status:         "status.answer.enabled",
  // guards
  scam:           "scam.guard.enabled",
  trade:          "scam.guard.enabled",
  respect:        "respect.guard.enabled",
  disrespect:     "respect.guard.enabled",
  link:           "link.guard.enabled",
  links:          "link.guard.enabled",
  drug:           "drug.guard.enabled",
  drugs:          "drug.guard.enabled",
  ghost:          "ghost-ping.guard.enabled",
  "ghost-ping":   "ghost-ping.guard.enabled",
  nickname:       "nickname.guard.enabled",
  nicknames:      "nickname.guard.enabled",
  nick:           "nickname.guard.enabled",
  impersonation:  "impersonation.guard.enabled",
  reactions:      "rr.guard.enabled",
  rr:             "rr.guard.enabled",
  training:       "training.enabled"
};

function parseToggleMessage(content) {
  const m = String(content || "").match(/^\$toggle(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const rest = (m[1] || "").trim();
  if (!rest) return { action: "list" };
  const tokens = rest.split(/\s+/);
  const feature = tokens[0]?.toLowerCase();
  const value = tokens[1]?.toLowerCase();
  if (!feature) return { action: "list" };
  return { action: "set", feature, value };
}

function isDatabaseMessage(content) {
  const normalized = String(content || "").trim().toLowerCase();
  return normalized === "$db" || normalized === "$database";
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

  if (/^\$emoji\s+top(?:\s+(\d{1,2}))?$/i.test(trimmed)) {
    const match = trimmed.match(/^\$emoji\s+top(?:\s+(\d{1,2}))?$/i);
    return {
      action: "top",
      limit: Math.min(25, Math.max(3, Math.round(Number(match[1]) || 10)))
    };
  }

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
    // Simple add anchors the literal with word boundaries by default so adding
    // `$nick add bob` matches "bob" / "bob smith" / "hello bob" but NOT
    // "notbob" or "bobsled". Users who need substring or prefix matching can
    // pass the explicit regex form: `$nick add /pattern/i -> name`.
    return {
      action: "add",
      pattern: `\\b${escapeRegexLiteral(literal)}\\b`,
      flags: "i",
      renameTo: renameTo || DEFAULT_NICKNAME_RENAME,
      literal
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

function parseConfigMessage(content) {
  const trimmed = String(content || "").trim();
  const m = trimmed.match(/^\$config(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const rest = (m[1] || "").trim();
  if (!rest || rest === "help") return { action: "help" };

  const tokens = rest.split(/\s+/);
  const cmd = tokens[0]?.toLowerCase();

  if (cmd === "list") {
    const section = tokens[1] && !/^\d+$/.test(tokens[1]) ? tokens[1].toLowerCase() : null;
    const page = tokens[1] && /^\d+$/.test(tokens[1])
      ? Number(tokens[1]) - 1
      : tokens[2] && /^\d+$/.test(tokens[2])
        ? Number(tokens[2]) - 1
        : 0;
    return { action: "list", section, page: Math.max(0, page) };
  }
  if (cmd === "get") {
    if (!tokens[1]) return { action: "invalid", error: "usage: $config get <key>" };
    return { action: "get", key: tokens[1] };
  }
  if (cmd === "set") {
    if (!tokens[1] || tokens.length < 3) return { action: "invalid", error: "usage: $config set <key> <value>" };
    return { action: "set", key: tokens[1], value: tokens.slice(2).join(" ") };
  }
  if (cmd === "reset") {
    if (tokens[1] === "all") {
      const confirm = tokens[2]?.toLowerCase() === "confirm";
      return { action: "resetAll", confirmed: confirm };
    }
    if (!tokens[1]) return { action: "invalid", error: "usage: $config reset <key> | $config reset all confirm" };
    return { action: "reset", key: tokens[1] };
  }
  if (cmd === "diff") return { action: "diff" };
  if (cmd === "export") return { action: "export" };
  return { action: "invalid", error: `unknown subcommand: ${cmd}. try: list, get, set, reset, diff, export, help` };
}

function parseTrainMessage(content) {
  const trimmed = String(content || "").trim();
  const m = trimmed.match(/^\$train(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const rest = (m[1] || "").trim().toLowerCase();
  if (!rest) return { action: "help" };
  if (rest === "scam") return { action: "retrain", classifier: "scam" };
  if (rest === "respect") return { action: "retrain", classifier: "respect" };
  if (rest.startsWith("review")) {
    const parts = rest.split(/\s+/);
    return { action: "review", classifier: parts[1] || "scam" };
  }
  return { action: "invalid", error: "usage: $train scam | $train respect | $train review [classifier]" };
}

function parseTrainingMessage(content) {
  const trimmed = String(content || "").trim();
  const m = trimmed.match(/^\$training(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const rest = (m[1] || "").trim();
  if (!rest || rest === "help") return { action: "help" };
  const tokens = rest.split(/\s+/);
  const cmd = tokens[0]?.toLowerCase();
  if (cmd === "stats") return { action: "stats" };
  if (cmd === "purge") {
    const target = tokens[1];
    const userIdMatch = String(target || "").match(/(\d{15,25})/);
    if (!userIdMatch) return { action: "invalid", error: "usage: $training purge <@user|userid>" };
    return { action: "purge", userId: userIdMatch[1] };
  }
  return { action: "invalid", error: `unknown subcommand: ${cmd}. try: stats, purge` };
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

const COMMAND_CATEGORIES = {
  menu: {
    title: "Bot Commands",
    body: [
      "open a category with `$cmd <name>` (e.g. `$cmd config`)",
      "",
      "**categories**",
      "`$cmd basics` — what everyone can do",
      "`$cmd toggle` — quick on/off shortcuts ← start here",
      "`$cmd status` — runtime status + presence",
      "`$cmd config` — settings deep-dive",
      "`$cmd moderation` — link/scam/disrespect/nick/etc",
      "`$cmd training` — corpus + retrain commands",
      "`$cmd channels` — channel slots + lockdown",
      "`$cmd roles` — role assignment",
      "`$cmd misc` — fetch, jarvis, db, etc"
    ].join("\n")
  },
  basics: {
    title: "Basics · everyone",
    body: [
      "**ping me** with a question — I match it against the KB",
      "`$status` — show current KiciaHook status",
      "",
      "_owners can disable both via `$toggle support off` and `$toggle status off`_"
    ].join("\n")
  },
  toggle: {
    title: "Toggle · quick on/off",
    body: [
      "shorthand for the common config flips",
      "",
      "`$toggle` — show every toggle's current state",
      "`$toggle <feature> on|off`",
      "",
      "**features**",
      "`scam` `respect` `link` `drug` `reactions` `ghost-ping`",
      "`nickname` `impersonation` `support` `status` `training`",
      "",
      "**examples**",
      "`$toggle scam off` — stop scam/trade detection",
      "`$toggle support off` — stop bot answering pings",
      "`$toggle respect on` — re-enable disrespect guard"
    ].join("\n")
  },
  status: {
    title: "Status · runtime + presence",
    body: [
      "`$status` — show current status (everyone)",
      "`$status up|down|unaware` — set runtime status (owner)",
      "`$state` — show bot presence text",
      "`$state <message>` — set bot presence text",
      "`$state reset` — restore default presence"
    ].join("\n")
  },
  config: {
    title: "Config · the settings dashboard",
    body: [
      "70+ tunable keys. owner only.",
      "",
      "`$config` — help",
      "`$config list [section]` — browse settings",
      "`$config get <key>` — show one",
      "`$config set <key> <value>` — change one",
      "`$config reset <key>` — back to default",
      "`$config reset all confirm` — nuke every override",
      "`$config diff` — only show what you've changed",
      "`$config export` — backup dump",
      "",
      "**sections:** link, scam, respect, drug, rr, ghost-ping,",
      "nickname, impersonation, support, status, training, ui, log, daily-stats",
      "",
      "_tip: use `$toggle` for the common on/off stuff. use `$config`",
      "when you actually want to tune thresholds or timeouts._"
    ].join("\n")
  },
  moderation: {
    title: "Moderation · staff +",
    body: [
      "**Trusted links**",
      "`$allowlink` — list · `$allowlink <url>` — add · `$removelink <url>` — remove",
      "",
      "**Restricted emoji**",
      "`$emoji` — list · `$emoji <emoji>` — add · `$emoji remove <emoji>` — remove",
      "`$emoji top` — top offenders (7d)",
      "",
      "**Nickname rules**",
      "`$nick` — list",
      "`$nick add <word>` — simple rule",
      "`$nick add <word> -> <name>` — with rename",
      "`$nick add /regex/i -> name` — regex rule",
      "`$nick remove <id>` — drop a rule",
      "",
      "**Whitelist (owner)**",
      "`$whitelist [user]` · `$whitelist remove <user>`"
    ].join("\n")
  },
  training: {
    title: "Training · corpus + retrain",
    body: [
      "**workflow**: borderline catches post in your training channel with",
      "buttons. staff click Not Scam / Light / Medium / Severe. severity",
      "buttons retroactively timeout the user.",
      "",
      "`$training stats` — counts per classifier (staff+)",
      "`$training purge <@user>` — wipe a banned user's samples (owner)",
      "`$train scam` — retrain scam classifier (owner, ≥20 labels)",
      "`$train respect` — retrain disrespect classifier (owner)",
      "`$train review [classifier]` — peek 5 unlabeled (staff+)",
      "",
      "set the channel: `$set channel training <#channel>`"
    ].join("\n")
  },
  channels: {
    title: "Channels · slots + lockdown",
    body: [
      "`$set channels` — inspect every slot",
      "`$set channel <slot> <#channel|id>` — assign a slot",
      "`$set channel <slot> reset` — restore default",
      "",
      "**slots:** general, support, logs, ignorelogs, staff, daily,",
      "docs, ticket, status, statuswidget, training",
      "",
      "`$lock` — lock configured chat channels",
      "`$unlock` — unlock configured chat channels"
    ].join("\n")
  },
  roles: {
    title: "Roles · assignment (owner)",
    body: [
      "`$role <@user|userid> <roleid>` — give one user a role",
      "`$role all <roleid>` — give every human missing it",
      "`$role status` — check active bulk job",
      "`$role cancel` — stop the current bulk job"
    ].join("\n")
  },
  misc: {
    title: "Misc · diagnostics & ops",
    body: [
      "`$fetch` — refresh KB cache (owner)",
      "`$jarvis` — full diagnostics sweep (owner)",
      "`$testpromax` — extended diagnostics (owner)",
      "`$db` / `$database` — SQLite inspect (owner)",
      "`$policy [enable|disable|status]` — broad link+commerce toggle (owner)"
    ].join("\n")
  }
};

const TOGGLE_CATEGORY_ALIASES = { tog: "toggle", toggles: "toggle" };
const STATUS_CATEGORY_ALIASES = { stats: "status" };
const MISC_CATEGORY_ALIASES = { other: "misc", diag: "misc", diagnostics: "misc" };
const CMD_CATEGORY_ALIASES = {
  ...TOGGLE_CATEGORY_ALIASES,
  ...STATUS_CATEGORY_ALIASES,
  ...MISC_CATEGORY_ALIASES,
  mod: "moderation",
  channel: "channels",
  role: "roles",
  conf: "config",
  settings: "config",
  train: "training",
  basic: "basics",
  help: "menu",
  list: "menu",
  "": "menu"
};

function resolveCommandCategory(name) {
  const lower = String(name || "").toLowerCase();
  const canonical = CMD_CATEGORY_ALIASES[lower] ?? lower;
  return COMMAND_CATEGORIES[canonical] ? canonical : null;
}

async function replyWithCommandPanel(message, panel) {
  await safeReply(message, {
    embeds: [buildPanel(panel)],
    allowedMentions: { repliedUser: false }
  });
}

async function handleCommandsList(message, parsed) {
  const requested = parsed?.category || "menu";
  const resolved = resolveCommandCategory(requested);
  if (!resolved) {
    await replyWithCommandPanel(message, {
      header: "Unknown Category",
      body: `\`${requested}\` is not a category. try \`$cmd\` to see the menu.`,
      color: DANGER
    });
    return true;
  }
  const section = COMMAND_CATEGORIES[resolved];
  await replyWithCommandPanel(message, {
    header: section.title,
    body: section.body,
    color: INFO
  });
  return true;
}

function coerceToggleValue(raw) {
  const v = String(raw || "").toLowerCase().trim();
  if (["on", "true", "yes", "1", "enable", "enabled"].includes(v)) return true;
  if (["off", "false", "no", "0", "disable", "disabled"].includes(v)) return false;
  return null;
}

async function handleToggleCommand(message, parsed, deps) {
  const settings = require("../settings");
  const dbModule = require("../restricted-emoji-db");

  if (parsed.action === "list") {
    const lines = [];
    for (const [alias, key] of Object.entries(TOGGLE_ALIASES)) {
      // dedupe: only show first alias per key
      if (lines.some((l) => l.endsWith("`" + key + "`"))) continue;
      const cur = settings.getSetting(key);
      const mark = cur === false ? "🔴 off" : "🟢 on ";
      lines.push(`${mark} \`${alias}\` → \`${key}\``);
    }
    await replyWithCommandPanel(message, {
      header: "Toggles · current state",
      body: [
        "use `$toggle <feature> on|off` to flip one",
        "",
        ...lines
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  const settingKey = TOGGLE_ALIASES[parsed.feature];
  if (!settingKey) {
    const known = [...new Set(Object.keys(TOGGLE_ALIASES))].join(", ");
    await replyWithCommandPanel(message, {
      header: "Toggle · unknown feature",
      body: `\`${parsed.feature}\` isn't a known toggle.\n\n**known:** ${known}`,
      color: DANGER
    });
    return true;
  }

  if (parsed.value === undefined) {
    const cur = settings.getSetting(settingKey);
    await replyWithCommandPanel(message, {
      header: `Toggle · ${parsed.feature}`,
      body: `\`${settingKey}\` is currently ${cur === false ? "🔴 **off**" : "🟢 **on**"}\n\nflip it: \`$toggle ${parsed.feature} on\` / \`$toggle ${parsed.feature} off\``,
      color: INFO
    });
    return true;
  }

  const next = coerceToggleValue(parsed.value);
  if (next === null) {
    await replyWithCommandPanel(message, {
      header: "Toggle · bad value",
      body: `expected \`on\` or \`off\`, got \`${parsed.value}\``,
      color: DANGER
    });
    return true;
  }

  try {
    const db = await dbModule.getDatabase();
    const result = await settings.setSetting(settingKey, next, { db, actor: message.author, guild: message.guild });
    if (result && result.ok === false) {
      await replyWithCommandPanel(message, {
        header: "Toggle · failed",
        body: result.error || "could not update setting",
        color: DANGER
      });
      return true;
    }
    await replyWithCommandPanel(message, {
      header: `Toggle · ${parsed.feature}`,
      body: `\`${settingKey}\` is now ${next ? "🟢 **on**" : "🔴 **off**"}`,
      color: next ? SUCCESS : WARN
    });
  } catch (err) {
    await replyWithCommandPanel(message, {
      header: "Toggle · error",
      body: err?.message || String(err),
      color: DANGER
    });
  }
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
      `**Daily User Rows:** ${snapshot.tableCounts.dailyUsers}`,
      `**Daily Channel Rows:** ${snapshot.tableCounts.dailyChannels}`,
      `**Daily Staff Rows:** ${snapshot.tableCounts.dailyStaff}`,
      `**Daily Moderation Rows:** ${snapshot.tableCounts.dailyModeration || 0}`,
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
    "`$set channel ignorelogs <#channel|channelid>`",
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
  removeEmoji = removeRestrictedEmojiByKey,
  topOffenders = listRestrictedEmojiTopOffenders,
  topUsage = listRestrictedEmojiTopUsage,
  countSince = getRestrictedEmojiCountSince
} = {}) {
  if (command.action === "list") {
    const emojis = await listEmojis();
    await replyWithCommandPanel(message, {
      header: "Restricted Emojis",
      body: [
        "**Action:** remove reaction + DM warning · tiered timeouts on repeat",
        `**Count:** ${emojis.length}`,
        `**List:** ${formatEmojiList(emojis)}`
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  if (command.action === "top") {
    const limit = command.limit || 10;
    const sinceMs = 7 * 24 * 60 * 60 * 1000;
    const [offenders, usage, weekTotal] = await Promise.all([
      topOffenders({ sinceMs, limit }),
      topUsage({ sinceMs, limit }),
      countSince({ sinceMs })
    ]);
    const offendersList = offenders.length
      ? offenders.map((entry, i) => `${i + 1}. <@${entry.userId}> · ${entry.total} hits`).join("\n")
      : "no offenders in the last 7 days";
    const usageList = usage.length
      ? usage.map((entry, i) => `${i + 1}. \`${entry.emojiKey}\` · ${entry.total} hits`).join("\n")
      : "no restricted emoji usage in the last 7 days";
    await replyWithCommandPanel(message, {
      header: "Restricted Emoji Telemetry (7d)",
      body: [
        `**Total Strikes (7d):** ${weekTotal}`,
        "",
        "**Top Offenders**",
        offendersList,
        "",
        "**Top Restricted Emojis**",
        usageList
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
      "They will be skipped for link policy + prohibited commerce checks.",
      "Channel lockdown permissions are unchanged.",
      `**Count:** ${users.length}`
    ].join("\n"),
    color: result.added ? SUCCESS : WARN
  });
  return true;
}

async function handleConfigCommand(message, parsed) {
  const settings = require("../settings");
  const dbModule = require("../restricted-emoji-db");
  const db = await dbModule.getDatabase();

  if (parsed.action === "help") {
    await replyWithCommandPanel(message, {
      header: "Config",
      body: [
        "**Usage**",
        "`$config list [section] [page]` — list settings",
        "`$config get <key>` — show one setting",
        "`$config set <key> <value>` — change a setting",
        "`$config reset <key>` — restore default",
        "`$config reset all confirm` — restore every default",
        "`$config diff` — show changed-from-default",
        "`$config export` — backup-ready KEY=VALUE",
        "",
        "**Sections**: " + settings.listSections().join(", ")
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  if (parsed.action === "list") {
    const registry = settings.getRegistry();
    let entries = [...registry.entries()];
    if (parsed.section) entries = entries.filter(([, d]) => d.section === parsed.section);
    if (!entries.length) {
      await replyWithCommandPanel(message, {
        header: "Config — No Matches",
        body: parsed.section ? `no settings in section \`${parsed.section}\`` : "no settings registered",
        color: WARN
      });
      return true;
    }
    const pageSize = 15;
    const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
    const page = Math.min(parsed.page, totalPages - 1);
    const slice = entries.slice(page * pageSize, (page + 1) * pageSize);
    const lines = slice.map(([k, d]) => {
      const cur = settings.formatValue(k, settings.getSetting(k));
      const def = settings.formatValue(k, d.defaultValue);
      const star = cur === def ? "" : " *";
      return `**${k}**${star}\n  type \`${d.type}\` · current ${cur} · default ${def}`;
    });
    await replyWithCommandPanel(message, {
      header: `Config · ${parsed.section || "all"} (page ${page + 1}/${totalPages})`,
      body: lines.join("\n\n"),
      color: INFO
    });
    return true;
  }

  if (parsed.action === "get") {
    const desc = settings.describeSetting(parsed.key);
    if (!desc) {
      const suggestions = settings.suggestKeys(parsed.key, { limit: 3 });
      await replyWithCommandPanel(message, {
        header: "Config — Unknown Key",
        body: `\`${parsed.key}\` is not a setting${suggestions.length ? "\n\n**Did you mean:** " + suggestions.map((k) => `\`${k}\``).join(", ") : ""}`,
        color: DANGER
      });
      return true;
    }
    const cur = settings.formatValue(parsed.key, settings.getSetting(parsed.key));
    const def = settings.formatValue(parsed.key, desc.defaultValue);
    await replyWithCommandPanel(message, {
      header: `Config · ${parsed.key}`,
      body: [
        `**Type:** \`${desc.type}\``,
        `**Section:** ${desc.section}`,
        `**Current:** ${cur}`,
        `**Default:** ${def}`,
        desc.description ? `**Description:** ${desc.description}` : ""
      ].filter(Boolean).join("\n"),
      color: INFO
    });
    return true;
  }

  if (parsed.action === "set") {
    const desc = settings.describeSetting(parsed.key);
    if (!desc) {
      const suggestions = settings.suggestKeys(parsed.key, { limit: 3 });
      await replyWithCommandPanel(message, {
        header: "Config — Unknown Key",
        body: `\`${parsed.key}\` is not a setting${suggestions.length ? "\n**Did you mean:** " + suggestions.map((k) => `\`${k}\``).join(", ") : ""}`,
        color: DANGER
      });
      return true;
    }
    const result = await settings.setSetting(parsed.key, parsed.value, {
      db,
      actor: message.author,
      guild: message.guild
    });
    if (!result.ok) {
      await replyWithCommandPanel(message, {
        header: "Config — Invalid Value",
        body: result.error || "could not set value",
        color: DANGER
      });
      return true;
    }
    await replyWithCommandPanel(message, {
      header: "Config Updated",
      body: `**${parsed.key}**\n${settings.formatValue(parsed.key, result.previous)} → **${settings.formatValue(parsed.key, result.next)}**`,
      color: SUCCESS
    });
    return true;
  }

  if (parsed.action === "reset") {
    const desc = settings.describeSetting(parsed.key);
    if (!desc) {
      await replyWithCommandPanel(message, {
        header: "Config — Unknown Key",
        body: `\`${parsed.key}\` is not a setting`,
        color: DANGER
      });
      return true;
    }
    const result = await settings.resetSetting(parsed.key, {
      db,
      actor: message.author,
      guild: message.guild
    });
    if (!result.ok) {
      await replyWithCommandPanel(message, {
        header: "Config — Reset Failed",
        body: result.error || "could not reset",
        color: DANGER
      });
      return true;
    }
    await replyWithCommandPanel(message, {
      header: "Config Reset",
      body: `**${parsed.key}** restored to default · ${settings.formatValue(parsed.key, desc.defaultValue)}`,
      color: WARN
    });
    return true;
  }

  if (parsed.action === "resetAll") {
    if (!parsed.confirmed) {
      await replyWithCommandPanel(message, {
        header: "Confirm",
        body: "send `$config reset all confirm` to wipe every override",
        color: WARN
      });
      return true;
    }
    const registry = settings.getRegistry();
    let count = 0;
    for (const [key] of registry) {
      try {
        const r = await settings.resetSetting(key, {
          db,
          actor: message.author,
          guild: message.guild
        });
        if (r && r.ok) count += 1;
      } catch {
        // swallow per-key failures; keep going
      }
    }
    await replyWithCommandPanel(message, {
      header: "Config Reset · All",
      body: `${count} settings restored to defaults`,
      color: WARN
    });
    return true;
  }

  if (parsed.action === "diff") {
    const registry = settings.getRegistry();
    const diffs = [];
    for (const [key, desc] of registry) {
      const cur = settings.getSetting(key);
      if (cur !== desc.defaultValue) {
        diffs.push(`**${key}**: ${settings.formatValue(key, desc.defaultValue)} → ${settings.formatValue(key, cur)}`);
      }
    }
    await replyWithCommandPanel(message, {
      header: "Config — Diff from Default",
      body: diffs.length ? diffs.join("\n") : "all at defaults",
      color: diffs.length ? INFO : SUCCESS
    });
    return true;
  }

  if (parsed.action === "export") {
    const registry = settings.getRegistry();
    const lines = [];
    for (const [key, desc] of registry) {
      const cur = settings.getSetting(key);
      if (cur !== desc.defaultValue) lines.push(`${key}=${cur}`);
    }
    await replyWithCommandPanel(message, {
      header: "Config Export",
      body: lines.length ? "```\n" + lines.join("\n") + "\n```" : "no overrides set",
      color: INFO
    });
    return true;
  }

  if (parsed.action === "invalid") {
    await replyWithCommandPanel(message, {
      header: "Config — Invalid",
      body: parsed.error,
      color: DANGER
    });
    return true;
  }

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

  const configCommand = parseConfigMessage(message.content);
  if (configCommand) {
    if (!canUseOwnerCommands(message)) return true;
    await handleConfigCommand(message, configCommand);
    return true;
  }

  const trainCommand = parseTrainMessage(message.content);
  if (trainCommand) {
    const { handleTrainCommand } = require("./training-commands");
    return handleTrainCommand(message, trainCommand);
  }

  const trainingCommand = parseTrainingMessage(message.content);
  if (trainingCommand) {
    const { handleTrainingCommand } = require("./training-commands");
    return handleTrainingCommand(message, trainingCommand);
  }

  const toggleCommand = parseToggleMessage(message.content);
  if (toggleCommand) {
    if (!canUseOwnerCommands(message)) return true;
    return handleToggleCommand(message, toggleCommand, deps);
  }

  const cmdListParsed = parseCommandsListMessage(message.content);
  if (cmdListParsed) {
    if (!canUseOwnerCommands(message)) return true;
    return handleCommandsList(message, cmdListParsed);
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
  parseStateMessage,
  parseSetChannelMessage,
  parseEmojiMessage,
  parseNickMessage,
  parseTrustedLinkMessage,
  parseWhitelistMessage,
  parseUserIdInput,
  parseConfigMessage,
  parseTrainMessage,
  parseTrainingMessage,
  handleStateCommand,
  handleSetChannelCommand,
  handleNickCommand,
  handleConfigCommand,
  maybeHandleControlCommand
};
