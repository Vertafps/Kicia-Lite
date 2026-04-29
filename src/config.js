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
const OWNER_ROLE_IDS = ["1484221158390890496"];
const ADMIN_ROLE_IDS = ["1484218511797784576"];
const MOD_ROLE_IDS = ["1484221162647978016"];
const STAFF_ROLE_IDS = ["1298767464678559794"];
const DAILY_STATS_CHANNEL_ID = "1484218637060407418";
const LOG_CHANNEL_ID = "1497949003617140858";
const NO_RESPONSE_CHANNEL_IDS = ["1498745066339045406"];
const CHANNEL_LOCK_ROLE_ID = "1484218498262765789";
const CHANNEL_LOCK_TARGETS = [
  { id: "1498745066339045406", label: "general chat" },
  { id: "1489747706980339773", label: "community support chat" }
];
const CHANNEL_LOCK_OPERATOR_ROLE_IDS = [...OWNER_ROLE_IDS];
const CHANNEL_LOCK_OPERATOR_USER_IDS = [OWNER_USER_ID];
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
  BRAND,
  BOT_PRESENCE_TEXT: "Monitoring ;)",
  OWNER_USER_ID,
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
  GEMINI_API_KEY: optional("GEMINI_API_KEY"),
  GEMINI_SCAM_MODEL: optional("GEMINI_SCAM_MODEL") || "gemini-2.5-flash-lite",
  GEMINI_SCAM_TIMEOUT_MS: 3_500,
  GEMINI_SCAM_CACHE_MS: 10 * 60 * 1000,
  GEMINI_SCAM_MIN_INTERVAL_MS: 12 * 1000,
  DAILY_STATS_UTC_OFFSET_MINUTES: 5.5 * 60,
  DAILY_STATS_REPORT_HOUR_LOCAL: 21,
  DAILY_STATS_REPORT_MINUTE_LOCAL: 0,
  DEFAULT_EMOJI_TIMEOUT_MS: 10 * 60 * 1000,
  LINK_MODERATION_TIMEOUT_MS: 60 * 1000,
  LINK_EXPANSION_TIMEOUT_MS: 3 * 1000,
  LINK_THREAT_INTEL_TIMEOUT_MS: 3 * 1000,
  NEW_ACCOUNT_LINK_SCRUTINY_MS: 30 * 24 * 60 * 60 * 1000,
  NEW_MEMBER_LINK_SCRUTINY_MS: 7 * 24 * 60 * 60 * 1000,
  SUSPICIOUS_ALERT_WINDOW_MS: 60 * 60 * 1000,
  SUSPICIOUS_WARNING_THRESHOLD: 2,
  SUSPICIOUS_TIMEOUT_THRESHOLD: 2,
  SUSPICIOUS_TIMEOUT_MS: 10 * 60 * 1000,
  SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD: 90,
  SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_MS: 60 * 60 * 1000,
  SELLING_CONFIDENCE_TIMEOUT_THRESHOLD: 70,
  SELLING_LOW_CONFIDENCE_THRESHOLD: 50,
  SELLING_REPEAT_WINDOW_MS: 30 * 60 * 1000,
  SELLING_REPEAT_TIMEOUT_THRESHOLD: 2,
  SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD: 3,
  SELLING_TIMEOUT_MS: 15 * 60 * 1000,
  DEFAULT_STATUS: "UP",
  USER_COOLDOWN_MS: 30 * 1000,
  GLOBAL_COOLDOWN_MS: 5 * 1000,
  USER_COOLDOWN_EMOJI: "\u{1F9CA}",
  GLOBAL_COOLDOWN_EMOJI: "\u{1F6A7}",
  RECENT_CHANNEL_MESSAGES_N: 20,
  TRANSCRIPT_N: 3,
  RAID_WINDOW_MS: 45 * 1000,
  RAID_MIN_DISTINCT_USERS: 4,
  RAID_ALERT_COOLDOWN_MS: 5 * 60 * 1000
};
