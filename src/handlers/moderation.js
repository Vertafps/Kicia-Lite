const {
  LINK_MODERATION_TIMEOUT_MS,
  RAID_WINDOW_MS,
  RAID_MIN_DISTINCT_USERS,
  RAID_ALERT_COOLDOWN_MS
} = require("../config");
const { buildPanel, DANGER, WARN } = require("../embed");
const { fetchKb } = require("../kb");
const { detectBlockedLinkSignal, extractUrlsFromText } = require("../link-policy");
const { sendLogPanel } = require("../log-channel");
const { hasModerationBypassMessage } = require("../permissions");
const { recordRuntimeEvent } = require("../runtime-health");
const { getRuntimeStatus } = require("../runtime-status");
const { cleanText, normalizeText } = require("../text");
const { safeSend } = require("../utils/respond");

const raidBuckets = new Map();
const lastRaidAlertAt = new Map();
const recentUserMessages = new Map();

const SELL_ITEM_RE = /\b(?:acc|account|accounts|lvl|level|config|configs|cfg|cfgs|executor|executors|script|scripts|kicia|kiciahook|premium|license|licenses|key|keys|cheat|cheats|exploit|exploits)\b/;
const SELL_MARKET_RE = /\b(?:price|prices|usd|paypal|cashapp|crypto|cheap|offer|offers|buy|bucks?|dollars?)\b/;
const SELL_PRICE_RE = /(?:^|\s)(?:for\s+)?(?:[$€£]\s*)?\d+(?:\.\d+)?\s*(?:bucks?|dollars?|usd)?(?:\s|$)/;
const SELL_CONTEXT_WINDOW_MS = 2 * 60 * 1000;
const SELL_CONTEXT_MAX_MESSAGES = 3;
const SELL_OFFER_PATTERNS = [
  /\b(?:i am|im|i m)\s+selling\b/,
  /\bfor sale\b/,
  /\bdm (?:me )?(?:to buy|for prices?|for price|if you want to buy)\b/,
  /\bbuy (?:my|from me)\b/,
  /\btaking offers\b/
];
const SELL_ANTI_PATTERNS = [
  /\b(?:stop|dont|don't|do not|no)\s+selling\b/,
  /\b(?:stop|dont|don't|do not|no)\s+sell\b/,
  /\bselling\s+is\s+against\s+rules?\b/,
  /\bsell(?:ing)?\s+is\s+not\s+allowed\b/,
  /\b(?:cant|can't|cannot)\s+sell\b/,
  /\bnot\s+allowed\s+to\s+sell\b/
];
const SELL_NEUTRAL_WORD_RE = /\bresellers?\b/g;
const SELL_BROAD_INTENT_RE = /\b(?:sell|selling|seller|sold)\b/;
const SELL_CONDENSED_INTENT_RE = /(?:s+e+l+l+(?:i+n+g+|e+r+)?)|(?:s+o+l+d+)|(?:w+t+s+)|(?:f+o+r+s+a+l+e+)/;
const SELL_CONDENSED_ITEM_RE = /(?:a+c+c+(?:o+u+n+t+)?)|(?:l+v+l+|l+e+v+e+l+)|(?:c+f+g+|c+o+n+f+i+g+)|(?:e+x+e+c+u+t+o+r+)|(?:s+c+r+i+p+t+)|(?:p+r+e+m+i+u+m+)|(?:l+i+c+e+n+s+e+)|(?:k+e+y+)|(?:k+i+c+i+a+)|(?:k+i+c+i+a+h+o+o+k+)/;
const SELL_STRONG_INTENT_RE = /^(?:(?:i am|im|i m)\s+)?selling\b|^sell\b|^wts\b|^for sale\b/;
const SELL_CONTEXT_NEGATIVE_RE = /\b(?:against rules?|not allowed|selling is|rules say|rule says)\b/;

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

async function tryDeleteMessage(message) {
  if (!message?.delete) {
    return {
      deleted: false,
      reason: "message delete unavailable"
    };
  }

  try {
    await message.delete();
    return {
      deleted: true,
      reason: "deleted"
    };
  } catch (err) {
    return {
      deleted: false,
      reason: err?.message || "delete failed"
    };
  }
}

async function tryTimeoutMessageMember(member, durationMs, reason) {
  if (!member?.timeout || member.moderatable === false) {
    return {
      applied: false,
      reason: "bot cannot moderate that member"
    };
  }

  try {
    await member.timeout(durationMs, reason);
    return {
      applied: true,
      reason: `timed out for ${Math.round(durationMs / 1000)}s`
    };
  } catch (err) {
    return {
      applied: false,
      reason: err?.message || "timeout failed"
    };
  }
}

function buildRecentUserMessageKey(message) {
  if (!message?.guildId || !message?.channelId || !message?.author?.id) return null;
  return `${message.guildId}:${message.channelId}:${message.author.id}`;
}

function hasBypassPermission(message) {
  return hasModerationBypassMessage(message);
}

function isAssertiveStatement(content) {
  const normalized = normalizeText(content);
  if (!normalized) return false;
  return !ASSERTION_EXCLUDE_PATTERNS.some((pattern) => pattern.test(content) || pattern.test(normalized));
}

function normalizeSellingSourceText(content) {
  return String(content || "")
    .toLowerCase()
    .replace(/[@4]/g, "a")
    .replace(/3/g, "e")
    .replace(/[1!|]/g, "l")
    .replace(/0/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(SELL_NEUTRAL_WORD_RE, " ");
}

function buildSellingSpacedText(content) {
  return normalizeSellingSourceText(content)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildSellingCondensedText(content) {
  return normalizeSellingSourceText(content)
    .replace(/[^a-z0-9]+/g, "");
}

function isSellPriceFollowUp(content) {
  const rawLower = String(content || "").toLowerCase().trim();
  if (!rawLower) return false;
  if (rawLower.includes("?")) return false;
  return SELL_PRICE_RE.test(` ${rawLower} `) || /^(?:price|prices|cheap)$/.test(rawLower);
}

function detectSellingSignal(content) {
  const rawLower = String(content || "").toLowerCase();
  const spaced = buildSellingSpacedText(content);
  const condensed = buildSellingCondensedText(content);
  if (!spaced || !condensed) return null;
  if (SELL_ANTI_PATTERNS.some((pattern) => pattern.test(rawLower) || pattern.test(spaced))) return null;

  const hasExplicitOffer = SELL_OFFER_PATTERNS.some((pattern) => pattern.test(spaced));
  const hasBroadSellIntent =
    hasExplicitOffer ||
    SELL_BROAD_INTENT_RE.test(spaced) ||
    SELL_CONDENSED_INTENT_RE.test(condensed);
  const hasItemSignal =
    SELL_ITEM_RE.test(spaced) ||
    SELL_CONDENSED_ITEM_RE.test(condensed);
  const hasMarketSignal =
    SELL_MARKET_RE.test(rawLower) ||
    /\$\s*\d/.test(content) ||
    SELL_PRICE_RE.test(rawLower);

  if (!hasBroadSellIntent) {
    return null;
  }

  return {
    type: "selling",
    reason: hasItemSignal || hasMarketSignal
      ? "sell-related wording detected with sale context"
      : "sell-related wording detected"
  };
}

function detectContextualSellingSignal(messageTexts) {
  if (!Array.isArray(messageTexts) || messageTexts.length < 2) return null;

  const latest = String(messageTexts[messageTexts.length - 1] || "");
  if (!isSellPriceFollowUp(latest)) return null;

  const previousTexts = messageTexts
    .slice(0, -1)
    .map((text) => buildSellingSpacedText(text))
    .filter(Boolean);

  const hasStrongPriorIntent = previousTexts.some((text) =>
    SELL_STRONG_INTENT_RE.test(text) &&
    !SELL_ANTI_PATTERNS.some((pattern) => pattern.test(text)) &&
    !SELL_CONTEXT_NEGATIVE_RE.test(text)
  );

  if (!hasStrongPriorIntent) return null;

  return {
    type: "selling",
    reason: "sell offer completed across recent messages"
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

function pruneRecentUserMessages(now = Date.now()) {
  for (const [key, entry] of recentUserMessages.entries()) {
    entry.messages = entry.messages.filter((message) => now - message.at <= SELL_CONTEXT_WINDOW_MS);
    if (!entry.messages.length) recentUserMessages.delete(key);
  }
}

function rememberRecentUserMessage(message, now = Date.now()) {
  const key = buildRecentUserMessageKey(message);
  if (!key) return [String(message?.content || "")];

  pruneRecentUserMessages(now);
  const entry = recentUserMessages.get(key) || { messages: [] };
  entry.messages.push({
    at: now,
    content: String(message.content || "")
  });
  if (entry.messages.length > SELL_CONTEXT_MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-SELL_CONTEXT_MAX_MESSAGES);
  }
  recentUserMessages.set(key, entry);
  return entry.messages.map((item) => item.content);
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
  if (signals.some((signal) => signal.type === "blocked_link")) return "Blocked Link Alert";
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

function buildBlockedLinkTimeoutPayload({ message, signal, durationMs }) {
  const shownLinks = signal.blockedLinks
    .slice(0, 3)
    .map((entry) => `- ${entry.raw}`)
    .join("\n");

  return {
    embeds: [
      buildPanel({
        header: "Link Timeout",
        body: [
          "you sent a link that isn't on the approved docs allowlist",
          `**Timeout:** ${Math.round(durationMs / 1000)}s`,
          `**Channel:** <#${message.channelId}>`,
          "**Blocked Link(s):**",
          shownLinks,
          "tenor gifs and links already listed in docs are allowed"
        ].join("\n"),
        color: WARN
      })
    ]
  };
}

function buildBlockedLinkLogPanel({ message, signal, deleteResult, timeoutResult, dmSent, durationMs }) {
  const link = buildMessageUrl(message);
  const shownLinks = signal.blockedLinks
    .slice(0, 5)
    .map((entry) => `- ${entry.raw}`)
    .join("\n");

  return {
    header: timeoutResult.applied ? "Blocked Link Timeout" : "Blocked Link Alert",
    body: [
      timeoutResult.applied
        ? "link guard triggered and action was applied"
        : "link guard triggered, but the action did not fully apply",
      `**User:** <@${message.author?.id}>`,
      `**Channel:** <#${message.channelId}>`,
      `**Action:** delete ${deleteResult.deleted ? "ok" : deleteResult.reason} | timeout ${
        timeoutResult.applied ? `${Math.round(durationMs / 1000)}s` : timeoutResult.reason
      } | dm ${dmSent ? "sent" : "not sent"}`,
      `**Policy:** only docs-listed links and tenor gifs are allowed`,
      `**Blocked Link Count:** ${signal.blockedCount}`,
      "**Blocked Link(s):**",
      shownLinks,
      `**Message Excerpt:** ${trimExcerpt(message.content)}`
    ].filter(Boolean).join("\n\n"),
    tip: link ? `[Open message](${link})` : undefined,
    tipStyle: "heading",
    tipLevel: "##",
    color: timeoutResult.applied ? DANGER : WARN
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

function mightContainLink(content) {
  return extractUrlsFromText(content).length > 0;
}

async function handleBlockedLinkMessage(message, signal, { sendLog = sendLogPanel, timeoutMs = LINK_MODERATION_TIMEOUT_MS } = {}) {
  const deleteResult = await tryDeleteMessage(message);
  const timeoutResult = await tryTimeoutMessageMember(message.member, timeoutMs, "unapproved link");
  const dmSent = timeoutResult.applied
    ? await safeSend(message.author, buildBlockedLinkTimeoutPayload({
        message,
        signal,
        durationMs: timeoutMs
      }))
    : false;

  if (!deleteResult.deleted) {
    recordRuntimeEvent("warn", "blocked-link-delete", deleteResult.reason);
  }
  if (!timeoutResult.applied) {
    recordRuntimeEvent("warn", "blocked-link-timeout", timeoutResult.reason);
  }

  await sendLog(message.guild, buildBlockedLinkLogPanel({
    message,
    signal,
    deleteResult,
    timeoutResult,
    dmSent,
    durationMs: timeoutMs
  })).catch(() => null);

  return true;
}

async function maybeHandleModerationWatch(message, {
  kb,
  runtimeStatus,
  fetchKbFn = fetchKb,
  sendLog = sendLogPanel
} = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return false;
  if (hasBypassPermission(message)) return false;

  try {
    const recentMessages = rememberRecentUserMessage(message);
    let resolvedKb = kb || null;
    const hasLink = mightContainLink(message.content);
    if (!resolvedKb && (hasLink || mightContainFakeInfo(message.content))) {
      resolvedKb = await fetchKbFn().catch(() => null);
    }

    if (hasLink && resolvedKb) {
      const blockedLinkSignal = detectBlockedLinkSignal(message.content, { kb: resolvedKb });
      if (blockedLinkSignal) {
        await handleBlockedLinkMessage(message, blockedLinkSignal, { sendLog });
        return true;
      }
    }

    const signals = collectContentSignals(message.content, {
      kb: resolvedKb,
      runtimeStatus: runtimeStatus || getRuntimeStatus()
    });

    if (!signals.some((signal) => signal.type === "selling")) {
      const contextualSellingSignal = detectContextualSellingSignal(recentMessages);
      if (contextualSellingSignal) {
        signals.push(contextualSellingSignal);
      }
    }

    if (signals.length) {
      await sendLog(message.guild, buildSignalAlertPanel(message, signals));
    }

    const raidAlert = observeRaidMessage(message);
    if (raidAlert) {
      await sendLog(message.guild, buildRaidAlertPanel(message, raidAlert));
    }
  } catch (err) {
    console.warn("Moderation watcher failed:", err.message);
    recordRuntimeEvent("warn", "moderation-watch", err?.message || err);
  }

  return false;
}

function resetModerationState() {
  raidBuckets.clear();
  lastRaidAlertAt.clear();
  recentUserMessages.clear();
}

module.exports = {
  detectSellingSignal,
  detectContextualSellingSignal,
  detectSuspiciousSignal,
  detectFakeInfoSignal,
  detectBlockedLinkSignal,
  collectContentSignals,
  hasBypassPermission,
  observeRaidMessage,
  resetModerationState,
  maybeHandleModerationWatch
};
