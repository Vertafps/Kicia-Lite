const {
  LINK_MODERATION_TIMEOUT_MS,
  NEW_ACCOUNT_LINK_SCRUTINY_MS,
  NEW_MEMBER_LINK_SCRUTINY_MS,
  RAID_WINDOW_MS,
  RAID_MIN_DISTINCT_USERS,
  RAID_ALERT_COOLDOWN_MS,
  SUSPICIOUS_ALERT_WINDOW_MS,
  SUSPICIOUS_WARNING_THRESHOLD,
  SUSPICIOUS_TIMEOUT_THRESHOLD,
  SUSPICIOUS_TIMEOUT_MS,
  SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD,
  SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_MS,
  SELLING_CONFIDENCE_TIMEOUT_THRESHOLD,
  SELLING_LOW_CONFIDENCE_THRESHOLD,
  SELLING_REPEAT_WINDOW_MS,
  SELLING_REPEAT_TIMEOUT_THRESHOLD,
  SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD,
  SELLING_TIMEOUT_MS
} = require("../config");
const { formatDuration } = require("../duration");
const { buildPanel, DANGER, WARN } = require("../embed");
const { fetchKb } = require("../kb");
const { detectBlockedLinkSignal, detectBlockedLinkSignalAsync, extractUrlsFromText } = require("../link-policy");
const { sendLogPanel } = require("../log-channel");
const { hasModerationBypassMessage } = require("../permissions");
const {
  isModerationWhitelistedUser,
  listTrustedLinks,
  recordDailyModerationEvent,
  recordScamDecisionAudit
} = require("../restricted-emoji-db");
const { recordRuntimeEvent } = require("../runtime-health");
const { getRuntimeStatus } = require("../runtime-status");
const { classifyScamContextWithGemini } = require("../scam-ai");
const {
  classifyScamContextLocally,
  isExplanationResponseIntent,
  isKiciaLegitPurchaseIntent,
  isSafePurchaseMethodQuestion
} = require("../scam-local-classifier");
const { cleanText, normalizeText } = require("../text");
const { safeReply, safeSend } = require("../utils/respond");

const raidBuckets = new Map();
const lastRaidAlertAt = new Map();
const recentUserMessages = new Map();
const suspiciousUserBuckets = new Map();
const sellingUserBuckets = new Map();

const SELL_ITEM_RE = /\b(?:acc|account|accounts|lvl|level|configuration|config|configs|cfg|cfgs|executor|executors|script|scripts|kicia|kiciahook|premium|license|licenses|key|keys|cheat|cheats|exploit|exploits|robux|nitro)\b/;
const SELL_MARKET_RE = /\b(?:price|prices|usd|paypal|cashapp|crypto|cheap|offer|offers|buy|buyer|buying|bucks?|dollars?|trade|trades|trading|swap|swapping|exchange|middleman|mm)\b/;
const SELL_PRICE_RE = /(?:^|\s)(?:for\s+)?(?:[$\u20ac\u00a3]\s*)?\d+(?:\.\d+)?\s*(?:bucks?|dollars?|usd)?(?:\s|$)/;
const SELL_CONTEXT_WINDOW_MS = 2 * 60 * 1000;
const SELL_CONTEXT_MAX_MESSAGES = 5;
const SELL_OFFER_PATTERNS = [
  /\b(?:i am|im|i m)\s+selling\b/,
  /\b(?:i am|im|i m)\s+trading\b/,
  /\b(?:i am|im|i m)\s+buying\b/,
  /\bfor sale\b/,
  /\bdm (?:me )?(?:to buy|for prices?|for price|if you want to buy)\b/,
  /\bbuy (?:my|from me)\b/,
  /\btaking offers\b/,
  /\bwts\b/,
  /\bwtb\b/
];
const SELL_ANTI_PATTERNS = [
  /\b(?:stop|dont|don't|do not|no)\s+selling\b/,
  /\b(?:stop|dont|don't|do not|no)\s+sell\b/,
  /\bselling\s+is\s+against\s+rules?\b/,
  /\bsell(?:ing)?\s+is\s+not\s+allowed\b/,
  /\b(?:cant|can't|cannot)\s+sell\b/,
  /\bnot\s+allowed\s+to\s+sell\b/,
  /\b(?:is\s+this|is\s+that|are\s+these)\s+allowed\b/,
  /\b(?:someone|somebody|user|person|people|they|he|she)\b.{0,60}\b(?:said|says|asked|told|selling|trading|scamming)\b.{0,60}\b(?:allowed|rules?|report)\b/
];
const SELL_NEUTRAL_WORD_RE = /\bresellers?\b/g;
const SELL_BROAD_INTENT_RE = /\b(?:sell|selling|seller|sold|buy|buying|buyer|trade|trading|trader|swap|swapping|exchange|scam|scamming)\b/;
const SELL_CONDENSED_INTENT_RE = /(?:s+e+l+l+(?:i+n+g+|e+r+)?)|(?:s+o+l+d+)|(?:b+u+y+(?:i+n+g+)?)|(?:t+r+a+d+(?:i+n+g+|e+r+)?)|(?:s+w+a+p+)|(?:w+t+s+)|(?:w+t+b+)|(?:f+o+r+s+a+l+e+)/;
const SELL_CONDENSED_ITEM_RE = /(?:a+c+c+(?:o+u+n+t+)?)|(?:l+v+l+|l+e+v+e+l+)|(?:c+f+g+|c+o+n+f+i+g+)|(?:e+x+e+c+u+t+o+r+)|(?:s+c+r+i+p+t+)|(?:p+r+e+m+i+u+m+)|(?:l+i+c+e+n+s+e+)|(?:k+e+y+)|(?:k+i+c+i+a+)|(?:k+i+c+i+a+h+o+o+k+)/;
const SELL_STRONG_INTENT_RE = /^(?:(?:i am|im|i m)\s+)?(?:selling|trading|buying)\b|^(?:sell|trade|buy)\b|^(?:wts|wtb)\b|^for sale\b/;
const SELL_CONTEXT_NEGATIVE_RE = /\b(?:against rules?|not allowed|selling is|trading is|buying is|rules say|rule says|scammer|scamming is|report scam|avoid scam)\b/;
const PRIVATE_HANDOFF_RE = /\b(?:dm|dms|pm|pms|private|privately|message me|msg me|inbox|add me)\b/;
const MARKET_QUESTION_RE = /^(?:anyone|who|where|can i|am i allowed|is it allowed|do you|does anyone)\b/;

const SUSPICIOUS_PATTERNS = [
  {
    label: "credential-request",
    pattern: /\b(?:send|give|share|paste)\s+(?:me\s+)?(?:your\s+)?(?:password|token|cookie|cookies|login|2fa|mfa|otp|code)\b/,
    reason: "asking for private account credentials",
    confidence: 98
  },
  {
    label: "private-more-info",
    pattern: /\b(?:more|extra|other)\s+(?:stuff|info|details|links?|files?)\b.*\b(?:dm|pm|message|msg)\s+me\b/,
    reason: "moving extra details into private messages",
    confidence: 86
  },
  {
    label: "dm-link-offer",
    pattern: /\b(?:dm|pm|message|msg)\s+me\s+for\s+(?:the\s+|a\s+)?(?:link|download|invite|crack|leak|file|script|executor|key|account|config)\b/,
    reason: "offering links privately",
    confidence: 93
  },
  {
    label: "cracked-or-leaked",
    pattern: /\b(?:cracked|leaked)\s+(?:kicia|kiciahook|premium)\b/,
    reason: "mentioning cracked or leaked product access",
    confidence: 96
  },
  {
    label: "paste-this",
    pattern: /\b(?:paste|run|download)\s+this\b/,
    reason: "asking users to run, download, or paste unknown content",
    confidence: 92
  },
  {
    label: "free-premium",
    pattern: /\bfree premium\b/,
    reason: "claiming free premium access",
    confidence: 91
  },
  {
    label: "account-report-scam",
    pattern: /\b(?:accidentally|mistakenly)\s+reported\s+(?:you|your\s+account|ur\s+account)\b/,
    reason: "using the accidental-report account scam wording",
    confidence: 94
  },
  {
    label: "account-urgency",
    pattern: /\b(?:your\s+)?(?:account|profile)\s+(?:will\s+be\s+)?(?:deleted|disabled|suspended|terminated|locked)\b.*\b(?:verify|appeal|contact|dm|message|link)\b/,
    reason: "pressuring a user to verify or appeal an account issue",
    confidence: 90
  },
  {
    label: "qr-or-oauth-steering",
    pattern: /\b(?:scan\s+(?:this\s+)?qr|oauth|authorize\s+(?:this\s+)?(?:bot|app|application))\b/,
    reason: "steering users into QR or OAuth authorization flow",
    confidence: 88
  }
];
const SUSPICIOUS_ANTI_PATTERNS = [
  /\b(?:don t|dont|do not|stop)\s+(?:dm|pm|message|msg)\s+me\b/,
  /\b(?:don t|dont|do not|never)\s+(?:paste|run|download|click|open)\s+this\b/,
  /\b(?:watch|avoid|report)\s+(?:the\s+)?(?:accidental|account)\s+report\s+scam\b/,
  /\b(?:never|do not|dont|don t)\s+(?:scan|use)\s+(?:a\s+)?qr\b/,
  /\b(?:never|do not|dont|don t)\s+(?:authorize|oauth)\b/
];
const SUSPICIOUS_PUBLIC_REPLIES_BY_HIT = [
  [
    "hmm interesting...",
    "ok vro...",
    "curious little sentence...",
    "ah yes, extremely normal behavior...",
    "that wording is doing gymnastics...",
    "the sus meter coughed once...",
    "that sentence wore sunglasses indoors...",
    "tiny red flag doing pushups..."
  ],
  [
    "ahh totally not sus...",
    "ok now you're collecting suspicion points...",
    "that is two eyebrow raises now...",
    "the plot is getting suspicious...",
    "second verse, same strange chorus...",
    "the sus meter is now standing up...",
    "that sequel did not help your case...",
    "chat, the vibes filed a complaint..."
  ],
  [
    "okay that is getting very sus...",
    "and that's the hat trick...",
    "three suspicious laps around the track...",
    "ok vro, timeout weather...",
    "that one completed the sus trilogy...",
    "the sus meter has left the building...",
    "that was the final boss of strange wording...",
    "case file says: please take a walk..."
  ]
];
const SELLING_PUBLIC_REPLIES = [
  "scam radar blinked...",
  "private-deal energy spotted...",
  "that offer looked risky...",
  "ok vro this deal stays out of chat...",
  "trade-risk check passed the threshold...",
  "that pitch looked a little too slick...",
  "unsafe deal aura detected...",
  "checkout lane closed...",
  "that sounded like scam/trade bait...",
  "not the trading floor...",
  "deal greeter denied that one at the door...",
  "the trade cart failed inspection...",
  "private-sale alarm made a funny noise...",
  "this deal tried to sneak in wearing a fake mustache...",
  "marketplace cosplay detected...",
  "the scam/trade scanner did a backflip..."
];
const ROASTING_PATTERNS = [
  /\b(?:bro|blud|vro|lil bro)\s+(?:got\s+)?(?:cooked|roasted|fried|smoked|destroyed|packed)\b/,
  /\b(?:someone|somebody|some1|bro|blud|vro|lil bro)\s+(?:is\s+)?(?:getting\s+)?(?:cooked|roasted|fried|smoked|destroyed|packed)\b/,
  /\b(?:get|got|getting|is|are|was|were)\s+(?:absolutely\s+)?(?:cooked|roasted|fried|smoked|destroyed|packed)\b/,
  /\b(?:cook|cooked|cooking|roast|roasted|roasting)\s+(?:him|her|them|that|this|bro|blud|vro|lil bro)\b/,
  /\b(?:skill issue|ratio|you fell off|washed|pack watch|hold this l)\b/,
  /\b(?:clown|bozo)\s+(?:moment|behavior|energy|activity)\b/,
  /\b(?:you|u|he|she|they|bro|blud|vro|lil bro)\s+(?:are|re|is|a|an)?\s*(?:npc|bot|bots?)\s+(?:anyways?|fr|ngl|lol|lmao)?\b/,
  /\b(?:npc|bot)\s+(?:behavior|activity|energy|moment)\b/,
  /\bhopping\s+from\s+one\s+to\s+another\b/,
  /\balways\s+the\s+same\s+(?:sht|shit|thing|bs)\b/,
  /\bsame\s+(?:sht|shit|bs)\b/
];
const ROASTING_IGNORE_PATTERNS = [
  /\b(?:cook|cooked|cooking)\s+(?:food|meal|dinner|lunch|breakfast|rice|chicken|pizza|recipe)\b/,
  /\broast(?:ed|ing)?\s+(?:coffee|beans|chicken|beef|pork|potatoes)\b/
];
const ROASTING_PUBLIC_REPLIES = [
  "oohh we got a lil roasting going on here...",
  "is someone getting cooked?",
  "hold up, the kitchen is getting warm...",
  "chat is preheating rn...",
  "that sounded like a tiny cookout...",
  "someone brought seasoning to the conversation...",
  "ok vro, that one had heat...",
  "the roast meter just blinked...",
  "small flame detected...",
  "this chat got a little crispy...",
  "that one came with roast marks...",
  "the heat in here gained two levels...",
  "lightly cooked conversation detected...",
  "that reply brought its own kitchen pan..."
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

function buildSuspiciousUserKey(message) {
  if (!message?.guildId || !message?.author?.id) return null;
  return `${message.guildId}:${message.author.id}`;
}

function buildSellingUserKey(message) {
  if (!message?.guildId || !message?.author?.id) return null;
  return `${message.guildId}:${message.author.id}`;
}

function hasBypassPermission(message) {
  return hasModerationBypassMessage(message);
}

async function hasManualWhitelistBypass(message) {
  const userId = message?.author?.id;
  if (!userId) return false;

  try {
    return await isModerationWhitelistedUser(userId);
  } catch (err) {
    recordRuntimeEvent("warn", "moderation-whitelist-check", err?.message || err);
    return false;
  }
}

function getPosterLinkContext(message, now = Date.now()) {
  const userCreatedAt = Number(message?.author?.createdTimestamp || 0);
  const memberJoinedAt = Number(message?.member?.joinedTimestamp || 0);
  const accountAgeMs = userCreatedAt > 0 ? now - userCreatedAt : null;
  const memberAgeMs = memberJoinedAt > 0 ? now - memberJoinedAt : null;

  return {
    accountAgeMs,
    memberAgeMs,
    isNewAccount: Number.isFinite(accountAgeMs) && accountAgeMs >= 0 && accountAgeMs < NEW_ACCOUNT_LINK_SCRUTINY_MS,
    isNewMember: Number.isFinite(memberAgeMs) && memberAgeMs >= 0 && memberAgeMs < NEW_MEMBER_LINK_SCRUTINY_MS
  };
}

async function recordModerationStat(eventKey, now = Date.now()) {
  try {
    await recordDailyModerationEvent(eventKey, { at: now });
  } catch (err) {
    recordRuntimeEvent("warn", "daily-moderation-track", err?.message || err);
  }
}

function buildLocalAuditResult(localResult) {
  if (!localResult) return null;
  return {
    verdict: localResult.verdict,
    answer: localResult.verdict === true ? "TRUE" : localResult.verdict === false ? "FALSE" : "BORDERLINE",
    model: localResult.model || "local classifier",
    reason: localResult.reason || null,
    confidence: localResult.confidence,
    score: localResult.score
  };
}

async function recordScamAudit(message, {
  action,
  handled,
  signals,
  strongest,
  scamContext,
  localResult,
  aiResult,
  now = Date.now()
} = {}) {
  const candidate = strongest || signals?.[0] || null;
  try {
    await recordScamDecisionAudit({
      createdAt: now,
      guildId: message.guildId || message.guild?.id || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      userId: message.author?.id || null,
      action,
      handled,
      candidateReason: candidate?.reason || null,
      candidateConfidence: candidate?.confidence || null,
      local: buildLocalAuditResult(localResult),
      ai: aiResult || null,
      messageContent: message.content || "",
      replyContent: scamContext?.repliedToMessage?.content || "",
      recentMessages: scamContext?.userMessages || []
    });
  } catch (err) {
    recordRuntimeEvent("warn", "scam-audit", err?.message || err);
  }
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

function clampConfidence(value) {
  return Math.max(1, Math.min(99, Math.round(Number(value) || 1)));
}

function scoreSellingConfidence({
  content,
  spaced,
  condensed,
  hasExplicitOffer,
  hasBroadSellIntent,
  hasItemSignal,
  hasMarketSignal
}) {
  if (!hasBroadSellIntent) return 0;

  const raw = String(content || "");
  const rawLower = raw.toLowerCase();
  const hasQuestionTone =
    raw.includes("?") ||
    MARKET_QUESTION_RE.test(spaced);
  const hasStrongIntent =
    SELL_STRONG_INTENT_RE.test(spaced) ||
    /\b(?:wts|wtb)\b/.test(spaced) ||
    /f+o+r+s+a+l+e+/.test(condensed);
  const hasCondensedIntent = SELL_CONDENSED_INTENT_RE.test(condensed);
  const hasPriceSignal = /\$\s*\d/.test(raw) || SELL_PRICE_RE.test(rawLower);
  const hasPrivateTradeSignal =
    PRIVATE_HANDOFF_RE.test(spaced) &&
    /\b(?:buy|price|prices|offer|offers|account|script|config|key|premium)\b/.test(spaced);

  let score = 35;
  if (hasExplicitOffer) score += 25;
  if (hasStrongIntent) score += 20;
  if (hasItemSignal) score += 18;
  if (hasMarketSignal) score += 15;
  if (hasPriceSignal) score += 20;
  if (hasCondensedIntent && !hasStrongIntent) score += 10;
  if (hasPrivateTradeSignal) score += 12;
  if (hasQuestionTone) score -= 35;
  if (MARKET_QUESTION_RE.test(spaced)) score -= 15;

  return clampConfidence(score);
}

function detectSellingSignal(content) {
  const rawLower = String(content || "").toLowerCase();
  const spaced = buildSellingSpacedText(content);
  const condensed = buildSellingCondensedText(content);
  if (!spaced || !condensed) return null;
  if (SELL_ANTI_PATTERNS.some((pattern) => pattern.test(rawLower) || pattern.test(spaced))) return null;
  if (isKiciaLegitPurchaseIntent([content])) return null;
  if (isSafePurchaseMethodQuestion([content])) return null;

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
  const hasPriceSignal = /\$\s*\d/.test(content) || SELL_PRICE_RE.test(rawLower);
  const hasQuestionTone = rawLower.includes("?") || MARKET_QUESTION_RE.test(spaced);
  const hasPrivateHandoff = PRIVATE_HANDOFF_RE.test(spaced);
  const hasStrongIntent =
    SELL_STRONG_INTENT_RE.test(spaced) ||
    /\b(?:wts|wtb)\b/.test(spaced) ||
    /f+o+r+s+a+l+e+/.test(condensed);

  if (!hasBroadSellIntent) {
    return null;
  }

  // Single words like "selling" or loose questions are context candidates,
  // not deterministic moderation events.
  if (!hasExplicitOffer && !hasItemSignal && !hasMarketSignal && !hasPrivateHandoff) {
    return null;
  }
  if (hasQuestionTone && !hasPrivateHandoff && !SELL_PRICE_RE.test(rawLower)) {
    return null;
  }
  if (!hasExplicitOffer && !hasPrivateHandoff && !(hasItemSignal && (hasMarketSignal || hasStrongIntent)) && !(hasPriceSignal && hasStrongIntent)) {
    return null;
  }

  return {
    type: "selling",
    source: "local",
    confidence: scoreSellingConfidence({
      content,
      spaced,
      condensed,
      hasExplicitOffer,
      hasBroadSellIntent,
      hasItemSignal,
      hasMarketSignal
    }),
    reason: hasItemSignal || hasMarketSignal
      ? "sell-related wording detected with sale context"
      : "sell-related wording detected"
  };
}

function getScamTradeTextFeatures(text) {
  const rawLower = String(text || "").toLowerCase();
  const spaced = buildSellingSpacedText(text);
  const condensed = buildSellingCondensedText(text);
  const tokens = spaced.split(/\s+/).filter(Boolean);
  const intentTokens = new Set(["sell", "selling", "seller", "sold", "buy", "buying", "buyer", "trade", "trading", "trader", "swap", "swapping", "exchange", "exchanging", "give", "giving", "offer", "offering", "wts", "wtb", "for", "sale"]);
  const objectishTokens = tokens.filter((token) => !intentTokens.has(token) && token.length > 1);
  const hasPriceSignal = /\$\s*\d/.test(text) || SELL_PRICE_RE.test(rawLower);
  const hasDeicticDealSignal = /\b(?:this|that|it|one|thing|stuff|something)\b/.test(spaced);
  const hasBarterSignal =
    /\b(?:trade|trading|swap|swapping|exchange|exchanging|give|giving|offer|offering)\b.{0,80}\bfor\b/.test(spaced);
  const hasPrivateHandoff = PRIVATE_HANDOFF_RE.test(spaced);
  const hasOfferTone = /\b(?:you|u)\s+want\b/.test(spaced) || /\b(?:want|need)\s+(?:it|this|one)\b/.test(spaced);
  const hasPrivatePurchaseSignal =
    hasPrivateHandoff &&
    /\b(?:buy|buying|purchase|price|prices|pay|payment|get|sell|selling|offer|offers)\b/.test(spaced) &&
    (SELL_ITEM_RE.test(spaced) || hasDeicticDealSignal);
  const hasPrivateOfferSignal =
    hasPrivateHandoff &&
    hasOfferTone &&
    (SELL_ITEM_RE.test(spaced) || hasDeicticDealSignal);
  return {
    rawLower,
    spaced,
    condensed,
    tokens,
    hasAnti: SELL_ANTI_PATTERNS.some((pattern) => pattern.test(rawLower) || pattern.test(spaced)) ||
      SELL_CONTEXT_NEGATIVE_RE.test(spaced),
    hasExplicitOffer: SELL_OFFER_PATTERNS.some((pattern) => pattern.test(spaced)),
    hasBroadIntent: SELL_BROAD_INTENT_RE.test(spaced) || SELL_CONDENSED_INTENT_RE.test(condensed),
    hasItemSignal: SELL_ITEM_RE.test(spaced) || SELL_CONDENSED_ITEM_RE.test(condensed),
    hasMarketSignal: SELL_MARKET_RE.test(rawLower) || hasPriceSignal,
    hasPriceSignal,
    hasPrivateHandoff,
    hasPrivatePurchaseSignal,
    hasPrivateOfferSignal,
    hasBarterSignal,
    hasDeicticDealSignal,
    hasQuestionTone: String(text || "").includes("?") || MARKET_QUESTION_RE.test(spaced),
    hasOfferTone,
    hasObjectishSignal: objectishTokens.length > 0
  };
}

function detectScamTradeCandidateContext(messageTexts, repliedToMessage = null) {
  const texts = (Array.isArray(messageTexts) ? messageTexts : [])
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .slice(-SELL_CONTEXT_MAX_MESSAGES);
  if (!texts.length) return null;
  if (isKiciaLegitPurchaseIntent(texts)) return null;
  if (isSafePurchaseMethodQuestion(texts, repliedToMessage)) return null;
  if (isExplanationResponseIntent(texts, repliedToMessage)) return null;

  const combined = texts.join("\n");
  const combinedFeatures = getScamTradeTextFeatures(combined);
  if (combinedFeatures.hasAnti) return null;

  const latest = texts[texts.length - 1] || "";
  const latestFeatures = getScamTradeTextFeatures(latest);
  const previousFeatures = texts.slice(0, -1).map(getScamTradeTextFeatures);
  const latestHasDealDetail =
    latestFeatures.hasItemSignal ||
    latestFeatures.hasPriceSignal ||
    latestFeatures.hasPrivateHandoff ||
    latestFeatures.hasOfferTone ||
    latestFeatures.hasPrivatePurchaseSignal ||
    latestFeatures.hasPrivateOfferSignal ||
    latestFeatures.hasBarterSignal;
  const referenceText = repliedToMessage?.content || "";
  const referenceFeatures = getScamTradeTextFeatures(referenceText);
  const referenceAsksForLink =
    /\b(?:where|send|give|drop|link|download|site|get)\b/.test(referenceFeatures.spaced) &&
    /\b(?:link|download|executor|script|key|config|account|acc|site)\b/.test(referenceFeatures.spaced);

  if (
    latestFeatures.hasPrivateHandoff &&
    (referenceAsksForLink || referenceFeatures.hasItemSignal || referenceFeatures.hasMarketSignal)
  ) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: 72,
      reason: "private DM handoff in reply to a link/trade/support request"
    };
  }

  if (combinedFeatures.hasPrivatePurchaseSignal) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasItemSignal ? 86 : 74,
      reason: "private buy/sell handoff detected in recent message context"
    };
  }

  if (combinedFeatures.hasPrivateOfferSignal) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasItemSignal ? 82 : 72,
      reason: "private item/trade offer detected in recent message context"
    };
  }

  if (combinedFeatures.hasBarterSignal && (combinedFeatures.hasItemSignal || combinedFeatures.hasDeicticDealSignal)) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasItemSignal ? 82 : 64,
      reason: "possible barter/trade intent in recent message context"
    };
  }

  const splitIntentAndItem =
    texts.length >= 2 &&
    (
      previousFeatures.some((features) => features.hasBroadIntent || features.hasExplicitOffer) &&
      latestHasDealDetail
    );
  if (splitIntentAndItem) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: 76,
      reason: "possible scam/trade offer split across recent messages"
    };
  }

  if (
    combinedFeatures.hasBroadIntent &&
    (
      combinedFeatures.hasItemSignal ||
      combinedFeatures.hasPriceSignal ||
      combinedFeatures.hasPrivateHandoff ||
      combinedFeatures.hasOfferTone
    )
  ) {
    return {
      type: "selling",
      source: "context",
      requiresAi: true,
      confidence: combinedFeatures.hasPriceSignal || combinedFeatures.hasPrivateHandoff ? 86 : combinedFeatures.hasQuestionTone ? 54 : 72,
      reason: "possible scam/trade intent in recent message context"
    };
  }

  return null;
}

function detectContextualSellingSignal(messageTexts, repliedToMessage = null) {
  if (!Array.isArray(messageTexts) || !messageTexts.length) return null;

  const latest = String(messageTexts[messageTexts.length - 1] || "");
  if (!isSellPriceFollowUp(latest)) {
    return detectScamTradeCandidateContext(messageTexts, repliedToMessage);
  }

  const previousTexts = messageTexts
    .slice(0, -1)
    .map((text) => buildSellingSpacedText(text))
    .filter(Boolean);

  const hasStrongPriorIntent = previousTexts.some((text) =>
    SELL_STRONG_INTENT_RE.test(text) &&
    !SELL_ANTI_PATTERNS.some((pattern) => pattern.test(text)) &&
    !SELL_CONTEXT_NEGATIVE_RE.test(text)
  );

  if (!hasStrongPriorIntent) return detectScamTradeCandidateContext(messageTexts, repliedToMessage);

  return {
    type: "selling",
    source: "context",
    requiresAi: true,
    confidence: 86,
    reason: "sell offer completed across recent messages"
  };
}

function detectSuspiciousSignal(content) {
  const normalized = normalizeText(content);
  if (!normalized) return null;
  if (SUSPICIOUS_ANTI_PATTERNS.some((pattern) => pattern.test(normalized))) return null;

  for (const candidate of SUSPICIOUS_PATTERNS) {
    if (candidate.pattern.test(normalized)) {
      return {
        type: "suspicious",
        reason: candidate.reason,
        label: candidate.label,
        confidence: candidate.confidence || 75
      };
    }
  }

  return null;
}

function detectRoastingSignal(content) {
  const normalized = normalizeText(content);
  if (!normalized) return null;
  if (ROASTING_IGNORE_PATTERNS.some((pattern) => pattern.test(normalized))) return null;

  for (const pattern of ROASTING_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        type: "roasting",
        reason: "playful roast-like wording detected"
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

function pruneSuspiciousUserState(now = Date.now()) {
  for (const [key, entry] of suspiciousUserBuckets.entries()) {
    entry.events = entry.events.filter((event) => now - event.at <= SUSPICIOUS_ALERT_WINDOW_MS);
    if (!entry.events.length) suspiciousUserBuckets.delete(key);
  }
}

function pruneSellingUserState(now = Date.now()) {
  for (const [key, entry] of sellingUserBuckets.entries()) {
    entry.events = entry.events.filter((event) => now - event.at <= SELLING_REPEAT_WINDOW_MS);
    if (!entry.events.length) sellingUserBuckets.delete(key);
  }
}

function getSuspiciousAction({ count, confidence }) {
  if (confidence > SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD) return "timeout";
  if (count >= SUSPICIOUS_TIMEOUT_THRESHOLD) return "timeout";
  if (count >= SUSPICIOUS_WARNING_THRESHOLD) return "warn";
  return "alert";
}

function pickPublicReplyLine(lines) {
  if (!Array.isArray(lines) || !lines.length) return "";
  return lines[Math.floor(Math.random() * lines.length)] || lines[0];
}

function buildSuspiciousPublicReply(state) {
  const displayCount = state?.highConfidence ? SUSPICIOUS_TIMEOUT_THRESHOLD : state?.count || 1;
  const hit = Math.max(1, Math.min(displayCount, SUSPICIOUS_TIMEOUT_THRESHOLD));
  const line = pickPublicReplyLine(SUSPICIOUS_PUBLIC_REPLIES_BY_HIT[hit - 1]);
  return `${line} (${hit}/${SUSPICIOUS_TIMEOUT_THRESHOLD})`;
}

function buildSellingPublicReply() {
  return pickPublicReplyLine(SELLING_PUBLIC_REPLIES);
}

function buildRoastingPublicReply() {
  return pickPublicReplyLine(ROASTING_PUBLIC_REPLIES);
}

async function tryReplyModerationMessage(message, content, replyType) {
  const sent = await safeReply(message, {
    content,
    allowedMentions: { repliedUser: false }
  }).catch((err) => {
    recordRuntimeEvent("warn", `${replyType}-public-reply`, err?.message || err);
    return false;
  });

  return Boolean(sent);
}

function rememberSuspiciousMessage(message, signals, now = Date.now()) {
  const key = buildSuspiciousUserKey(message);
  const confidence = getMaxSignalConfidence(signals);
  const highConfidence = confidence > SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD;
  if (!key) {
    return {
      count: 1,
      confidence,
      highConfidence,
      action: highConfidence ? "timeout" : "alert",
      trigger: highConfidence
        ? `confidence ${confidence}% > ${SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD}%`
        : "below immediate-timeout confidence",
      events: []
    };
  }

  pruneSuspiciousUserState(now);
  const entry = suspiciousUserBuckets.get(key) || { events: [] };
  entry.events.push({
    at: now,
    channelId: message.channelId,
    messageId: message.id,
    url: buildMessageUrl(message),
    confidence,
    reasons: signals.map((signal) => signal.reason)
  });
  entry.events = entry.events.slice(-Math.max(SUSPICIOUS_TIMEOUT_THRESHOLD + 2, 5));
  suspiciousUserBuckets.set(key, entry);

  return {
    count: entry.events.length,
    confidence,
    highConfidence,
    action: getSuspiciousAction({ count: entry.events.length, confidence }),
    trigger: highConfidence
      ? `confidence ${confidence}% > ${SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_THRESHOLD}%`
      : entry.events.length >= SUSPICIOUS_TIMEOUT_THRESHOLD
        ? `${entry.events.length} in ${formatDuration(SUSPICIOUS_ALERT_WINDOW_MS)}`
        : "below immediate-timeout confidence",
    events: [...entry.events]
  };
}

function getMaxSignalConfidence(signals) {
  return Math.max(
    0,
    ...(signals || []).map((signal) => Number(signal.confidence || 0))
  );
}

function getSellingRepeatThreshold(confidence) {
  return confidence < SELLING_LOW_CONFIDENCE_THRESHOLD
    ? SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD
    : SELLING_REPEAT_TIMEOUT_THRESHOLD;
}

function rememberSellingMessage(message, signals, now = Date.now()) {
  const confidence = getMaxSignalConfidence(signals);
  const highConfidence = confidence > SELLING_CONFIDENCE_TIMEOUT_THRESHOLD;
  const repeatThreshold = getSellingRepeatThreshold(confidence);
  const key = buildSellingUserKey(message);

  if (!key) {
    return {
      count: 1,
      confidence,
      highConfidence,
      repeatThreshold,
      action: highConfidence ? "timeout" : "alert",
      trigger: highConfidence
        ? `confidence ${confidence}% > ${SELLING_CONFIDENCE_TIMEOUT_THRESHOLD}%`
        : "below immediate-timeout confidence",
      events: []
    };
  }

  pruneSellingUserState(now);
  const entry = sellingUserBuckets.get(key) || { events: [] };
  entry.events.push({
    at: now,
    channelId: message.channelId,
    messageId: message.id,
    url: buildMessageUrl(message),
    confidence,
    reasons: signals.map((signal) => signal.reason)
  });
  entry.events = entry.events.slice(-Math.max(SELLING_LOW_CONFIDENCE_REPEAT_TIMEOUT_THRESHOLD + 2, 5));
  sellingUserBuckets.set(key, entry);

  const repeated = entry.events.length >= repeatThreshold;
  const action = highConfidence || repeated ? "timeout" : "alert";

  return {
    count: entry.events.length,
    confidence,
    highConfidence,
    repeatThreshold,
    action,
    trigger: highConfidence
      ? `confidence ${confidence}% > ${SELLING_CONFIDENCE_TIMEOUT_THRESHOLD}%`
      : repeated
        ? `${entry.events.length}/${repeatThreshold} scam/trade signals in ${formatDuration(SELLING_REPEAT_WINDOW_MS)}`
        : "below immediate-timeout confidence",
    events: [...entry.events]
  };
}

function cloneReplyContext(repliedToMessage) {
  if (!repliedToMessage?.content) return null;
  return {
    content: cleanText(repliedToMessage.content),
    authorId: repliedToMessage.authorId || null,
    authorLabel: repliedToMessage.authorLabel || "other user"
  };
}

function normalizeRecentMessageEntry(entry) {
  if (typeof entry === "string") {
    return {
      at: Date.now(),
      content: String(entry || ""),
      repliedToMessage: null
    };
  }

  return {
    at: Number(entry?.at || Date.now()),
    content: String(entry?.content || ""),
    repliedToMessage: cloneReplyContext(entry?.repliedToMessage)
  };
}

function getRecentMessageTexts(recentMessages) {
  return (recentMessages || [])
    .map((entry) => cleanText(typeof entry === "string" ? entry : entry?.content))
    .filter(Boolean)
    .slice(-SELL_CONTEXT_MAX_MESSAGES);
}

function clearRecentUserMessagesFor(message) {
  const key = buildRecentUserMessageKey(message);
  if (!key) return false;
  return recentUserMessages.delete(key);
}

function rememberRecentUserMessage(message, repliedToMessage = null, now = Date.now()) {
  const key = buildRecentUserMessageKey(message);
  if (!key) {
    return [{
      at: now,
      content: String(message?.content || ""),
      repliedToMessage: cloneReplyContext(repliedToMessage)
    }];
  }

  pruneRecentUserMessages(now);
  const entry = recentUserMessages.get(key) || { messages: [] };
  entry.messages.push({
    at: now,
    content: String(message.content || ""),
    repliedToMessage: cloneReplyContext(repliedToMessage)
  });
  if (entry.messages.length > SELL_CONTEXT_MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-SELL_CONTEXT_MAX_MESSAGES);
  }
  recentUserMessages.set(key, entry);
  return entry.messages.map(normalizeRecentMessageEntry);
}

async function resolveReferencedMessageContext(message) {
  if (!message?.reference?.messageId && !message?.fetchReference) return null;

  let referenced = null;
  if (typeof message.fetchReference === "function") {
    referenced = await message.fetchReference().catch(() => null);
  }

  if (!referenced && message.reference?.messageId && typeof message.channel?.messages?.fetch === "function") {
    referenced = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
  }

  const content = cleanText(referenced?.content || "");
  if (!content) return null;
  return {
    content,
    authorId: referenced.author?.id || null,
    authorLabel: referenced.member?.displayName || referenced.author?.username || referenced.author?.id || "other user"
  };
}

function buildScamAiContext({ message, recentMessages, repliedToMessage }) {
  const messageContexts = (recentMessages || [])
    .map(normalizeRecentMessageEntry)
    .map((entry) => ({
      content: cleanText(entry.content),
      repliedToMessage: cloneReplyContext(entry.repliedToMessage)
    }))
    .filter((entry) => entry.content)
    .slice(-SELL_CONTEXT_MAX_MESSAGES);
  const userMessages = getRecentMessageTexts(messageContexts);

  return {
    userId: message.author?.id || null,
    channelId: message.channelId || null,
    userMessages,
    messageContexts,
    repliedToMessage: repliedToMessage || null,
    currentMessageUrl: buildMessageUrl(message)
  };
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
  if (signals.some((signal) => signal.type === "selling")) return "Scam/Trade Alert";
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

function buildSellingDmPayload({ message, signals, state, durationMs }) {
  return {
    embeds: [
      buildPanel({
        header: "Scam/Trade Timeout",
        body: [
          `i timed you out for ${formatDuration(durationMs)} because your recent message looked like scam/trade behavior`,
          "please keep buying, selling, trading, account deals, and private download handoffs out of the chat",
          `**Channel:** <#${message.channelId}>`,
          `**Confidence:** ${state.confidence}%`,
          `**Trigger:** ${state.trigger}`,
          `**Why:**\n${formatSignalReasons(signals)}`,
          `**Message:** ${trimExcerpt(message.content, 180)}`
        ].join("\n\n"),
        color: DANGER
      })
    ]
  };
}

function buildSellingLogPanel({ message, signals, state, deleteResult, timeoutResult, dmSent, durationMs }) {
  const link = buildMessageUrl(message);
  const confidenceLines = signals
    .map((signal) => `- ${signal.confidence || 0}% - ${signal.reason}`)
    .join("\n");
  const aiLines = formatAiVerdictLines(signals);
  const action =
    state.action === "timeout"
      ? `delete ${deleteResult.deleted ? "ok" : deleteResult.reason} | timeout ${timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason} | dm ${dmSent ? "sent" : "not sent"}`
      : `delete ${deleteResult.deleted ? "ok" : deleteResult.reason} | log only`;

  return {
    header: state.action === "timeout" ? "Scam/Trade Timeout" : "Scam/Trade Alert",
    body: [
      state.action === "timeout"
        ? "scam/trade guard triggered and action was applied"
        : "scam/trade guard saw a lower-confidence message",
      `**User:** <@${message.author?.id}>`,
      `**Channel:** <#${message.channelId}>`,
      link ? `**Jump:** [Open message](${link})` : null,
      `**Action:** ${action}`,
      `**Confidence:** ${state.confidence}%`,
      `**Trigger:** ${state.trigger}`,
      `**Scam/Trade Hits:** ${state.count}/${state.repeatThreshold} in ${formatDuration(SELLING_REPEAT_WINDOW_MS)}`,
      `**Why:**\n${confidenceLines}`,
      aiLines ? `**AI Scam Verdict:**\n${aiLines}` : null,
      `**Message:** ${trimExcerpt(message.content)}`
    ].filter(Boolean).join("\n\n"),
    color: state.action === "timeout" ? DANGER : WARN
  };
}

function formatAiVerdictLines(signals) {
  const lines = (signals || [])
    .map((signal) => signal.ai)
    .filter(Boolean)
    .map((ai) => {
      const detail = ai.skipped ? ` (${ai.skipped})` : "";
      const reason = ai.reason ? ` - ${ai.reason}` : "";
      return `- ${ai.model || "Gemini"}: ${ai.answer || "NO_ANSWER"}${detail}${reason}`;
    });
  return lines.length ? lines.join("\n") : "";
}

function buildClassifierVerdictResult(result) {
  if (!result) return null;
  const answer = result.verdict === true ? "TRUE" : result.verdict === false ? "FALSE" : "BORDERLINE";
  return {
    attempted: false,
    verdict: result.verdict,
    answer,
    model: result.model || "local classifier",
    skipped: result.verdict === null ? "borderline" : "local_confident",
    confidence: result.confidence,
    score: result.score,
    reason: result.reason
  };
}

function buildScamAiClearedLogPanel({ message, candidateSignal, aiResult }) {
  const link = buildMessageUrl(message);
  return {
    header: "Scam AI Cleared",
    body: [
      "scam/trade prefilter asked for a verdict and the classifier returned false",
      `**User:** <@${message.author?.id}>`,
      `**Channel:** <#${message.channelId}>`,
      link ? `**Jump:** [Open message](${link})` : null,
      `**Candidate:** ${candidateSignal.reason}`,
      `**AI Answer:** ${aiResult.answer || "FALSE"}`,
      `**Model:** ${aiResult.model || "Gemini"}`,
      `**Message:** ${trimExcerpt(message.content)}`
    ].filter(Boolean).join("\n\n"),
    color: WARN
  };
}

async function replyToSellingMessage(message) {
  return tryReplyModerationMessage(message, buildSellingPublicReply(), "scam-trade");
}

function buildFakeInfoPublicReply(signals = []) {
  const reason = signals.find((signal) => signal.reason)?.reason;
  return [
    "## False info bro!",
    reason ? `Kicia docs/runtime disagree: ${reason}.` : null
  ].filter(Boolean).join("\n");
}

async function replyToFakeInfoMessage(message, signals) {
  return tryReplyModerationMessage(message, buildFakeInfoPublicReply(signals), "fake-info");
}

async function replyToRoastingMessage(message) {
  return tryReplyModerationMessage(message, buildRoastingPublicReply(), "roasting");
}

function formatBlockedLinkReasons(signal) {
  const reasons = signal.reasons?.length ? signal.reasons : [signal.reason || "risky link detected"];
  return reasons.map((reason) => `- ${reason}`).join("\n");
}

function buildBlockedLinkUserPayload({ message, signal, durationMs }) {
  const shownLinks = signal.blockedLinks
    .slice(0, 3)
    .map((entry) => `- ${entry.raw}`)
    .join("\n");
  const isTimeout = signal.action === "timeout";

  return {
    embeds: [
      buildPanel({
        header: isTimeout ? "Link Timeout" : "Link Warning",
        body: [
          isTimeout
            ? `i timed you out for ${formatDuration(durationMs)} because that link looked high-risk`
            : "i removed that link because it looked risky",
          `**Channel:** <#${message.channelId}>`,
          `**Threat Level:** ${signal.threatLevel}`,
          `**Why:**\n${formatBlockedLinkReasons(signal)}`,
          "**Blocked Link(s):**",
          shownLinks,
          "docs links, trusted staff-added links, common safe links, and gif links are allowed"
        ].join("\n\n"),
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
    header:
      signal.action === "timeout"
        ? timeoutResult.applied ? "Blocked Link Timeout" : "Blocked Link Alert"
        : signal.action === "warn"
          ? "Blocked Link Warning"
          : "Link Review",
    body: [
      timeoutResult.applied
        ? "link guard triggered and action was applied"
        : signal.action === "review"
          ? "link guard logged a low-risk link for staff review"
          : "link guard triggered, but the action did not fully apply",
      `**User:** <@${message.author?.id}>`,
      `**Channel:** <#${message.channelId}>`,
      `**Action:** ${signal.action} | delete ${deleteResult.deleted ? "ok" : deleteResult.reason} | timeout ${
        timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason
      } | dm ${dmSent ? "sent" : "not sent"}`,
      `**Threat:** ${signal.threatLevel} (${signal.confidence || 0}%)`,
      `**Policy:** docs/trusted/gif/common-safe links pass; risky links escalate by threat`,
      `**Blocked Link Count:** ${signal.blockedCount}`,
      `**Why:**\n${formatBlockedLinkReasons(signal)}`,
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

function formatSignalReasons(signals) {
  return signals
    .map((signal) => `- ${signal.reason}`)
    .join("\n");
}

function buildSuspiciousDmPayload({ message, signals, action, durationMs, count, confidence = 0, highConfidence = false }) {
  const isTimeout = action === "timeout";

  return {
    embeds: [
      buildPanel({
        header: isTimeout ? "Suspicious Message Timeout" : "Suspicious Message Warning",
        body: [
          isTimeout
            ? highConfidence
              ? `i timed you out for ${formatDuration(durationMs)} because this message looked highly suspicious`
              : `i timed you out for ${formatDuration(durationMs)} because multiple recent messages looked suspicious`
            : "i flagged one of your recent messages as suspicious",
          "please do not repeat this kind of message; staff have been notified",
          `**Channel:** <#${message.channelId}>`,
          `**Confidence:** ${confidence}%`,
          `**Suspicious Hits:** ${count}`,
          `**Why:**\n${formatSignalReasons(signals)}`,
          `**Message:** ${trimExcerpt(message.content, 180)}`
        ].join("\n\n"),
        color: isTimeout ? DANGER : WARN
      })
    ]
  };
}

function buildSuspiciousLogPanel({ message, signals, state, timeoutResult, dmSent, durationMs }) {
  const link = buildMessageUrl(message);
  const action =
    state.action === "timeout"
      ? `timeout ${timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason} | dm ${dmSent ? "sent" : "not sent"}`
      : state.action === "warn"
        ? `dm warning ${dmSent ? "sent" : "not sent"}`
        : "log only";

  return {
    header:
      state.action === "timeout"
        ? "Suspicious Message Timeout"
        : state.action === "warn"
          ? "Suspicious Message Warning"
          : "Suspicious Message Alert",
    body: [
      state.action === "alert"
        ? "first suspicious message seen in the current watch window"
        : "repeat suspicious messages seen in the current watch window",
      `**User:** <@${message.author?.id}>`,
      `**Channel:** <#${message.channelId}>`,
      link ? `**Jump:** [Open message](${link})` : null,
      `**Action:** ${action}`,
      `**Confidence:** ${state.confidence || 0}%`,
      `**Trigger:** ${state.trigger || "watch window"}`,
      `**Suspicious Hits:** ${state.count} in ${formatDuration(SUSPICIOUS_ALERT_WINDOW_MS)}`,
      `**Why:**\n${formatSignalReasons(signals)}`,
      `**Message:** ${trimExcerpt(message.content)}`
    ].filter(Boolean).join("\n\n"),
    color: state.action === "timeout" ? DANGER : WARN
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

async function handleBlockedLinkMessage(message, signal, {
  sendLog = sendLogPanel,
  timeoutMs = LINK_MODERATION_TIMEOUT_MS,
  now = Date.now()
} = {}) {
  const action = signal.action || "timeout";
  const deleteResult = action === "review"
    ? { deleted: false, reason: "not needed" }
    : await tryDeleteMessage(message);
  const timeoutResult = action === "timeout"
    ? await tryTimeoutMessageMember(message.member, timeoutMs, "high-risk link")
    : { applied: false, reason: action === "warn" ? "warning only" : "not needed" };
  const dmSent = action === "timeout" || action === "warn"
    ? await safeSend(message.author, buildBlockedLinkUserPayload({
        message,
        signal,
        durationMs: timeoutMs
      }))
    : false;

  if (action !== "review" && !deleteResult.deleted) {
    recordRuntimeEvent("warn", "blocked-link-delete", deleteResult.reason);
  }
  if (action === "timeout" && !timeoutResult.applied) {
    recordRuntimeEvent("warn", "blocked-link-timeout", timeoutResult.reason);
  }
  await recordModerationStat(
    action === "timeout"
      ? timeoutResult.applied ? "blocked_link_timeout" : "blocked_link_alert"
      : action === "warn"
        ? "blocked_link_warning"
        : "blocked_link_review",
    now
  );

  await sendLog(message.guild, buildBlockedLinkLogPanel({
    message,
    signal,
    deleteResult,
    timeoutResult,
    dmSent,
    durationMs: timeoutMs
  })).catch(() => null);

  return action !== "review";
}

async function handleSellingMessage(message, signals, {
  sendLog = sendLogPanel,
  timeoutMs = SELLING_TIMEOUT_MS,
  now = Date.now(),
  replyPublic = true
} = {}) {
  const state = rememberSellingMessage(message, signals, now);
  const publicReplySent = replyPublic
    ? await replyToSellingMessage(message)
    : false;
  const deleteResult = await tryDeleteMessage(message);
  let timeoutResult = {
    applied: false,
    reason: "not needed"
  };
  let dmSent = false;

  if (!deleteResult.deleted) {
    recordRuntimeEvent("warn", "selling-delete", deleteResult.reason);
  }

  if (state.action === "timeout") {
    timeoutResult = await tryTimeoutMessageMember(message.member, timeoutMs, "scam/trade behavior in chat");
    dmSent = await safeSend(message.author, buildSellingDmPayload({
      message,
      signals,
      state,
      durationMs: timeoutMs
    }));
    if (!timeoutResult.applied) {
      recordRuntimeEvent("warn", "selling-timeout", timeoutResult.reason);
    }
  }

  await recordModerationStat(state.action === "timeout" ? "selling_timeout" : "selling_alert", now);
  await sendLog(message.guild, buildSellingLogPanel({
    message,
    signals,
    state,
    deleteResult,
    timeoutResult,
    dmSent,
    durationMs: timeoutMs
  })).catch(() => null);

  return {
    ...state,
    deleteResult,
    publicReplySent
  };
}

async function confirmScamTradeSignals(message, signals, scamContext, {
  classifyScam = classifyScamContextWithGemini,
  sendLog = sendLogPanel,
  now = Date.now()
} = {}) {
  if (!signals.length) return [];

  const strongest = signals.reduce(
    (best, signal) => (!best || (signal.confidence || 0) > (best.confidence || 0) ? signal : best),
    null
  );
  const needsAi = signals.some((signal) => signal.requiresAi) || Boolean(strongest);
  if (!needsAi) return signals;

  const localResult = classifyScamContextLocally(scamContext, { strongestSignal: strongest });
  const localVerdict = buildClassifierVerdictResult(localResult);
  if (localResult?.verdict === true && (localResult.confidence || 0) >= 92) {
    const confirmedSignals = signals.map((signal) => ({
      ...signal,
      confidence: Math.max(signal.confidence || 0, 88),
      reason: `classifier-confirmed scam/trade intent: ${signal.reason}`,
      ai: localVerdict
    }));
    await recordScamAudit(message, {
      action: "local_true",
      handled: true,
      signals: confirmedSignals,
      strongest,
      scamContext,
      localResult,
      now
    });
    return confirmedSignals;
  }

  if (localResult?.verdict === false && (localResult.confidence || 0) >= 92) {
    await sendLog(message.guild, buildScamAiClearedLogPanel({
      message,
      candidateSignal: strongest,
      aiResult: localVerdict
    })).catch(() => null);
    await recordScamAudit(message, {
      action: "local_false_clear",
      handled: false,
      signals,
      strongest,
      scamContext,
      localResult,
      now
    });
    return [];
  }

  const aiResult = await classifyScam(scamContext, { now });
  if (aiResult?.verdict === true) {
    const confirmedSignals = signals.map((signal) => ({
      ...signal,
      confidence: Math.max(signal.confidence || 0, 88),
      reason: `AI-confirmed scam/trade intent: ${signal.reason}`,
      ai: aiResult
    }));
    await recordScamAudit(message, {
      action: "ai_true",
      handled: true,
      signals: confirmedSignals,
      strongest,
      scamContext,
      localResult,
      aiResult,
      now
    });
    return confirmedSignals;
  }

  if (aiResult?.verdict === false) {
    await sendLog(message.guild, buildScamAiClearedLogPanel({
      message,
      candidateSignal: strongest,
      aiResult
    })).catch(() => null);
    await recordScamAudit(message, {
      action: "ai_false_clear",
      handled: false,
      signals,
      strongest,
      scamContext,
      localResult,
      aiResult,
      now
    });
    return [];
  }

  if (aiResult?.attempted && aiResult.skipped && aiResult.skipped !== "missing_key") {
    recordRuntimeEvent("warn", "scam-ai", aiResult.error || aiResult.skipped);
  }

  // Local development or missing AI key keeps the deterministic guard working.
  if (!aiResult?.attempted && aiResult?.skipped === "missing_key") {
    const fallbackSignals = signals.filter((signal) => !signal.requiresAi || (signal.confidence || 0) >= SELLING_CONFIDENCE_TIMEOUT_THRESHOLD);
    await recordScamAudit(message, {
      action: "missing_key_fallback",
      handled: Boolean(fallbackSignals.length),
      signals: fallbackSignals.length ? fallbackSignals : signals,
      strongest,
      scamContext,
      localResult,
      aiResult,
      now
    });
    return fallbackSignals;
  }

  // If Gemini is configured but unavailable/rate-limited, only act on very
  // strong deterministic evidence. Ambiguous scam candidates wait for AI.
  const fallbackSignals = signals.filter((signal) => !signal.requiresAi && (signal.confidence || 0) >= SELLING_CONFIDENCE_TIMEOUT_THRESHOLD);
  await recordScamAudit(message, {
    action: aiResult?.skipped ? `ai_${aiResult.skipped}` : "ai_no_verdict",
    handled: Boolean(fallbackSignals.length),
    signals: fallbackSignals.length ? fallbackSignals : signals,
    strongest,
    scamContext,
    localResult,
    aiResult,
    now
  });
  return fallbackSignals;
}

async function handleSuspiciousMessage(message, signals, {
  sendLog = sendLogPanel,
  timeoutMs = SUSPICIOUS_TIMEOUT_MS,
  highConfidenceTimeoutMs = SUSPICIOUS_HIGH_CONFIDENCE_TIMEOUT_MS,
  now = Date.now()
} = {}) {
  const state = rememberSuspiciousMessage(message, signals, now);
  const effectiveTimeoutMs = state.highConfidence ? highConfidenceTimeoutMs : timeoutMs;
  const publicReplySent = await tryReplyModerationMessage(
    message,
    buildSuspiciousPublicReply(state),
    "suspicious"
  );
  let dmSent = false;
  let timeoutResult = {
    applied: false,
    reason: "not needed"
  };

  if (state.action === "timeout") {
    timeoutResult = await tryTimeoutMessageMember(
      message.member,
      effectiveTimeoutMs,
      state.highConfidence ? "high-confidence suspicious message" : "repeated suspicious messages"
    );
    dmSent = await safeSend(message.author, buildSuspiciousDmPayload({
      message,
      signals,
      action: state.action,
      durationMs: effectiveTimeoutMs,
      count: state.count,
      confidence: state.confidence,
      highConfidence: state.highConfidence
    }));

    if (!timeoutResult.applied) {
      recordRuntimeEvent("warn", "suspicious-timeout", timeoutResult.reason);
    }
  } else if (state.action === "warn") {
    dmSent = await safeSend(message.author, buildSuspiciousDmPayload({
      message,
      signals,
      action: state.action,
      durationMs: effectiveTimeoutMs,
      count: state.count,
      confidence: state.confidence,
      highConfidence: state.highConfidence
    }));
  }
  await recordModerationStat(
    state.action === "warn" ? "suspicious_warning" : `suspicious_${state.action}`,
    now
  );

  await sendLog(message.guild, buildSuspiciousLogPanel({
    message,
    signals,
    state,
    timeoutResult,
    dmSent,
    durationMs: effectiveTimeoutMs
  })).catch(() => null);

  return {
    ...state,
    publicReplySent
  };
}

async function maybeHandleModerationWatch(message, {
  kb,
  runtimeStatus,
  fetchKbFn = fetchKb,
  classifyScam = classifyScamContextWithGemini,
  sendLog = sendLogPanel,
  now = Date.now()
} = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return false;
  if (hasBypassPermission(message)) return false;
  if (await hasManualWhitelistBypass(message)) return false;

  try {
    const repliedToMessage = await resolveReferencedMessageContext(message);
    const recentMessageEntries = rememberRecentUserMessage(message, repliedToMessage, now);
    const recentMessages = getRecentMessageTexts(recentMessageEntries);
    const scamContext = buildScamAiContext({ message, recentMessages: recentMessageEntries, repliedToMessage });
    let resolvedKb = kb || null;
    const hasLink = mightContainLink(message.content);
    if (!resolvedKb && (hasLink || mightContainFakeInfo(message.content))) {
      resolvedKb = await fetchKbFn().catch(() => null);
    }

    if (hasLink && resolvedKb) {
      const trustedLinks = await listTrustedLinks().catch((err) => {
        recordRuntimeEvent("warn", "trusted-link-list", err?.message || err);
        return [];
      });
      const blockedLinkSignal = await detectBlockedLinkSignalAsync(message.content, {
        kb: resolvedKb,
        trustedLinks,
        posterContext: getPosterLinkContext(message, now)
      });
      if (blockedLinkSignal) {
        const linkHandled = await handleBlockedLinkMessage(message, blockedLinkSignal, { sendLog, now });
        if (linkHandled) {
          clearRecentUserMessagesFor(message);
          return true;
        }
      }
    }

    const signals = collectContentSignals(message.content, {
      kb: resolvedKb,
      runtimeStatus: runtimeStatus || getRuntimeStatus()
    });
    const suspiciousSignals = signals.filter((signal) => signal.type === "suspicious");
    const contentSignals = signals.filter((signal) => signal.type !== "suspicious");

    if (!contentSignals.some((signal) => signal.type === "selling")) {
      const contextualSellingSignal = detectContextualSellingSignal(recentMessages, repliedToMessage);
      if (contextualSellingSignal) {
        contentSignals.push(contextualSellingSignal);
      }
    }

    let publicReplySent = false;
    const sellingSignals = contentSignals.filter((signal) => signal.type === "selling");
    const otherContentSignals = contentSignals.filter((signal) => signal.type !== "selling");

    const confirmedSellingSignals = sellingSignals.length
      ? await confirmScamTradeSignals(message, sellingSignals, scamContext, {
          classifyScam,
          sendLog,
          now
        })
      : [];

    if (confirmedSellingSignals.length) {
      const state = await handleSellingMessage(message, confirmedSellingSignals, {
        sendLog,
        now,
        replyPublic: !suspiciousSignals.length
      });
      clearRecentUserMessagesFor(message);
      publicReplySent = publicReplySent || state.publicReplySent;
    }

    if (otherContentSignals.length) {
      await sendLog(message.guild, buildSignalAlertPanel(message, otherContentSignals));
      const fakeInfoSignals = otherContentSignals.filter((signal) => signal.type === "fake_info");
      if (fakeInfoSignals.length && !confirmedSellingSignals.length && !suspiciousSignals.length) {
        publicReplySent = publicReplySent || await replyToFakeInfoMessage(message, fakeInfoSignals);
      }
      const eventTypes = new Set(otherContentSignals.map((signal) => signal.type));
      for (const eventType of eventTypes) {
        if (eventType === "fake_info") {
          await recordModerationStat(`${eventType}_alert`, now);
        }
      }
    }

    if (suspiciousSignals.length) {
      const state = await handleSuspiciousMessage(message, suspiciousSignals, { sendLog, now });
      clearRecentUserMessagesFor(message);
      publicReplySent = publicReplySent || state.publicReplySent;
    }

    if (!confirmedSellingSignals.length && !suspiciousSignals.length) {
      const roastingSignal = detectRoastingSignal(message.content);
      if (roastingSignal) {
        await replyToRoastingMessage(message);
        return true;
      }
    }

    const raidAlert = observeRaidMessage(message);
    if (raidAlert) {
      await sendLog(message.guild, buildRaidAlertPanel(message, raidAlert));
      await recordModerationStat("raid_alert", now);
    }

    if (confirmedSellingSignals.length || suspiciousSignals.length || publicReplySent) return true;
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
  suspiciousUserBuckets.clear();
  sellingUserBuckets.clear();
}

module.exports = {
  detectSellingSignal,
  detectContextualSellingSignal,
  detectScamTradeCandidateContext,
  detectSuspiciousSignal,
  detectRoastingSignal,
  detectFakeInfoSignal,
  detectBlockedLinkSignal,
  collectContentSignals,
  hasBypassPermission,
  observeRaidMessage,
  resetModerationState,
  maybeHandleModerationWatch
};
