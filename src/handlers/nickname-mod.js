const { WARN, buildRichPanel } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const { hasModerationBypassMember } = require("../permissions");
const {
  listNicknamePatterns,
  recordDailyModerationEvent
} = require("../restricted-emoji-db");
const { recordRuntimeEvent } = require("../runtime-health");

const NICK_CACHE_TTL_MS = 10 * 60 * 1000;
const NICK_CACHE_CLEANUP_MS = 5 * 60 * 1000;
const nicknameCache = new Map();

function getMemberNick(member) {
  return String(
    member?.nickname ||
    member?.displayName ||
    member?.user?.globalName ||
    member?.user?.username ||
    ""
  ).trim();
}

function getNicknameCacheKey(member) {
  const guildId = member?.guild?.id;
  const userId = member?.id || member?.user?.id;
  return guildId && userId ? `${guildId}:${userId}` : null;
}

function cleanupNicknameCache(now = Date.now()) {
  for (const [key, entry] of nicknameCache) {
    if (!entry?.expiresAt || entry.expiresAt <= now) {
      nicknameCache.delete(key);
    }
  }
}

const cleanupTimer = setInterval(() => cleanupNicknameCache(), NICK_CACHE_CLEANUP_MS);
cleanupTimer.unref?.();

function compileNicknamePattern(entry) {
  try {
    return new RegExp(entry.pattern, entry.flags || "i");
  } catch {
    return null;
  }
}

function findNicknameMatch(nick, patterns) {
  for (const entry of patterns) {
    const regex = compileNicknamePattern(entry);
    if (regex?.test(nick)) return entry;
  }
  return null;
}

function buildNicknameLogPanel({ member, oldNick, rule }) {
  return buildRichPanel({
    title: "Nickname Renamed",
    color: WARN,
    fields: [
      { name: "Member", value: `<@${member.id}>`, inline: true },
      { name: "Old Nickname", value: `\`${oldNick || "(empty)"}\``, inline: true },
      { name: "New Nickname", value: `\`${rule.renameTo}\``, inline: true },
      { name: "Matched Rule", value: `/${rule.pattern}/${rule.flags} - id #${rule.id}`, inline: false }
    ]
  });
}

async function recordNicknameModerationStat() {
  try {
    await recordDailyModerationEvent("nickname_mod_rename");
  } catch (err) {
    recordRuntimeEvent("warn", "nickname-mod-stat", err?.message || err);
  }
}

async function maybeEnforceNicknameMember(member, { sendLog = sendLogPanel, now = Date.now() } = {}) {
  if (!member?.guild || member.user?.bot) return false;
  if (member.manageable === false || typeof member.setNickname !== "function") return false;
  if (hasModerationBypassMember(member, member.id || member.user?.id)) return false;

  const nick = getMemberNick(member);
  if (!nick) return false;

  const key = getNicknameCacheKey(member);
  if (key) {
    const cached = nicknameCache.get(key);
    if (cached?.nick === nick && cached.expiresAt > now) return false;
    nicknameCache.set(key, { nick, expiresAt: now + NICK_CACHE_TTL_MS });
  }

  try {
    const patterns = await listNicknamePatterns();
    if (!patterns.length) return false;
    const match = findNicknameMatch(nick, patterns);
    if (!match || nick === match.renameTo) return false;

    await member.setNickname(match.renameTo, `nickname moderation rule #${match.id}`);
    await recordNicknameModerationStat();
    await sendLog(member.guild, buildNicknameLogPanel({
      member,
      oldNick: nick,
      rule: match
    })).catch(() => null);
    if (key) {
      nicknameCache.set(key, { nick: match.renameTo, expiresAt: now + NICK_CACHE_TTL_MS });
    }
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "nickname-mod", err?.message || err);
    return false;
  }
}

async function maybeEnforceNicknameOnMessage(message, deps = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return false;
  return maybeEnforceNicknameMember(message.member, deps);
}

module.exports = {
  cleanupNicknameCache,
  findNicknameMatch,
  getMemberNick,
  maybeEnforceNicknameMember,
  maybeEnforceNicknameOnMessage
};
