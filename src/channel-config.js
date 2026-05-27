const {
  BRAND,
  DAILY_STATS_CHANNEL_ID,
  LOG_CHANNEL_ID
} = require("./config");

const CHANNEL_ID_RE = /^\d{15,25}$/;

function extractJumpParts(url) {
  const match = String(url || "").match(/discord(?:app)?\.com\/channels\/(\d{15,25})\/(\d{15,25})/i);
  return match
    ? {
        guildId: match[1],
        channelId: match[2]
      }
    : null;
}

function extractChannelIdFromJumpUrl(url) {
  return extractJumpParts(url)?.channelId || "";
}

function extractGuildIdFromJumpUrl(url) {
  return extractJumpParts(url)?.guildId || "";
}

const DEFAULT_GUILD_ID =
  extractGuildIdFromJumpUrl(BRAND.STATUS_JUMP_URL) ||
  extractGuildIdFromJumpUrl(BRAND.TICKET_JUMP_URL) ||
  extractGuildIdFromJumpUrl(BRAND.DOCS_JUMP_URL);

const CHANNEL_CONFIG_SLOTS = [
  {
    key: "general",
    aliases: ["gen", "generalchat", "main"],
    label: "General Chat",
    defaultId: "",
    required: true,
    uses: ["no-response guard", "lockdown target"]
  },
  {
    key: "support",
    aliases: ["supportchat", "community", "help"],
    label: "Support Chat",
    defaultId: "",
    required: true,
    uses: ["lockdown target"]
  },
  {
    key: "logs",
    aliases: ["log", "audit", "modlogs", "modlog"],
    label: "Logs Channel",
    defaultId: LOG_CHANNEL_ID,
    required: true,
    uses: ["moderation logs", "audit panels", "runtime warnings"]
  },
  {
    key: "ignorelogs",
    aliases: [
      "ignorelog",
      "ignore-logs",
      "clearedlogs",
      "cleared-logs",
      "scamcleared",
      "scam-cleared",
      "aicleared",
      "ai-cleared"
    ],
    label: "Ignore Logs Channel",
    defaultId: "",
    required: false,
    uses: ["Scam AI Cleared panels", "false-positive review noise"]
  },
  {
    key: "staff",
    aliases: ["staffchat", "staff-chat", "staffalerts", "staff-alerts", "alerts"],
    label: "Staff Chat",
    defaultId: "",
    required: false,
    uses: ["outage auto-detection alerts"]
  },
  {
    key: "daily",
    aliases: ["stats", "dailystats", "daily-stats"],
    label: "Daily Stats Channel",
    defaultId: DAILY_STATS_CHANNEL_ID,
    required: true,
    uses: ["daily server report"]
  },
  {
    key: "docs",
    aliases: ["doc", "documentation", "docslink"],
    label: "Docs Channel",
    defaultId: extractChannelIdFromJumpUrl(BRAND.DOCS_JUMP_URL),
    required: true,
    uses: ["docs buttons", "trusted docs jump link"]
  },
  {
    key: "ticket",
    aliases: ["tickets", "ticketpanel", "ticket-panel"],
    label: "Ticket Panel Channel",
    defaultId: extractChannelIdFromJumpUrl(BRAND.TICKET_JUMP_URL),
    required: true,
    uses: ["ticket fallback buttons"]
  },
  {
    key: "status",
    aliases: ["statuschannel", "status-channel"],
    label: "Status Channel",
    defaultId: extractChannelIdFromJumpUrl(BRAND.STATUS_JUMP_URL),
    required: true,
    uses: ["status replies", "status buttons"]
  },
  {
    key: "statuswidget",
    aliases: [
      "widget",
      "status-widget",
      "statuspanel",
      "status-panel",
      "livewidget",
      "live-widget"
    ],
    label: "Status Widget Channel",
    defaultId: "",
    required: false,
    uses: ["pinned live status widget (auto-updates every 60s)"]
  },
  {
    key: "training",
    aliases: ["trainingchannel", "train", "feedback", "scams", "scamreview"],
    label: "Training Channel",
    defaultId: "",
    required: false,
    uses: ["classifier label collection", "scam/disrespect review pings", "retrain audits"]
  },
  {
    key: "config",
    aliases: ["configs", "configsubmissions", "config-submissions"],
    label: "Config Submissions Channel",
    defaultId: "",
    required: false,
    uses: ["/upload config destination", "config submission sticky"]
  },
  {
    key: "clips",
    aliases: ["clip", "clipchannel", "clip-channel"],
    label: "Clips Channel",
    defaultId: "",
    required: false,
    uses: ["clip uploads", "auto-react ✅", "clip-of-the-day source"]
  },
  {
    key: "clipoftheday",
    aliases: ["cotd", "clip-of-the-day", "clipotd"],
    label: "Clip of the Day Channel",
    defaultId: "",
    required: false,
    uses: ["daily clip-of-the-day announcement (9pm UTC+5:30 = 15:30 UTC)"]
  },
  {
    key: "bugs",
    aliases: ["bugs-reports", "bug-reports", "bugreports", "bug-report", "bugreport"],
    label: "Bug Reports Channel",
    defaultId: "",
    required: false,
    uses: ["bug-report reminder sticky (reposts every 5 messages)"]
  }
];

const slotByKey = new Map();
for (const slot of CHANNEL_CONFIG_SLOTS) {
  slotByKey.set(slot.key, slot);
  for (const alias of slot.aliases || []) {
    slotByKey.set(alias, slot);
  }
}

const channelOverrides = new Map();
let channelConfigVersion = 0;

function normalizeChannelSlotKey(input) {
  const key = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  return slotByKey.get(key)?.key || null;
}

function getChannelSlotDefinition(slotKey) {
  const normalized = normalizeChannelSlotKey(slotKey);
  return normalized ? slotByKey.get(normalized) || null : null;
}

function getStoredChannelConfigKey(slotKey) {
  const normalized = normalizeChannelSlotKey(slotKey);
  return normalized ? `channel.${normalized}.id` : null;
}

function parseChannelIdInput(input) {
  const value = String(input || "").trim();
  if (!value) return null;

  const mention = value.match(/^<#(\d{15,25})>$/);
  if (mention) return mention[1];

  const jump = extractChannelIdFromJumpUrl(value);
  if (jump) return jump;

  const raw = value.match(/^#?(\d{15,25})$/);
  if (raw) return raw[1];

  return null;
}

function normalizeChannelId(input) {
  const id = parseChannelIdInput(input);
  return id && CHANNEL_ID_RE.test(id) ? id : null;
}

function hydrateChannelConfigCache(values = {}) {
  channelOverrides.clear();
  for (const slot of CHANNEL_CONFIG_SLOTS) {
    const id = normalizeChannelId(values[slot.key]);
    if (id) channelOverrides.set(slot.key, id);
  }
  channelConfigVersion += 1;
}

function resetChannelConfigCache() {
  channelOverrides.clear();
  channelConfigVersion += 1;
}

function setCachedChannelSlot(slotKey, channelId) {
  const slot = getChannelSlotDefinition(slotKey);
  const id = normalizeChannelId(channelId);
  if (!slot || !id) return false;
  channelOverrides.set(slot.key, id);
  channelConfigVersion += 1;
  return true;
}

function resetCachedChannelSlot(slotKey) {
  const slot = getChannelSlotDefinition(slotKey);
  if (!slot) return false;
  channelOverrides.delete(slot.key);
  channelConfigVersion += 1;
  return true;
}

function getConfiguredChannelId(slotKey) {
  const slot = getChannelSlotDefinition(slotKey);
  if (!slot) return "";
  return channelOverrides.get(slot.key) || slot.defaultId || "";
}

function getConfiguredChannelSource(slotKey) {
  const slot = getChannelSlotDefinition(slotKey);
  if (!slot) return "unknown";
  return channelOverrides.has(slot.key) ? "custom" : "default";
}

function buildChannelJumpUrl(channelId, guildId = DEFAULT_GUILD_ID) {
  const id = normalizeChannelId(channelId);
  const guild = String(guildId || DEFAULT_GUILD_ID || "").trim();
  return id && guild ? `https://discord.com/channels/${guild}/${id}` : "";
}

function getConfiguredChannelJumpUrl(slotKey, guildId = DEFAULT_GUILD_ID) {
  return buildChannelJumpUrl(getConfiguredChannelId(slotKey), guildId);
}

function getBrandJumpUrls(guildId = DEFAULT_GUILD_ID) {
  return [
    getConfiguredChannelJumpUrl("docs", guildId),
    getConfiguredChannelJumpUrl("ticket", guildId),
    getConfiguredChannelJumpUrl("status", guildId)
  ].filter(Boolean);
}

function getDocsJumpUrl(guildId = DEFAULT_GUILD_ID) {
  return getConfiguredChannelJumpUrl("docs", guildId) || BRAND.DOCS_JUMP_URL;
}

function getTicketJumpUrl(guildId = DEFAULT_GUILD_ID) {
  return getConfiguredChannelJumpUrl("ticket", guildId) || BRAND.TICKET_JUMP_URL;
}

function getStatusJumpUrl(guildId = DEFAULT_GUILD_ID) {
  return getConfiguredChannelJumpUrl("status", guildId) || BRAND.STATUS_JUMP_URL;
}

function getLogChannelId() {
  return getConfiguredChannelId("logs") || LOG_CHANNEL_ID;
}

function getIgnoreLogChannelId() {
  return getConfiguredChannelId("ignorelogs");
}

function getStaffChannelId() {
  return getConfiguredChannelId("staff");
}

function getStatusWidgetChannelId() {
  return getConfiguredChannelId("statuswidget");
}

function getConfigChannelId() {
  return getConfiguredChannelId("config");
}

function getClipsChannelId() {
  return getConfiguredChannelId("clips");
}

function getClipOfTheDayChannelId() {
  return getConfiguredChannelId("clipoftheday");
}

function getBugsChannelId() {
  return getConfiguredChannelId("bugs");
}

function getDailyStatsChannelId() {
  return getConfiguredChannelId("daily") || DAILY_STATS_CHANNEL_ID;
}

function getNoResponseChannelIds() {
  // Single source of truth: the configured `general` slot. Empty slot = empty list.
  const general = getConfiguredChannelId("general");
  return general ? [general] : [];
}

function getChannelLockTargets() {
  // Both targets sourced from configured slots at runtime; skip any slot that
  // hasn't been set yet so $jarvis doesn't flag "missing" on an empty target.
  const targets = [];
  const generalId = getConfiguredChannelId("general");
  if (generalId) targets.push({ id: generalId, label: "general chat" });
  const supportId = getConfiguredChannelId("support");
  if (supportId) targets.push({ id: supportId, label: "community support chat" });
  return targets;
}

function listChannelConfigSlots(guildId = DEFAULT_GUILD_ID) {
  return CHANNEL_CONFIG_SLOTS.map((slot) => {
    const id = getConfiguredChannelId(slot.key);
    return {
      ...slot,
      id,
      source: getConfiguredChannelSource(slot.key),
      jumpUrl: buildChannelJumpUrl(id, guildId)
    };
  });
}

function getChannelConfigVersion() {
  return channelConfigVersion;
}

module.exports = {
  CHANNEL_CONFIG_SLOTS,
  DEFAULT_GUILD_ID,
  buildChannelJumpUrl,
  getBrandJumpUrls,
  getChannelConfigVersion,
  getChannelLockTargets,
  getChannelSlotDefinition,
  getConfiguredChannelId,
  getConfiguredChannelJumpUrl,
  getConfiguredChannelSource,
  getDailyStatsChannelId,
  getDocsJumpUrl,
  getIgnoreLogChannelId,
  getLogChannelId,
  getNoResponseChannelIds,
  getStaffChannelId,
  getStatusJumpUrl,
  getStatusWidgetChannelId,
  getConfigChannelId,
  getClipsChannelId,
  getClipOfTheDayChannelId,
  getBugsChannelId,
  getStoredChannelConfigKey,
  getTicketJumpUrl,
  hydrateChannelConfigCache,
  listChannelConfigSlots,
  normalizeChannelId,
  normalizeChannelSlotKey,
  parseChannelIdInput,
  resetCachedChannelSlot,
  resetChannelConfigCache,
  setCachedChannelSlot
};
