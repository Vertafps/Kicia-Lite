const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const {
  NICKMOD_MODAL_PREFIX,
  NICKMOD_NICKNAME_INPUT_ID,
  NICKMOD_RENAME_PREFIX,
  buildNicknameModerationButtonRows
} = require("../components");
const { WARN, buildRichPanel } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const { canUseEmojiCommands, hasModerationBypassMember } = require("../permissions");
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
  return {
    embed: buildRichPanel({
      title: "Nickname Renamed",
      color: WARN,
      fields: [
        { name: "Member", value: `<@${member.id}>`, inline: true },
        { name: "Old Nickname", value: `\`${oldNick || "(empty)"}\``, inline: true },
        { name: "New Nickname", value: `\`${rule.renameTo}\``, inline: true },
        { name: "Matched Rule", value: `/${rule.pattern}/${rule.flags} - id #${rule.id}`, inline: false }
      ]
    }),
    components: buildNicknameModerationButtonRows(member.id)
  };
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

function sanitizeManualNickname(input) {
  return String(input || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNicknameModerationInteraction(customId) {
  const raw = String(customId || "");
  if (raw.startsWith(NICKMOD_RENAME_PREFIX)) {
    return {
      type: "button",
      userId: raw.slice(NICKMOD_RENAME_PREFIX.length)
    };
  }
  if (raw.startsWith(NICKMOD_MODAL_PREFIX)) {
    return {
      type: "modal",
      userId: raw.slice(NICKMOD_MODAL_PREFIX.length)
    };
  }
  return null;
}

function buildNicknameModal(userId) {
  const input = new TextInputBuilder()
    .setCustomId(NICKMOD_NICKNAME_INPUT_ID)
    .setLabel("New nickname")
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(32)
    .setRequired(true);

  return new ModalBuilder()
    .setCustomId(`${NICKMOD_MODAL_PREFIX}${userId}`)
    .setTitle("Set Member Nickname")
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function replyNicknameInteraction(interaction, panel) {
  const payload = {
    embeds: [buildRichPanel({
      title: panel.header,
      description: panel.body,
      color: panel.color || WARN,
      timestamp: false
    })],
    ephemeral: true,
    allowedMentions: { parse: [] }
  };

  if (interaction?.deferred || interaction?.replied) {
    await interaction.editReply?.(payload).catch(() => null);
    return true;
  }
  await interaction.reply?.(payload).catch(() => null);
  return true;
}

async function resolveInteractionMember(guild, userId) {
  const cached = guild?.members?.cache?.get?.(userId);
  if (cached) return cached;
  if (typeof guild?.members?.fetch !== "function") return null;
  return guild.members.fetch({ user: userId, force: true }).catch(() => null);
}

async function handleNicknameButton(interaction, userId) {
  if (!canUseEmojiCommands({ author: interaction?.user, member: interaction?.member })) {
    await replyNicknameInteraction(interaction, {
      header: "Staff Tools Locked",
      body: "only staff and above can use nickname actions",
      color: WARN
    });
    return true;
  }

  await interaction.showModal?.(buildNicknameModal(userId)).catch(async () => {
    await replyNicknameInteraction(interaction, {
      header: "Modal Failed",
      body: "Discord refused the nickname form. Try again from the latest log message.",
      color: WARN
    });
  });
  return true;
}

async function handleNicknameModal(interaction, userId, { sendLog = sendLogPanel } = {}) {
  if (!canUseEmojiCommands({ author: interaction?.user, member: interaction?.member })) {
    await replyNicknameInteraction(interaction, {
      header: "Staff Tools Locked",
      body: "only staff and above can use nickname actions",
      color: WARN
    });
    return true;
  }

  const nickname = sanitizeManualNickname(
    interaction.fields?.getTextInputValue?.(NICKMOD_NICKNAME_INPUT_ID)
  );
  if (!nickname || nickname.length > 32) {
    await replyNicknameInteraction(interaction, {
      header: "Nickname Rejected",
      body: "nickname must be 1-32 characters after cleanup",
      color: WARN
    });
    return true;
  }

  const member = await resolveInteractionMember(interaction.guild, userId);
  if (!member?.setNickname || member.manageable === false) {
    await replyNicknameInteraction(interaction, {
      header: "Cannot Rename",
      body: "I could not fetch that member or their role is above mine.",
      color: WARN
    });
    return true;
  }

  const oldNick = getMemberNick(member);
  try {
    await member.setNickname(nickname, `manual nickname moderation by ${interaction.user?.tag || interaction.user?.id || "staff"}`);
  } catch (err) {
    await replyNicknameInteraction(interaction, {
      header: "Rename Failed",
      body: `Discord refused the nickname change: ${err?.message || err}`,
      color: WARN
    });
    return true;
  }

  await replyNicknameInteraction(interaction, {
    header: "Nickname Updated",
    body: `<@${member.id}> is now \`${nickname}\`.`,
    color: WARN
  });
  await sendLog(interaction.guild, buildRichPanel({
    title: "Manual Nickname Change",
    color: WARN,
    fields: [
      { name: "Member", value: `<@${member.id}>`, inline: true },
      { name: "Old Nickname", value: `\`${oldNick || "(empty)"}\``, inline: true },
      { name: "New Nickname", value: `\`${nickname}\``, inline: true },
      { name: "Changed By", value: interaction.user?.id ? `<@${interaction.user.id}>` : "staff", inline: false }
    ]
  })).catch(() => null);
  return true;
}

async function maybeHandleNicknameModerationInteraction(interaction, deps = {}) {
  const parsed = parseNicknameModerationInteraction(interaction?.customId);
  if (!parsed?.userId) return false;
  if (!interaction?.inGuild?.()) {
    await replyNicknameInteraction(interaction, {
      header: "Server Only",
      body: "nickname moderation actions only work inside the server",
      color: WARN
    });
    return true;
  }
  if (parsed.type === "button" && interaction?.isButton?.()) {
    return handleNicknameButton(interaction, parsed.userId);
  }
  if (parsed.type === "modal" && interaction?.isModalSubmit?.()) {
    return handleNicknameModal(interaction, parsed.userId, deps);
  }
  return false;
}

module.exports = {
  cleanupNicknameCache,
  findNicknameMatch,
  getMemberNick,
  maybeHandleNicknameModerationInteraction,
  maybeEnforceNicknameMember,
  maybeEnforceNicknameOnMessage,
  parseNicknameModerationInteraction,
  sanitizeManualNickname
};
