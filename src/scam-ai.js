const {
  GEMINI_API_KEY,
  GEMINI_SCAM_CACHE_MS,
  GEMINI_SCAM_FAILURE_COOLDOWN_MS,
  GEMINI_SCAM_MIN_INTERVAL_MS,
  GEMINI_SCAM_MODEL,
  GEMINI_SCAM_TIMEOUT_MS
} = require("./config");
const { normalizeText } = require("./text");
const { fetchWithTimeout } = require("./utils/fetch");

const cache = new Map();
let lastGeminiCallAt = 0;
let geminiUnavailableUntil = 0;

function clip(value, max = 420) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function buildCacheKey(context) {
  const userLines = (context.userMessages || []).map((line) => normalizeText(line)).join("|");
  const reply = normalizeText(context.repliedToMessage?.content || "");
  const messageReplies = (context.messageContexts || [])
    .map((entry) => `${normalizeText(entry?.content || "")}>${normalizeText(entry?.repliedToMessage?.content || "")}`)
    .join("|");
  return `${userLines}::${reply}::${messageReplies}`;
}

function getCachedVerdict(cacheKey, now = Date.now()) {
  const cached = cache.get(cacheKey);
  if (!cached) return null;
  if (now - cached.at > GEMINI_SCAM_CACHE_MS) {
    cache.delete(cacheKey);
    return null;
  }
  return {
    ...cached.result,
    cached: true
  };
}

function setCachedVerdict(cacheKey, result, now = Date.now()) {
  cache.set(cacheKey, {
    at: now,
    result
  });
  return result;
}

function enterGeminiCooldown(now, reason) {
  geminiUnavailableUntil = Math.max(geminiUnavailableUntil, now + GEMINI_SCAM_FAILURE_COOLDOWN_MS);
  return {
    cooldownUntil: geminiUnavailableUntil,
    cooldownReason: reason
  };
}

function buildGeminiPrompt(context) {
  const messageContexts = Array.isArray(context.messageContexts) && context.messageContexts.length
    ? context.messageContexts
    : (context.userMessages || []).map((line) => ({ content: line, repliedToMessage: null }));
  const userMessages = messageContexts
    .slice(-5)
    .map((entry, index) => {
      const reply = entry?.repliedToMessage?.content
        ? ` | replied to ${entry.repliedToMessage.authorLabel || "other user"}: ${clip(entry.repliedToMessage.content, 220)}`
        : "";
      return `${index + 1}. ${clip(entry?.content)}${reply}`;
    })
    .join("\n") || "none";
  const repliedTo = context.repliedToMessage?.content
    ? `${context.repliedToMessage.authorLabel || "other user"}: ${clip(context.repliedToMessage.content)}`
    : "none";

  return [
    "You are a Discord moderation classifier for scam, selling, buying, trading, phishing, and private-deal behavior.",
    "Classify ONLY the TARGET USER, using the last five target-user messages and any messages they replied to.",
    "Return exactly TRUE or FALSE.",
    "TRUE means the target user likely has disallowed intent: scamming, selling/trading/buying accounts/configs/scripts/keys/executors, moving a trade/download/link/account deal to DMs, phishing, or asking someone to bypass safety.",
    "FALSE means harmless context: asking a support question, warning others, quoting or joking without offering a deal, asking whether something is allowed, or directing users to official docs/support.",
    "KiciaHook server standards:",
    "- FALSE: official Kicia/Kicia premium purchase/support questions such as 'where to buy kicia', 'how to buy kicia', prices, shop, ticket, staff, or official purchase flow.",
    "- FALSE: payment-method questions about buying Kicia or this product, such as 'can I buy this/ts with roblox', 'can I buy Kicia with robux', or 'can I pay with PayPal'. These are support questions unless the target user moves the deal to DMs or offers private goods.",
    "- FALSE: executor support wording about disabling/whitelisting antivirus or Windows Defender, unless paired with phishing, credentials, private sales, or unofficial downloads.",
    "- TRUE: private or unofficial Kicia deals such as 'dms to buy kicia', 'buy kicia from me', cheaper reseller offers, or moving Kicia purchase/payment to private DMs.",
    "- TRUE: offers or requests to buy/sell/trade/give/swap accounts, configs, scripts, executors, keys, licenses, robux/nitro as the traded item, or similar items.",
    "- FALSE: explanation answers to a purchase question, e.g. if someone asks 'how to buy?' and the target replies 'buy in the resellers', 'open a ticket', 'use the official shop', or 'ask staff'.",
    "- TRUE only when the TARGET USER is showing deal/scam intent. If they are asking if something is allowed, reporting someone, or quoting a bad phrase, return FALSE.",
    "",
    "Message replied to by target user:",
    repliedTo,
    "",
    "Target user's last messages, oldest to newest:",
    userMessages
  ].join("\n");
}

function parseGeminiBoolean(payload) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim()
    .toUpperCase();

  if (text === "TRUE") return true;
  if (text === "FALSE") return false;
  if (/^TRUE\b/.test(text || "")) return true;
  if (/^FALSE\b/.test(text || "")) return false;
  return null;
}

async function classifyScamContextWithGemini(context, {
  now = Date.now(),
  fetchFn = fetchWithTimeout
} = {}) {
  if (!GEMINI_API_KEY) {
    return {
      attempted: false,
      skipped: "missing_key",
      verdict: null,
      answer: null
    };
  }

  const cacheKey = buildCacheKey(context);
  const cached = getCachedVerdict(cacheKey, now);
  if (cached) return cached;

  if (geminiUnavailableUntil > now) {
    return {
      attempted: false,
      skipped: "cooldown",
      cooldownUntil: geminiUnavailableUntil,
      verdict: null,
      answer: null
    };
  }

  if (now - lastGeminiCallAt < GEMINI_SCAM_MIN_INTERVAL_MS) {
    return {
      attempted: false,
      skipped: "local_rate_limit",
      verdict: null,
      answer: null
    };
  }

  lastGeminiCallAt = now;
  const prompt = buildGeminiPrompt(context);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_SCAM_MODEL)}:generateContent`;

  try {
    const response = await fetchFn(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0,
            candidateCount: 1,
            maxOutputTokens: 2,
            stopSequences: ["\n"]
          }
        })
      },
      GEMINI_SCAM_TIMEOUT_MS
    );

    if (!response.ok) {
      const skipped = response.status === 429 ? "remote_rate_limit" : "http_error";
      return {
        attempted: true,
        skipped,
        status: response.status,
        ...enterGeminiCooldown(now, skipped),
        verdict: null,
        answer: null
      };
    }

    const payload = await response.json().catch(() => ({}));
    const verdict = parseGeminiBoolean(payload);
    const answer = verdict === true ? "TRUE" : verdict === false ? "FALSE" : null;
    const result = {
      attempted: true,
      skipped: verdict == null ? "invalid_answer" : null,
      verdict,
      answer,
      model: GEMINI_SCAM_MODEL
    };
    if (verdict != null) {
      geminiUnavailableUntil = 0;
    }
    return verdict == null ? result : setCachedVerdict(cacheKey, result, now);
  } catch (err) {
    return {
      attempted: true,
      skipped: "error",
      error: err?.message || String(err),
      ...enterGeminiCooldown(now, "error"),
      verdict: null,
      answer: null
    };
  }
}

function resetScamAiState() {
  cache.clear();
  lastGeminiCallAt = 0;
  geminiUnavailableUntil = 0;
}

module.exports = {
  buildGeminiPrompt,
  classifyScamContextWithGemini,
  parseGeminiBoolean,
  resetScamAiState
};
