const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");
const {
  NICKMOD_MODAL_PREFIX,
  NICKMOD_NICKNAME_INPUT_ID,
  NICKMOD_RENAME_PREFIX,
  buildNicknameModerationButtonRows
} = require("../components");
const { WARN, buildRichPanel, resolveAvatarURL } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const { canUseEmojiCommands, hasModerationBypassMember } = require("../permissions");
const {
  compactNicknameMatchText,
  formatNicknameRenameTarget,
  normalizeNicknameMatchText,
  normalizeNicknameText,
  resolveNicknameRenameTarget
} = require("../nickname-policy");
const {
  listNicknamePatterns,
  recordDailyModerationEvent
} = require("../restricted-emoji-db");
const { recordRuntimeEvent } = require("../runtime-health");

const NICK_CACHE_TTL_MS = 10 * 60 * 1000;
const NICK_CACHE_CLEANUP_MS = 5 * 60 * 1000;
const nicknameCache = new Map();

function getMemberNick(member) {
  return normalizeNicknameText(
    member?.nickname ||
    member?.displayName ||
    member?.user?.globalName ||
    member?.user?.username ||
    ""
  ).trim();
}

function getMemberNameCandidates(member) {
  const rawCandidates = [
    { label: "Server Nickname", value: member?.nickname },
    { label: "Global Name", value: member?.user?.globalName },
    { label: "Username", value: member?.user?.username },
    { label: "Display Name", value: member?.displayName }
  ];
  const seen = new Set();
  const candidates = [];
  for (const candidate of rawCandidates) {
    const value = normalizeNicknameText(candidate.value);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      ...candidate,
      value,
      normalized: normalizeNicknameMatchText(value),
      compact: compactNicknameMatchText(value)
    });
  }
  return candidates;
}

function getMemberNameSignature(member) {
  return getMemberNameCandidates(member)
    .map((candidate) => `${candidate.label}:${candidate.value}`)
    .join("|");
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

function resetRegex(regex) {
  regex.lastIndex = 0;
  return regex;
}

function unescapeRegexLiteral(pattern) {
  const source = String(pattern || "");
  let output = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      if (index < source.length) output += source[index];
      continue;
    }
    if (/[\^$.*+?()[\]{}|]/.test(char)) return null;
    output += char;
  }
  return output.trim() || null;
}

function collapseRepeats(value) {
  return String(value || "").replace(/(.)\1{2,}/g, "$1$1");
}

function levenshteinDistance(left, right) {
  const a = collapseRepeats(left);
  const b = collapseRepeats(right);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }
  return previous[b.length];
}

function jaroWinkler(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchDistance = Math.max(Math.floor(Math.max(a.length, b.length) / 2) - 1, 0);
  const aMatches = Array.from({ length: a.length }, () => false);
  const bMatches = Array.from({ length: b.length }, () => false);
  let matches = 0;

  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }

  if (!matches) return 0;

  let bIndex = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[bIndex]) bIndex += 1;
    if (a[i] !== b[bIndex]) transpositions += 1;
    bIndex += 1;
  }

  const jaro = (
    matches / a.length +
    matches / b.length +
    (matches - (transpositions / 2)) / matches
  ) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) {
    prefix += 1;
  }
  return jaro + (prefix * 0.1 * (1 - jaro));
}

function fuzzyLiteralMatches(candidateCompact, literalCompact) {
  const candidate = String(candidateCompact || "");
  const literal = String(literalCompact || "");
  if (!candidate || !literal) return false;
  if (candidate.includes(literal) || literal.includes(candidate)) return true;
  if (literal.length < 5 || candidate.length < 5) return false;
  if (candidate[0] !== literal[0]) return false;

  const ratio = Math.min(candidate.length, literal.length) / Math.max(candidate.length, literal.length);
  if (ratio < 0.65) return false;

  const maxDistance = literal.length >= 8 ? 2 : 1;
  if (levenshteinDistance(candidate, literal) <= maxDistance) return true;
  return jaroWinkler(candidate, literal) >= 0.9;
}

function getPatternLiteral(entry) {
  const literal = unescapeRegexLiteral(entry?.pattern);
  if (!literal) return null;
  return {
    raw: literal,
    normalized: normalizeNicknameMatchText(literal),
    compact: compactNicknameMatchText(literal)
  };
}

function getNicknameMatchVariants(nick) {
  const raw = normalizeNicknameText(nick);
  const normalized = normalizeNicknameMatchText(raw);
  const compact = compactNicknameMatchText(raw);
  const variants = [raw, normalized, compact].filter(Boolean);
  return [...new Set(variants)];
}

function findNicknameMatchDetail(nick, patterns) {
  const variants = getNicknameMatchVariants(nick);
  for (const entry of patterns) {
    const regex = compileNicknamePattern(entry);
    if (regex) {
      for (const variant of variants) {
        if (resetRegex(regex).test(variant)) {
          return {
            rule: entry,
            kind: variant === variants[0] ? "regex" : "normalized_regex",
            score: 1
          };
        }
      }
    }

    const literal = getPatternLiteral(entry);
    if (!literal?.compact) continue;
    const compactVariants = [
      compactNicknameMatchText(nick),
      ...normalizeNicknameMatchText(nick).split(/\s+/).map(compactNicknameMatchText)
    ].filter(Boolean);

    for (const candidate of [...new Set(compactVariants)]) {
      if (fuzzyLiteralMatches(candidate, literal.compact)) {
        return {
          rule: entry,
          kind: candidate === literal.compact ? "literal" : "fuzzy_literal",
          score: candidate === literal.compact ? 1 : Math.max(
            1 - (levenshteinDistance(candidate, literal.compact) / Math.max(candidate.length, literal.compact.length)),
            jaroWinkler(candidate, literal.compact)
          )
        };
      }
    }
  }
  return null;
}

function findNicknameMatch(nick, patterns) {
  return findNicknameMatchDetail(nick, patterns)?.rule || null;
}

function findMemberNameMatch(member, patterns) {
  for (const candidate of getMemberNameCandidates(member)) {
    const match = findNicknameMatchDetail(candidate.value, patterns);
    if (match?.rule) {
      return {
        rule: match.rule,
        candidate: {
          ...candidate,
          matchKind: match.kind,
          matchScore: match.score
        }
      };
    }
  }
  return null;
}

function getNicknamePatternSignature(patterns) {
  return (patterns || [])
    .map((entry) => `${entry.id}:${entry.pattern}/${entry.flags}->${entry.renameTo}`)
    .join("|");
}

function inlineCode(value, max = 120) {
  const cleaned = normalizeNicknameText(value).replace(/`/g, "'");
  const clipped = cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 3))}...` : cleaned;
  return `\`${clipped || "(empty)"}\``;
}

function buildNicknameLogPanel({ member, oldNick, rule, candidate, renameTo, renamed }) {
  return {
    embed: buildRichPanel({
      title: "Bad Name Guard",
      color: WARN,
      description: "Review this member if the account name still needs manual cleanup.",
      thumbnail: resolveAvatarURL(member),
      fields: [
        { name: "Member", value: `<@${member.id}>`, inline: true },
        { name: "Matched Field", value: candidate?.label || "Name", inline: true },
        { name: "Matched Value", value: inlineCode(candidate?.value), inline: true },
        { name: "Match Type", value: candidate?.matchKind || "regex", inline: true },
        { name: "Old Display", value: inlineCode(oldNick), inline: true },
        { name: "Applied Nickname", value: inlineCode(renameTo), inline: true },
        { name: "Action", value: renamed ? "Server nickname changed automatically." : "Target nickname was already applied; staff review only.", inline: false },
        { name: "Rule", value: `#${rule.id} /${rule.pattern}/${rule.flags} -> ${formatNicknameRenameTarget(rule.renameTo)}`, inline: false },
        { name: "Staff Action", value: "Use the button below if this needs a cleaner manual nickname.", inline: false }
      ]
    }),
    components: buildNicknameModerationButtonRows(member.id),
    allowedMentions: { parse: [] }
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

  const signature = getMemberNameSignature(member);
  if (!signature) return false;

  try {
    const patterns = await listNicknamePatterns();
    if (!patterns.length) return false;
    const patternSignature = getNicknamePatternSignature(patterns);

    const key = getNicknameCacheKey(member);
    if (key) {
      const cached = nicknameCache.get(key);
      if (
        cached?.signature === signature &&
        cached?.patternSignature === patternSignature &&
        cached.expiresAt > now
      ) {
        return false;
      }
      nicknameCache.set(key, { signature, patternSignature, expiresAt: now + NICK_CACHE_TTL_MS });
    }

    const match = findMemberNameMatch(member, patterns);
    if (!match) return false;

    const oldNick = getMemberNick(member);
    const renameTo = resolveNicknameRenameTarget(match.rule.renameTo, member);
    if (!renameTo) return false;

    const matchedCurrentDisplay = normalizeNicknameText(match.candidate?.value).toLowerCase() === oldNick.toLowerCase();
    const shouldRename = oldNick !== renameTo;
    if (!shouldRename && matchedCurrentDisplay) return false;

    if (shouldRename) {
      await member.setNickname(renameTo, `nickname moderation rule #${match.rule.id}`);
    }
    await recordNicknameModerationStat();
    await sendLog(member.guild, buildNicknameLogPanel({
      member,
      oldNick,
      rule: match.rule,
      candidate: match.candidate,
      renameTo,
      renamed: shouldRename
    })).catch(() => null);
    if (key) {
      nicknameCache.set(key, {
        signature: getMemberNameSignature(member),
        patternSignature,
        expiresAt: now + NICK_CACHE_TTL_MS
      });
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
    thumbnail: resolveAvatarURL(member),
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
