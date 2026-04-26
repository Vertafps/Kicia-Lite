const { PermissionFlagsBits } = require("discord.js");
const {
  STAFF_ALERT_CHANNEL_ID,
  CHANNEL_LOCK_OPERATOR_ROLE_IDS,
  CHANNEL_LOCK_OPERATOR_USER_IDS,
  RAID_WINDOW_MS,
  RAID_MIN_DISTINCT_USERS,
  RAID_ALERT_COOLDOWN_MS
} = require("../config");
const { buildPanel, DANGER, WARN } = require("../embed");
const { fetchKb } = require("../kb");
const { getRuntimeStatus } = require("../runtime-status");
const { cleanText, normalizeText } = require("../text");

const raidBuckets = new Map();
const lastRaidAlertAt = new Map();
const STAFF_BYPASS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers
];

const SELL_ITEM_RE = /\b(?:account|accounts|config|configs|executor|executors|script|scripts|kicia|kiciahook|premium|license|key|keys|cheat|cheats|exploit|exploits)\b/;
const SELL_MARKET_RE = /\b(?:price|prices|usd|paypal|cashapp|crypto|cheap|offer|offers|buy)\b/;
const SELL_OFFER_PATTERNS = [
  /\b(?:i am|im|i m)\s+selling\b/,
  /\bfor sale\b/,
  /\bdm (?:me )?(?:to buy|for prices?|for price|if you want to buy)\b/,
  /\bbuy (?:my|from me)\b/,
  /\btaking offers\b/
];
const SELL_EXCLUDE_PATTERNS = [
  /\?$/,
  /^(?:who|why|is|are|can|does|do|what|how|where|when)\b/,
  /\b(?:anyone|someone)\s+selling\b/,
  /\b(?:stop|dont|don't|not)\s+selling\b/
];

const SUSPICIOUS_PATTERNS = [
  {
    label: "dm-link-offer",
    pattern: /\bdm me for (?:the |a )?(?:link|download|invite|crack|leak)\b/,
    reason: "offering links privately"
  },
  {
    label: "disable-defender",
    pattern: /\b(?:disable|turn off)\s+(?:windows\s+)?(?:defender|antivirus)\b/,
    reason: "telling people to disable security tools"
  },
  {
    label: "cracked-or-leaked",
    pattern: /\b(?:cracked|leaked)\s+(?:kicia|kiciahook|premium)\b/,
    reason: "mentioning cracked or leaked product access"
  },
  {
    label: "paste-this",
    pattern: /\bpaste this\b/,
    reason: "asking users to paste unknown content"
  },
  {
    label: "free-premium",
    pattern: /\bfree premium\b/,
    reason: "claiming free premium access"
  }
];

const ASSERTION_EXCLUDE_PATTERNS = [
  /\?/,
  /^(?:is|are|can|does|do|what|why|how|which|where|when)\b/,
  /\b(?:maybe|might|i think|think|idk|not sure|probably|seems|looks like)\b/
];
const STATUS_WORD_TO_RUNTIME = new Map([
  ["up", "UP"],
  ["working", "UP"],
  ["online", "UP"],
  ["down", "DOWN"],
  ["offline", "DOWN"],
  ["broken", "DOWN"],
  ["not working", "DOWN"]
]);

function trimExcerpt(text, max = 220) {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned.length <= max) return cleaned || "(no text)";
  return `${cleaned.slice(0, max - 3)}...`;
}

function buildMessageUrl(message) {
  if (message?.url) return message.url;
  if (!message?.guildId || !message?.channelId || !message?.id) return null;
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

function hasBypassPermission(message) {
  if (CHANNEL_LOCK_OPERATOR_USER_IDS.includes(message.author?.id)) return true;

  if (CHANNEL_LOCK_OPERATOR_ROLE_IDS.some((roleId) => message.member?.roles?.cache?.has?.(roleId))) {
    return true;
  }

  return STAFF_BYPASS_PERMISSIONS.some((permission) => message.member?.permissions?.has?.(permission));
}

function isAssertiveStatement(content) {
  const normalized = normalizeText(content);
  if (!normalized) return false;
  return !ASSERTION_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content) || pattern.test(normalized));
}

function detectSellingSignal(content) {
  const normalized = normalizeText(content);
  if (!normalized) return null;
  if (SELL_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content) || pattern.test(normalized))) return null;
  if (!SELL_ITEM_RE.test(normalized)) return null;

  const hasExplicitOffer = SELL_OFFER_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasSellingVerb = /\bselling\b/.test(normalized);
  const hasMarketSignal = SELL_MARKET_RE.test(normalized) || /\$\s*\d/.test(content);

  if (!hasExplicitOffer && !(hasSellingVerb && hasMarketSignal)) {
    return null;
  }

  return {
    type: "selling",
    reason: "explicit sell offer detected"
  };
}

function detectSuspiciousSignal(content) {
  const normalized = normalizeText(content);
  if (!normalized) return null;

  for (const candidate of SUSPICIOUS_PATTERNS) {
    if (candidate.pattern.test(normalized)) {
      return {
        type: "suspicious",
        reason: candidate.reason,
        label: candidate.label
      };
    }
  }

  return null;
}

function detectStatusFakeInfo(content, runtimeStatus) {
  if (!isAssertiveStatement(content)) return null;
  const normalized = normalizeText(content);
  if (!normalized) return null;

  const patterns = [
    /^(?:kicia|kiciahook)(?:\s+status)?\s+is\s+(up|working|online|down|offline|broken|not working)$/,
    /^(?:kicia|kiciahook)\s+(up|working|online|down|offline|broken|not working)$/,
    /^status\s+is\s+(up|down)$/
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const claimedStatus = STATUS_WORD_TO_RUNTIME.get(match[1]);
    if (!claimedStatus || claimedStatus === runtimeStatus) return null;

    return {
      type: "fake_info",
      reason: `claimed status is ${match[1]}, but runtime status is ${runtimeStatus.toLowerCase()}`
    };
  }

  return null;
}

function getExecutorAliases(kb) {
  return Object.keys(kb?.executorAliasIndex || {}).sort((a, b) => b.length - a.length);
}

function detectExecutorClaim(normalized, kb) {
  for (const alias of getExecutorAliases(kb)) {
    const checks = [
      [`${alias} is supported`, "positive_support"],
      [`${alias} supported`, "positive_support"],
      [`${alias} is unsupported`, "negative_support"],
      [`${alias} unsupported`, "negative_support"],
      [`${alias} works`, "positive_working"],
      [`${alias} working`, "positive_working"],
      [`${alias} works with kicia`, "positive_working"],
      [`${alias} works with kiciahook`, "positive_working"],
      [`${alias} does not work`, "negative_working"],
      [`${alias} doesnt work`, "negative_working"],
      [`${alias} not working`, "negative_working"],
      [`kicia supports ${alias}`, "positive_support"],
      [`kiciahook supports ${alias}`, "positive_support"],
      [`kicia does not support ${alias}`, "negative_support"],
      [`kiciahook does not support ${alias}`, "negative_support"],
      [`kicia doesnt support ${alias}`, "negative_support"],
      [`kiciahook doesnt support ${alias}`, "negative_support"]
    ];

    for (const [text, claimType] of checks) {
      if (normalized === text) {
        return {
          executor: kb.executorAliasIndex[alias],
          claimType
        };
      }
    }
  }

  return null;
}

function detectExecutorFakeInfo(content, kb) {
  if (!isAssertiveStatement(content) || !kb) return null;
  const normalized = normalizeText(content);
  if (!normalized) return null;

  const claim = detectExecutorClaim(normalized, kb);
  if (!claim?.executor) return null;

  const { executor, claimType } = claim;
  const status = executor.status;

  if (claimType === "positive_support" && status === "unsupported") {
    return {
      type: "fake_info",
      reason: `${executor.name} is listed as unsupported in docs`
    };
  }

  if (claimType === "negative_support" && status === "supported") {
    return {
      type: "fake_info",
      reason: `${executor.name} is listed as supported in docs`
    };
  }

  if (claimType === "positive_working" && (status === "unsupported" || status === "temporarily_not_working")) {
    return {
      type: "fake_info",
      reason:
        status === "temporarily_not_working"
          ? `${executor.name} is listed as temporarily not working rn`
          : `${executor.name} is listed as unsupported in docs`
    };
  }

  if (claimType === "negative_working" && status === "supported") {
    return {
      type: "fake_info",
      reason: `${executor.name} is listed as supported in docs`
    };
  }

  return null;
}

function mightContainFakeInfo(content) {
  const normalized = normalizeText(content);
  if (!normalized) return false;
  if (!isAssertiveStatement(content)) return false;

  return (
    (
      /\b(?:kicia|kiciahook|status)\b/.test(normalized) &&
      /\b(?:up|down|working|offline|online|broken)\b/.test(normalized)
    ) ||
    /\b(?:supports?|supported|unsupported|works|working)\b/.test(normalized) ||
    /\b(?:does not work|doesnt work|not working)\b/.test(normalized)
  );
}

function detectFakeInfoSignal(content, { kb, runtimeStatus }) {
  const statusSignal = detectStatusFakeInfo(content, runtimeStatus);
  if (statusSignal) return statusSignal;
  return detectExecutorFakeInfo(content, kb);
}

function normalizeRaidSignature(content) {
  const cleaned = cleanText(content)
    .replace(/https?:\/\/\S+/gi, " url ")
    .replace(/discord\.gg\/\S+/gi, " invite ");
  const normalized = normalizeText(cleaned);
  if (!normalized) return null;
  if (normalized.length < 12) return null;
  if (normalized.split(/\s+/).filter(Boolean).length < 3) return null;
  return normalized;
}

function pruneRaidState(now = Date.now()) {
  for (const [key, entry] of raidBuckets.entries()) {
    entry.events = entry.events.filter((event) => now - event.at <= RAID_WINDOW_MS);
    if (!entry.events.length) raidBuckets.delete(key);
  }

  for (const [key, alertedAt] of lastRaidAlertAt.entries()) {
    if (now - alertedAt > RAID_ALERT_COOLDOWN_MS) {
      lastRaidAlertAt.delete(key);
    }
  }
}

function observeRaidMessage(message, now = Date.now()) {
  if (!message?.inGuild?.()) return null;

  pruneRaidState(now);
  const signature = normalizeRaidSignature(message.content);
  if (!signature) return null;

  const key = `${message.guildId}:${message.channelId}:${signature}`;
  const entry = raidBuckets.get(key) || { events: [] };
  entry.events.push({
    at: now,
    userId: message.author?.id,
    url: buildMessageUrl(message)
  });
  raidBuckets.set(key, entry);

  const uniqueUsers = new Set(entry.events.map((event) => event.userId).filter(Boolean));
  if (uniqueUsers.size < RAID_MIN_DISTINCT_USERS) return null;
  const lastAlertAt = lastRaidAlertAt.get(key);
  if (lastAlertAt && now - lastAlertAt < RAID_ALERT_COOLDOWN_MS) return null;

  lastRaidAlertAt.set(key, now);
  return {
    type: "raid",
    reason: `${uniqueUsers.size} users repeated near-identical messages inside ${Math.round(RAID_WINDOW_MS / 1000)}s`,
    signature,
    uniqueUsers: uniqueUsers.size,
    sampleUrl: entry.events[entry.events.length - 1]?.url || null
  };
}

function buildPrimaryAlertHeader(signals) {
  if (signals.some((signal) => signal.type === "selling")) return "Selling Alert";
  if (signals.some((signal) => signal.type === "suspicious")) return "Suspicious Message Alert";
  return "Fake Info Alert";
}

function buildSignalAlertPanel(message, signals) {
  const link = buildMessageUrl(message);
  const reasons = signals.map((signal) => `- ${signal.reason}`).join("\n");

  return {
    header: buildPrimaryAlertHeader(signals),
    body: [
      "hey, i found something worth checking",
      `**User:** <@${message.author?.id}>`,
      `**Channel:** <#${message.channelId}>`,
      link ? `**Jump:** [Open message](${link})` : null,
      `**Why:**\n${reasons}`,
      `**Message:** ${trimExcerpt(message.content)}`
    ].filter(Boolean).join("\n\n"),
    color: signals.some((signal) => signal.type === "selling") ? DANGER : WARN
  };
}

function buildRaidAlertPanel(message, raidAlert) {
  const link = raidAlert.sampleUrl || buildMessageUrl(message);

  return {
    header: "Raid Alert",
    body: [
      "hey, this looks like a raid wave or copy-paste spam",
      `**Channel:** <#${message.channelId}>`,
      `**Users:** ${raidAlert.uniqueUsers}`,
      link ? `**Jump:** [Open message](${link})` : null,
      `**Pattern:** ${trimExcerpt(raidAlert.signature, 180)}`
    ].filter(Boolean).join("\n\n"),
    color: DANGER
  };
}

async function resolveStaffAlertChannel(message) {
  if (!message?.guild?.channels) return null;

  const cached = message.guild.channels.cache?.get(STAFF_ALERT_CHANNEL_ID);
  if (cached?.send) return cached;

  if (typeof message.guild.channels.fetch === "function") {
    const fetched = await message.guild.channels.fetch(STAFF_ALERT_CHANNEL_ID).catch(() => null);
    if (fetched?.send) return fetched;
  }

  return null;
}

async function sendStaffAlert(message, panel) {
  const alertChannel = await resolveStaffAlertChannel(message);
  if (!alertChannel) return false;

  await alertChannel.send({
    embeds: [buildPanel(panel)],
    allowedMentions: { parse: [] }
  });
  return true;
}

function collectContentSignals(content, { kb, runtimeStatus }) {
  const signals = [];
  const sellingSignal = detectSellingSignal(content);
  if (sellingSignal) signals.push(sellingSignal);

  const suspiciousSignal = detectSuspiciousSignal(content);
  if (suspiciousSignal) signals.push(suspiciousSignal);

  if (kb && runtimeStatus) {
    const fakeInfoSignal = detectFakeInfoSignal(content, { kb, runtimeStatus });
    if (fakeInfoSignal) signals.push(fakeInfoSignal);
  }

  return signals;
}

async function maybeHandleModerationWatch(message, { kb, runtimeStatus, fetchKbFn = fetchKb } = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return false;
  if (hasBypassPermission(message)) return false;

  try {
    let resolvedKb = kb || null;
    if (!resolvedKb && mightContainFakeInfo(message.content)) {
      resolvedKb = await fetchKbFn().catch(() => null);
    }

    const signals = collectContentSignals(message.content, {
      kb: resolvedKb,
      runtimeStatus: runtimeStatus || getRuntimeStatus()
    });

    if (signals.length) {
      await sendStaffAlert(message, buildSignalAlertPanel(message, signals));
    }

    const raidAlert = observeRaidMessage(message);
    if (raidAlert) {
      await sendStaffAlert(message, buildRaidAlertPanel(message, raidAlert));
    }
  } catch (err) {
    console.warn("Moderation watcher failed:", err.message);
  }

  return false;
}

function resetModerationState() {
  raidBuckets.clear();
  lastRaidAlertAt.clear();
}

module.exports = {
  detectSellingSignal,
  detectSuspiciousSignal,
  detectFakeInfoSignal,
  collectContentSignals,
  hasBypassPermission,
  observeRaidMessage,
  resetModerationState,
  maybeHandleModerationWatch
};
