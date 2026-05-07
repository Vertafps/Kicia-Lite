const {
  BRAND,
  CHANNEL_LOCK_TARGETS,
  DAILY_STATS_CHANNEL_ID,
  LOG_CHANNEL_ID,
  NO_RESPONSE_CHANNEL_IDS
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

function findLockTargetId(pattern) {
  const target = (CHANNEL_LOCK_TARGETS || []).find((entry) => pattern.test(entry?.label || ""));
  return target?.id || "";
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
    defaultId: findLockTargetId(/general/i) || NO_RESPONSE_CHANNEL_IDS[0] || "",
    required: true,
    uses: ["no-response guard", "lockdown target"]
  },
  {
    key: "support",
    aliases: ["supportchat", "community", "help"],
    label: "Support Chat",
    defaultId: findLockTargetId(/support/i),
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

function getStaffChannelId() {
  return getConfiguredChannelId("staff");
}

function getDailyStatsChannelId() {
  return getConfiguredChannelId("daily") || DAILY_STATS_CHANNEL_ID;
}

function getNoResponseChannelIds() {
  const general = getConfiguredChannelId("general");
  const defaultGeneral = getChannelSlotDefinition("general")?.defaultId || "";
  const ids = new Set();
  if (general) ids.add(general);
  for (const id of NO_RESPONSE_CHANNEL_IDS || []) {
    if (id && id !== defaultGeneral) ids.add(id);
  }
  return [...ids];
}

function getChannelLockTargets() {
  return [
    {
      id: getConfiguredChannelId("general"),
      label: "general chat"
    },
    {
      id: getConfiguredChannelId("support"),
      label: "community support chat"
    }
  ];
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
  getLogChannelId,
  getNoResponseChannelIds,
  getStaffChannelId,
  getStatusJumpUrl,
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
