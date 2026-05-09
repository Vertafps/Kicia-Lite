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

const FEW_SHOT_EXAMPLES = [
  // FALSE — casual chat, banter, gameplay
  { msg: "Bark for me like a good good boyyyyyyy", reply: null, json: { verdict: "FALSE", speaker_role: "chat", evidence: "banter, no commerce" } },
  { msg: "U got matcha server?", reply: null, json: { verdict: "FALSE", speaker_role: "asker", evidence: "asking for community link" } },
  { msg: "Send in dms", reply: null, json: { verdict: "FALSE", speaker_role: "chat", evidence: "vague, no item or offer" } },
  { msg: "i use boneclaw more then aug", reply: null, json: { verdict: "FALSE", speaker_role: "chat", evidence: "describing own usage of executors" } },
  { msg: "use paid executor", reply: null, json: { verdict: "FALSE", speaker_role: "chat", evidence: "advice to use paid exec, no sale" } },
  { msg: "Buy UE", reply: null, json: { verdict: "FALSE", speaker_role: "asker", evidence: "telling someone to buy, no own offer" } },
  { msg: "Its been 5 days without my Yub-X executor, mental state pandemonium", reply: null, json: { verdict: "FALSE", speaker_role: "chat", evidence: "venting about own executor" } },
  { msg: "i got a cfg that slams ue only for premium tho need orbit aura", reply: null, json: { verdict: "FALSE", speaker_role: "chat", evidence: "describing own config, no offer" } },
  // FALSE — support, purchase question, report
  { msg: "where to buy kicia premium", reply: null, json: { verdict: "FALSE", speaker_role: "asker", evidence: "official purchase question" } },
  { msg: "can I buy kicia with paypal", reply: null, json: { verdict: "FALSE", speaker_role: "asker", evidence: "payment-method question" } },
  { msg: "stop selling configs in here", reply: null, json: { verdict: "FALSE", speaker_role: "reporter", evidence: "telling others to stop selling" } },
  { msg: "is selling kicia allowed?", reply: null, json: { verdict: "FALSE", speaker_role: "asker", evidence: "policy question" } },
  // TRUE — deal intent
  { msg: "selling kicia premium cheap dm me", reply: null, json: { verdict: "TRUE", speaker_role: "seller", evidence: "sells kicia + private + cheap" } },
  { msg: "wts kicia key 5usd paypal", reply: null, json: { verdict: "TRUE", speaker_role: "seller", evidence: "wts + price + payment" } },
  { msg: "trading my account for robux", reply: null, json: { verdict: "TRUE", speaker_role: "seller", evidence: "trade account for currency" } },
  { msg: "i sell executor configs hmu", reply: null, json: { verdict: "TRUE", speaker_role: "seller", evidence: "explicit self-sale" } },
  { msg: "dm me", reply: "anyone selling cheap kicia premium?", json: { verdict: "TRUE", speaker_role: "seller", evidence: "DM handoff in reply to sale request" } },
  { msg: "got cheap executor configs hmu", reply: null, json: { verdict: "TRUE", speaker_role: "seller", evidence: "spare configs + cheap + private contact" } }
];

function buildGeminiPrompt(context) {
  const messageContexts = Array.isArray(context.messageContexts) && context.messageContexts.length
    ? context.messageContexts
    : (context.userMessages || []).map((line) => ({ content: line, repliedToMessage: null }));
  const userMessages = messageContexts
    .slice(-5)
    .map((entry, index) => {
      const reply = entry?.repliedToMessage?.content
        ? ` | replied_to(${entry.repliedToMessage.authorLabel || "other"}): ${clip(entry.repliedToMessage.content, 200)}`
        : "";
      return `${index + 1}. ${clip(entry?.content)}${reply}`;
    })
    .join("\n") || "(none)";
  const repliedTo = context.repliedToMessage?.content
    ? `${context.repliedToMessage.authorLabel || "other"}: ${clip(context.repliedToMessage.content)}`
    : "(none)";

  const exampleBlock = FEW_SHOT_EXAMPLES
    .map((ex, i) => {
      const replyLine = ex.reply ? `  reply: ${ex.reply}\n` : "";
      return `[${i + 1}] target: ${ex.msg}\n${replyLine}  output: ${JSON.stringify(ex.json)}`;
    })
    .join("\n\n");

  return [
    "You are a Discord scam/sale classifier for KiciaHook (a Roblox executor community).",
    "Decide if the TARGET USER is offering an unauthorized deal: selling/trading/buying premium/keys/accounts/configs/executors/robux/nitro privately, or running a phishing/giveaway scam.",
    "",
    "Return ONLY one JSON object on a single line:",
    '{"verdict":"TRUE"|"FALSE","speaker_role":"seller"|"buyer"|"asker"|"reporter"|"chat","evidence":"<≤80 chars>"}',
    "",
    "Rules:",
    "- TRUE only when the target user is the actor offering/seeking a deal. If unclear, FALSE.",
    "- Casual chat about executors, configs, cheap things, gaming, banter, jokes, complaining, asking for help — FALSE.",
    "- Asking how/where to buy through official channels, payment-method questions, asking if something is allowed, reporting someone — FALSE.",
    "- 'dm me' / 'send in dms' / 'hmu' alone without a deal item or sale word — FALSE.",
    "- Mentioning executors, configs, kicia, premium, robux, nitro, paid stuff in passing — FALSE unless the target is selling/trading/buying.",
    "- TRUE: 'selling X', 'wts X', 'trading X for Y', 'buy from me', 'cheap X dm me', 'got spare X cheap', 'dm me' as a reply to someone asking to buy/sell.",
    "",
    "Examples:",
    exampleBlock,
    "",
    "---",
    `replied_to: ${repliedTo}`,
    "target user's last messages (oldest to newest):",
    userMessages,
    "",
    "output:"
  ].join("\n");
}

function parseGeminiResponse(payload) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  if (!text) return { verdict: null };

  const jsonMatch = text.match(/\{[^}]*"verdict"[^}]*\}/i);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const v = String(parsed.verdict || "").toUpperCase();
      if (v === "TRUE" || v === "FALSE") {
        return {
          verdict: v === "TRUE",
          speakerRole: typeof parsed.speaker_role === "string" ? parsed.speaker_role.toLowerCase() : null,
          evidence: typeof parsed.evidence === "string" ? parsed.evidence.slice(0, 120) : null
        };
      }
    } catch {
      // fall through to text fallback
    }
  }

  const upper = text.toUpperCase();
  if (/\bTRUE\b/.test(upper) && !/\bFALSE\b/.test(upper)) return { verdict: true };
  if (/\bFALSE\b/.test(upper) && !/\bTRUE\b/.test(upper)) return { verdict: false };
  return { verdict: null };
}

function parseGeminiBoolean(payload) {
  return parseGeminiResponse(payload).verdict;
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
            maxOutputTokens: 80,
            responseMimeType: "application/json"
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
    const parsed = parseGeminiResponse(payload);
    const verdict = parsed.verdict;
    const answer = verdict === true ? "TRUE" : verdict === false ? "FALSE" : null;
    const result = {
      attempted: true,
      skipped: verdict == null ? "invalid_answer" : null,
      verdict,
      answer,
      speakerRole: parsed.speakerRole || null,
      evidence: parsed.evidence || null,
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
  parseGeminiResponse,
  resetScamAiState,
  FEW_SHOT_EXAMPLES
};
