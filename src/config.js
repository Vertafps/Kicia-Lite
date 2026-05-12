require("dotenv").config();

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing env var: ${name}`);
  return v.trim();
}

function optional(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : "";
}

function optionalBoolean(name, fallback = false) {
  const value = optional(name).toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function normalizeKbUrl(input) {
  const raw = input.trim();
  if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(raw)) return raw;

  const blobMatch = raw.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i
  );
  if (blobMatch) {
    const [, owner, repo, ref, filePath] = blobMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  }

  return raw;
}

function requiredUrl(name) {
  const value = normalizeKbUrl(required(name));
  try {
    new URL(value);
  } catch {
    throw new Error(`Invalid URL in env var ${name}: ${value}`);
  }
  return value;
}

const BRAND = {
  NAME: "Wizard of Kicia",
  DOCS_JUMP_URL: "https://discord.com/channels/1279483425002361003/1484218540499140891",
  TICKET_JUMP_URL: "https://discord.com/channels/1279483425002361003/1484218571478532147",
  STATUS_JUMP_URL: "https://discord.com/channels/1279483425002361003/1497703492012347412"
};

const OWNER_USER_ID = "847703912932311091";
const OWNER_USER_IDS = [
  OWNER_USER_ID,
  "648336016469655564"
];
const OWNER_ROLE_IDS = ["1484221158390890496"];
const ADMIN_ROLE_IDS = ["1484218516071518258"];
const MOD_ROLE_IDS = ["1484221162647978016"];
const STAFF_ROLE_IDS = ["1298767464678559794", "1495349698360508546"];
const DAILY_STATS_CHANNEL_ID = "1484218637060407418";
const LOG_CHANNEL_ID = "1497949003617140858";
const NO_RESPONSE_CHANNEL_IDS = ["1498745066339045406"];
const CHANNEL_LOCK_ROLE_ID = "1484218498262765789";
const CHANNEL_LOCK_TARGETS = [
  { id: "1498745066339045406", label: "general chat" },
  { id: "1489747706980339773", label: "community support chat" }
];
const CHANNEL_LOCK_OPERATOR_ROLE_IDS = [...OWNER_ROLE_IDS];
const CHANNEL_LOCK_OPERATOR_USER_IDS = [...OWNER_USER_IDS];
const EMOJI_MANAGER_ROLE_IDS = [...OWNER_ROLE_IDS, ...ADMIN_ROLE_IDS, ...MOD_ROLE_IDS, ...STAFF_ROLE_IDS];
const MODERATION_BYPASS_ROLE_IDS = [...EMOJI_MANAGER_ROLE_IDS];
const RESTRICTED_REACTION_TARGET_ROLE_IDS = [...EMOJI_MANAGER_ROLE_IDS];
const TRUSTED_LINK_URLS = [
  "https://rdd.whatexpsare.online/",
  "https://rdd.weao.xyz/",
  "https://rdd.weao.gg/",
  "https://whatexpsare.online/",
  "https://inject.today/",
  "https://inject.today/rdd",
  "https://rivalscheats.shop/"
];

module.exports = {
  DISCORD_TOKEN: required("DISCORD_TOKEN"),
  KB_URL: requiredUrl("KB_URL"),
  ENABLE_GUILD_MEMBER_EVENTS: optionalBoolean("ENABLE_GUILD_MEMBER_EVENTS", false),
  BRAND,
  BOT_PRESENCE_TEXT: "Monitoring ;)",
  OWNER_USER_ID,
  OWNER_USER_IDS,
  OWNER_ROLE_IDS,
  ADMIN_ROLE_IDS,
  MOD_ROLE_IDS,
  STAFF_ROLE_IDS,
  DAILY_STATS_CHANNEL_ID,
  LOG_CHANNEL_ID,
  NO_RESPONSE_CHANNEL_IDS,
  CHANNEL_LOCK_ROLE_ID,
  CHANNEL_LOCK_TARGETS,
  CHANNEL_LOCK_OPERATOR_ROLE_IDS,
  CHANNEL_LOCK_OPERATOR_USER_IDS,
  EMOJI_MANAGER_ROLE_IDS,
  MODERATION_BYPASS_ROLE_IDS,
  RESTRICTED_REACTION_TARGET_ROLE_IDS,
  TRUSTED_LINK_URLS,
  GOOGLE_SAFE_BROWSING_API_KEY: optional("GOOGLE_SAFE_BROWSING_API_KEY"),
  GOOGLE_WEB_RISK_API_KEY: optional("GOOGLE_WEB_RISK_API_KEY"),
  VIRUSTOTAL_API_KEY: optional("VIRUSTOTAL_API_KEY"),
  PHISHTANK_API_KEY: optional("PHISHTANK_API_KEY"),
  FISHFISH_API_BASE_URL: optional("FISHFISH_API_BASE_URL") || "https://api.fishfish.gg/v1",
  // KB semantic search (uses @huggingface/transformers MiniLM)
  ENABLE_KB_EMBED_INDEX: optionalBoolean("ENABLE_KB_EMBED_INDEX", true),
  KB_EMBED_MODEL_ID: optional("KB_EMBED_MODEL_ID") || "Xenova/all-MiniLM-L6-v2",
  KB_EMBED_TIMEOUT_MS: Number(optional("KB_EMBED_TIMEOUT_MS") || 1_500),
  KB_EMBED_TOP_K: Number(optional("KB_EMBED_TOP_K") || 7),
  DAILY_STATS_UTC_OFFSET_MINUTES: 5.5 * 60,
  DAILY_STATS_REPORT_HOUR_LOCAL: 21,
  DAILY_STATS_REPORT_MINUTE_LOCAL: 0,
  DEFAULT_EMOJI_TIMEOUT_MS: 10 * 60 * 1000,
  LINK_MODERATION_TIMEOUT_MS: 60 * 1000,
  LINK_EXPANSION_TIMEOUT_MS: 3 * 1000,
  LINK_THREAT_INTEL_TIMEOUT_MS: 3 * 1000,
  SCAM_PULSE_TIMEOUT_MS: 7 * 24 * 60 * 60 * 1000,
  NEW_ACCOUNT_LINK_SCRUTINY_MS: 30 * 24 * 60 * 60 * 1000,
  NEW_MEMBER_LINK_SCRUTINY_MS: 7 * 24 * 60 * 60 * 1000,
  // Restricted emoji spam escalation
  EMOJI_SPAM_TIER1_WINDOW_MS: Number(optional("EMOJI_SPAM_TIER1_WINDOW_MS") || 30_000),
  EMOJI_SPAM_TIER1_COUNT: Number(optional("EMOJI_SPAM_TIER1_COUNT") || 3),
  EMOJI_SPAM_TIER1_TIMEOUT_MS: Number(optional("EMOJI_SPAM_TIER1_TIMEOUT_MS") || 5 * 60 * 1000),
  EMOJI_SPAM_TIER2_WINDOW_MS: Number(optional("EMOJI_SPAM_TIER2_WINDOW_MS") || 60_000),
  EMOJI_SPAM_TIER2_COUNT: Number(optional("EMOJI_SPAM_TIER2_COUNT") || 5),
  EMOJI_SPAM_TIER2_TIMEOUT_MS: Number(optional("EMOJI_SPAM_TIER2_TIMEOUT_MS") || 30 * 60 * 1000),
  EMOJI_SPAM_TIER3_WINDOW_MS: Number(optional("EMOJI_SPAM_TIER3_WINDOW_MS") || 5 * 60 * 1000),
  EMOJI_SPAM_TIER3_COUNT: Number(optional("EMOJI_SPAM_TIER3_COUNT") || 8),
  // Anti-ghost-ping
  GHOST_PING_RETENTION_MS: Number(optional("GHOST_PING_RETENTION_MS") || 60_000),
  // Status pinned widget
  STATUS_WIDGET_REFRESH_MS: Number(optional("STATUS_WIDGET_REFRESH_MS") || 60_000),
  DEFAULT_STATUS: "UP",
  USER_COOLDOWN_MS: 30 * 1000,
  GLOBAL_COOLDOWN_MS: 5 * 1000,
  USER_COOLDOWN_EMOJI: "\u{1F9CA}",
  GLOBAL_COOLDOWN_EMOJI: "\u{1F9CA}",
  RECENT_CHANNEL_MESSAGES_N: 20,
  TRANSCRIPT_N: 3,
  ANIMATED_HEROES: optionalBoolean("ANIMATED_HEROES", true),
  EPHEMERAL_STAFF: optionalBoolean("EPHEMERAL_STAFF", true),
  KB_EMBED_CACHE_PATH: optional("KB_EMBED_CACHE_PATH") || "data/kb-embeddings-cache.json",
  KB_EMBED_LEXICAL_WEIGHT: Number(optional("KB_EMBED_LEXICAL_WEIGHT") || 0.65),
  KB_EMBED_SEMANTIC_WEIGHT: Number(optional("KB_EMBED_SEMANTIC_WEIGHT") || 0.35),
  KB_EMBED_TIEBREAK_RATIO: Number(optional("KB_EMBED_TIEBREAK_RATIO") || 0.85),
  KB_EMBED_FLOOR: Number(optional("KB_EMBED_FLOOR") || 0.72)
};
