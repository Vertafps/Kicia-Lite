"use strict";

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/gi;
const MONEY_RE = /(?:[$€£]\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?\s*(?:usd|eur|gbp|dollars?|bucks?|rs|lkr|robux|rbx)\b)/gi;

const MODEL_NAME = "local-kicia-intent-v2";

const SCAM_SAMPLES = [
  "selling configs cheap dm me",
  "selling kicia config cheap dm me",
  "selling executor config for 5 usd",
  "selling level account dm offers",
  "selling roblox account cheap paypal",
  "trading my account for robux",
  "trading executor script for nitro",
  "buying old discord account for usd",
  "buying premium account dm me",
  "wts kicia config cheap",
  "wtb account with robux",
  "taking offers for my config dm",
  "middleman for account trade",
  "dm me for executor link",
  "dms i have the executor link",
  "replying dms to where is executor link",
  "i got private executor link dm",
  "cheap bypass script message me",
  "selling script key paypal only",
  "trade config for key",
  "who wants to buy my account",
  "buy my cfg cheap",
  "selling nitro boosts dm",
  "steam gift card trade account",
  "limited time cheap premium key from me",
  "i can sell kicia premium cheaper in dms",
  "private kicia reseller dm cashapp",
  "buy kicia from me cheaper",
  "dms to buy kicia",
  "dm me to buy this",
  "dms to buy this",
  "message me for price on this",
  "private deal for kicia premium",
  "unofficial kicia cheaper dm",
  "selling kicia license dm me",
  "trading kicia key for account",
  "giving kicia key for account",
  "giving config for robux",
  "trading config for robux",
  "swap kicia key for account",
  "exchange executor script for nitro",
  "want to buy your account dm price",
  "i sell executor links",
  "need middleman for kicia key trade",
  "selling premium bot access cheap",
  "dm for bypass download no official server",
  "i trade configs want"
];

const SAFE_SAMPLES = [
  "how to buy kicia",
  "where to buy kicia",
  "where can i buy kicia premium",
  "buying kicia",
  "buying kicia premium",
  "can i buy kicia premium",
  "how much does kicia premium cost",
  "what is the kicia price",
  "where is the official kicia shop",
  "how do i purchase kicia",
  "where do i pay for kicia",
  "is kicia premium worth it",
  "i want to buy kicia premium",
  "how to get kicia license",
  "can staff help me buy kicia",
  "kicia premium bot price",
  "official kicia premium",
  "is there a kicia sale",
  "please do not sell accounts here",
  "stop selling configs",
  "is selling allowed",
  "someone is selling accounts report them",
  "where is executor link",
  "does anyone have the official executor link",
  "which channel has the executor link",
  "how do i download the executor",
  "is trading allowed",
  "do not trade accounts",
  "warning this looks like a scam",
  "report scam links to staff",
  "i am not selling anything",
  "buying kicia from the official store",
  "where can i buy kicia safely",
  "what payment methods for kicia premium",
  "is kicia currently available",
  "how to upgrade to kicia premium",
  "kicia premium support",
  "official kicia purchase question",
  "how do i disable windows defender for executor",
  "disable windows defender for executor",
  "turn off antivirus so executor can inject",
  "add executor to antivirus exclusions",
  "how to whitelist kicia in defender",
  "disable antivirus only if docs say it",
  "can i turn off real time protection for executor",
  "where to buy",
  "how to buy",
  "is trading allowed here",
  "can i trade this for that here",
  "someone said dms to buy kicia is that allowed"
];

const KICIA_BRAND_RE = /\b(?:kicia|kiciahook)\b/i;
const KICIA_PURCHASE_RE =
  /\b(?:buy|buying|bought|purchase|purchasing|pay|paid|payment|price|prices|cost|costs|shop|store|premium|license|licence|key|subscription|sub|upgrade|get|getting)\b/i;
const KICIA_DEAL_RISK_RE =
  /\b(?:sell|selling|sold|wts|wtb|trade|trading|swap|middleman|mm|dm|dms|message\s+me|from\s+me|account|accounts|acc|alts?|config|configs|cfg|script|executor|cheap|cheaper|robux|rbx|nitro|paypal|cashapp|crypto|btc|eth)\b/i;
const PRIVATE_HANDOFF_RE = /\b(?:dm|dms|pm|pms|private|privately|message me|msg me|inbox|add me)\b/i;
const OFFICIAL_ROUTE_RE = /\b(?:official|staff|ticket|tickets|owner|admin|mod|moderator|store|shop|site|website|server|docs?|support|reseller|resellers|channel|channels)\b/i;
const QUESTION_START_RE = /^(?:anyone|does anyone|who|where|how|can i|can we|could i|am i allowed|is it allowed|do you|is there|what|why)\b/i;
const PROTECTED_ITEM_RE =
  /\b(?:kicia|kiciahook|account|accounts|acc|alts?|config|configs|cfg|script|scripts|executor|executors|key|keys|license|licence|premium|robux|rbx|nitro|token|cookie|cookies)\b/i;
const DEICTIC_ITEM_RE = /\b(?:this|that|it|one|thing|stuff|something)\b/i;
const DIRECT_OFFER_RE =
  /\b(?:selling|sell|sold|wts|wtb|buying|buy my|buy from me|taking offers|for sale|offer|offers|reseller|middleman|mm)\b/i;
const TRADE_WORD_RE = /\b(?:trade|trading|swap|swapping|exchange|exchanging)\b/i;
const BARTER_RE =
  /\b(?:trade|trading|swap|swapping|exchange|exchanging|give|giving|offering)\b.{0,80}\bfor\b/i;
const KICIA_TRADE_ASSET_RE = /\b(?:kicia|kiciahook|premium|license|licence|key|keys)\b/i;
const TRADE_WARNING_RE =
  /\b(?:do not|don't|dont|never|stop|avoid|against rules?|not allowed|is not allowed|isn't allowed|no|report|reported|warning|warn)\b.{0,80}\b(?:trade|trading|swap|swapping|exchange|exchanging)\b|\b(?:trade|trading|swap|swapping|exchange|exchanging)\b.{0,80}\b(?:against rules?|not allowed|is not allowed|isn't allowed|report|reported|warning|warn)\b/i;
const SECURITY_DISABLE_RE =
  /\b(?:disable|turn off|shut off|deactivate|whitelist|allowlist|exclude|exclusion|allow)\b.{0,60}\b(?:antivirus|anti virus|windows defender|defender|windows security|real time protection|realtime protection|av)\b|\b(?:antivirus|anti virus|windows defender|defender|windows security|real time protection|realtime protection|av)\b.{0,60}\b(?:disable|turn off|shut off|deactivate|whitelist|allowlist|exclude|exclusion|allow)\b/i;
const SECURITY_RISK_RE =
  /\b(?:dm|dms|message me|msg me|pm|private|click|link|download from me|sell|selling|trade|trading|buy from me|token|password|cookie|account|paypal|cashapp|crypto)\b/i;
const META_DISCUSSION_RE =
  /\b(?:someone|somebody|someone's|somebody's|user|person|people|he|she|they|staff)\b.{0,30}\b(?:said|says|asked|told|is saying|was saying|selling|trading|scamming)\b|\b(?:is this|is that|are these|allowed|against rules|report|reported|warning|warn|quoting|quote)\b/i;
const PURCHASE_QUESTION_RE =
  /\b(?:how|where|can|do|does|what)\b.{0,60}\b(?:buy|purchase|pay|price|prices|cost|get|reseller|premium|license|key)\b|\b(?:buy|purchase|pay|price|prices|cost|get|reseller|premium|license|key)\b.{0,60}\b(?:where|how|can|do|does|what)\b/i;
const EXPLANATION_ROUTE_RE =
  /\b(?:reseller|resellers|official|ticket|tickets|shop|store|site|website|server|channel|channels|docs?|support|staff|owner|admin|mod|moderator)\b/i;
const EXPLANATION_VERB_RE =
  /\b(?:buy|go|check|open|use|ask|look|find|purchase|pay|get|through|from|in|inside|under)\b/i;
const SELF_PRIVATE_DEAL_RE =
  /\b(?:dm me|dms me|message me|msg me|pm me|inbox me|add me|from me|my shop|my server|my reseller|i sell|i can sell|i got|i have)\b/i;

function normalizeClassifierText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(URL_RE, " urltoken ")
    .replace(MONEY_RE, " moneytoken ")
    .replace(/[`*_~|>[\](){},.!?;:"'\\/@#$%^&+=-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isKiciaLegitPurchaseIntent(input) {
  const parts = Array.isArray(input) ? input : [input];
  const text = normalizeClassifierText(parts.filter(Boolean).join(" "));
  if (!KICIA_BRAND_RE.test(text) || !KICIA_PURCHASE_RE.test(text)) {
    return false;
  }

  if (KICIA_DEAL_RISK_RE.test(text)) {
    return false;
  }

  return true;
}

function isSafeSecurityDisableSupport(input) {
  const parts = Array.isArray(input) ? input : [input];
  const text = normalizeClassifierText(parts.filter(Boolean).join(" "));
  return SECURITY_DISABLE_RE.test(text) && !SECURITY_RISK_RE.test(text);
}

function getExplanationResponseIntent(input, repliedToMessage = null) {
  const parts = Array.isArray(input) ? input : [input];
  const answerText = normalizeClassifierText(parts.filter(Boolean).join(" "));
  const questionText = normalizeClassifierText(repliedToMessage?.content || "");
  if (!answerText || !questionText || !PURCHASE_QUESTION_RE.test(questionText)) {
    return null;
  }

  const hasExplanationRoute = EXPLANATION_ROUTE_RE.test(answerText);
  const hasExplanationVerb = EXPLANATION_VERB_RE.test(answerText);
  const hasPrivateHandoff = PRIVATE_HANDOFF_RE.test(answerText);
  const hasSelfPrivateDeal = SELF_PRIVATE_DEAL_RE.test(answerText);
  const answerMentionsKicia = KICIA_BRAND_RE.test(answerText) || /\b(?:premium|license|key)\b/i.test(answerText);

  if (hasSelfPrivateDeal || (hasPrivateHandoff && !hasExplanationRoute)) {
    return {
      verdict: true,
      confidence: answerMentionsKicia ? 96 : 92,
      score: 0.95,
      reason: "Private handoff answer to a purchase question matched scam/trade policy."
    };
  }

  if (hasExplanationRoute && hasExplanationVerb) {
    return {
      verdict: false,
      confidence: 97,
      score: 0.02,
      reason: "Answer explains the official purchase/support route."
    };
  }

  return null;
}

function isExplanationResponseIntent(input, repliedToMessage = null) {
  return getExplanationResponseIntent(input, repliedToMessage)?.verdict === false;
}

function localVerdict({ verdict, confidence, score, reason, stage = "policy" }) {
  return {
    verdict,
    confidence,
    score,
    reason,
    stage,
    model: MODEL_NAME
  };
}

function extractPolicyIntent(context = {}, options = {}) {
  const userMessages = Array.isArray(context.userMessages) ? context.userMessages : [];
  const userText = normalizeClassifierText(userMessages.join(" "));
  const fullText = normalizeClassifierText(buildContextText(context));
  const signalConfidence = Number(options.strongestSignal?.confidence || 0);
  if (!userText && !fullText) return null;

  if (isKiciaLegitPurchaseIntent(userMessages || userText)) {
    return localVerdict({
      verdict: false,
      confidence: 98,
      score: 0.01,
      reason: "Legitimate official Kicia purchase/support intent."
    });
  }

  if (isSafeSecurityDisableSupport(userMessages.length ? userMessages : userText)) {
    return localVerdict({
      verdict: false,
      confidence: 96,
      score: 0.02,
      reason: "Antivirus/Defender support wording without deal or credential intent."
    });
  }

  const explanationResult = getExplanationResponseIntent(userMessages, context.repliedToMessage);
  if (explanationResult) {
    return localVerdict(explanationResult);
  }

  const hasPrivateHandoff = PRIVATE_HANDOFF_RE.test(userText);
  const hasOfficialRoute = OFFICIAL_ROUTE_RE.test(userText);
  const hasQuestionTone = QUESTION_START_RE.test(userText) || /\?$/.test(userText);
  const hasProtectedItem = PROTECTED_ITEM_RE.test(userText);
  const hasKiciaTradeAsset = TRADE_WORD_RE.test(userText) && KICIA_TRADE_ASSET_RE.test(userText);
  const hasDeicticItem = DEICTIC_ITEM_RE.test(userText);
  const hasKicia = KICIA_BRAND_RE.test(userText);
  const hasOfferTone = /\b(?:you|u)\s+want\b/i.test(userText) || /\b(?:want|need)\s+(?:it|this|one)\b/i.test(userText);
  const hasPurchaseOrPrice = /\b(?:buy|buying|purchase|price|prices|pay|payment|get|sell|selling|offer|offers)\b/i.test(userText);
  const hasDirectOffer = DIRECT_OFFER_RE.test(userText);
  const hasBarter = BARTER_RE.test(userText);
  const hasMetaDiscussion = META_DISCUSSION_RE.test(userText);
  const hasTradeWarning = TRADE_WARNING_RE.test(userText);
  const hasPrivatePurchaseHandoff =
    hasPrivateHandoff &&
    hasPurchaseOrPrice &&
    (hasProtectedItem || hasDeicticItem || hasKicia);
  const hasPrivateOfferHandoff = hasPrivateHandoff && hasOfferTone && (hasProtectedItem || hasDeicticItem);
  const hasTradeOffer = /\b(?:trade|trading|swap|swapping|exchange|exchanging)\b/i.test(userText) && hasOfferTone;

  if ((hasMetaDiscussion || hasTradeWarning) && (hasQuestionTone || hasTradeWarning || !/\b(?:i|im|i m|my|me)\b/i.test(userText))) {
    return localVerdict({
      verdict: false,
      confidence: 93,
      score: 0.07,
      reason: "Meta-discussion, report, or policy question rather than target-user deal intent."
    });
  }

  if (hasKiciaTradeAsset) {
    if (hasQuestionTone && !hasPrivateHandoff && !hasDirectOffer && !hasOfferTone && !hasBarter) {
      return localVerdict({
        verdict: null,
        confidence: 86,
        score: 0.5,
        reason: "Question about Kicia trade wording needs remote AI before action."
      });
    }

    return localVerdict({
      verdict: true,
      confidence: 95,
      score: 0.96,
      reason: "Kicia premium/key trade wording matched unauthorized deal policy."
    });
  }

  if (hasPrivatePurchaseHandoff && !(hasQuestionTone && hasOfficialRoute)) {
    return localVerdict({
      verdict: true,
      confidence: hasKicia || hasProtectedItem ? 96 : 93,
      score: 0.97,
      reason: hasKicia
        ? "Private Kicia purchase/resale handoff is not an official Kicia use case."
        : "Private buy/sell handoff matched scam/trade policy."
    });
  }

  if (hasPrivateOfferHandoff || hasTradeOffer) {
    return localVerdict({
      verdict: true,
      confidence: 93,
      score: 0.94,
      reason: "Target user is steering an item/trade offer toward a private or direct deal."
    });
  }

  if (hasBarter && hasProtectedItem && !(hasQuestionTone && !hasDirectOffer && signalConfidence < 80)) {
    return localVerdict({
      verdict: true,
      confidence: 95,
      score: 0.96,
      reason: "Concrete protected-item barter matched scam/trade policy."
    });
  }

  if (hasDirectOffer && hasProtectedItem && !(hasQuestionTone && !hasPrivateHandoff)) {
    return localVerdict({
      verdict: true,
      confidence: 94,
      score: 0.95,
      reason: "Direct protected-item market offer matched scam/trade policy."
    });
  }

  if (hasBarter && (hasDeicticItem || /\b(?:for|this|that)\b/i.test(userText))) {
    return localVerdict({
      verdict: null,
      confidence: 84,
      score: 0.5,
      reason: "Ambiguous barter-style wording needs remote AI before action."
    });
  }

  if (hasQuestionTone && !hasPrivateHandoff && !hasDirectOffer) {
    return localVerdict({
      verdict: null,
      confidence: 76,
      score: 0.5,
      reason: "Question-style wording needs remote context before action."
    });
  }

  return null;
}

function tokenize(value) {
  const normalized = normalizeClassifierText(value);
  if (!normalized) {
    return [];
  }

  const words = normalized.split(" ").filter(Boolean);
  const tokens = [...words];
  for (let index = 0; index < words.length - 1; index += 1) {
    tokens.push(`${words[index]}_${words[index + 1]}`);
  }
  return tokens;
}

function trainModel() {
  const labels = ["scam", "safe"];
  const classDocs = Object.fromEntries(labels.map((label) => [label, 0]));
  const classTokenTotals = Object.fromEntries(labels.map((label) => [label, 0]));
  const tokenCounts = Object.fromEntries(labels.map((label) => [label, new Map()]));
  const vocabulary = new Set();

  const samples = [
    ...SCAM_SAMPLES.map((text) => ({ label: "scam", text })),
    ...SAFE_SAMPLES.map((text) => ({ label: "safe", text }))
  ];

  for (const sample of samples) {
    classDocs[sample.label] += 1;
    for (const token of tokenize(sample.text)) {
      vocabulary.add(token);
      classTokenTotals[sample.label] += 1;
      tokenCounts[sample.label].set(token, (tokenCounts[sample.label].get(token) || 0) + 1);
    }
  }

  return {
    labels,
    samples: samples.length,
    classDocs,
    classTokenTotals,
    tokenCounts,
    vocabulary
  };
}

const MODEL = trainModel();

function probabilityForScam(text) {
  const tokens = tokenize(text);
  if (!tokens.length) {
    return 0.5;
  }

  const vocabSize = MODEL.vocabulary.size || 1;
  const totalDocs = MODEL.samples || 1;
  const logs = {};

  for (const label of MODEL.labels) {
    logs[label] = Math.log((MODEL.classDocs[label] || 0.5) / totalDocs);
    const denominator = MODEL.classTokenTotals[label] + vocabSize;
    for (const token of tokens) {
      const count = MODEL.tokenCounts[label].get(token) || 0;
      logs[label] += Math.log((count + 1) / denominator);
    }
  }

  const maxLog = Math.max(logs.scam, logs.safe);
  const scamExp = Math.exp(logs.scam - maxLog);
  const safeExp = Math.exp(logs.safe - maxLog);
  return scamExp / (scamExp + safeExp);
}

function buildContextText(context = {}) {
  if (Array.isArray(context.messageContexts) && context.messageContexts.length) {
    return context.messageContexts
      .map((entry) => {
        const replyText = entry?.repliedToMessage?.content ? `reply context: ${entry.repliedToMessage.content}` : "";
        return [entry?.content, replyText].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n");
  }

  const userMessages = Array.isArray(context.userMessages) ? context.userMessages : [];
  const replyText = context.repliedToMessage?.content ? `reply context: ${context.repliedToMessage.content}` : "";
  return [...userMessages, replyText].filter(Boolean).join("\n");
}

function classifyScamContextLocally(context = {}, options = {}) {
  const text = buildContextText(context);
  if (!text.trim()) {
    return {
      verdict: null,
      confidence: 0,
      score: 0.5,
      reason: "No text was available for the local classifier.",
      stage: "empty",
      model: MODEL_NAME
    };
  }

  const policyResult = extractPolicyIntent(context, options);
  if (policyResult) return policyResult;

  const score = probabilityForScam(text);
  const signalConfidence = Number(options.strongestSignal?.confidence || 0);
  const normalized = normalizeClassifierText(text);
  const inquiryWithoutOffer =
    /^(?:anyone|does anyone|who|where|how|can i|am i allowed|is it allowed|do you|is there)\b/.test(normalized) &&
    !/\b(?:my|mine|from me|dm me|dms|message me|msg me|taking offers|for sale|wts|wtb|cheap|paypal|cashapp|crypto|middleman|mm)\b/.test(normalized);
  const highRiskSignal =
    signalConfidence >= 86 &&
    /\b(?:dm|dms|paypal|cashapp|crypto|middleman|account|accounts|acc|config|configs|cfg|robux|nitro|moneytoken)\b/.test(normalized);

  if (inquiryWithoutOffer && !highRiskSignal) {
    return {
      verdict: null,
      confidence: Math.round(Math.max(score, 1 - score) * 100),
      score,
      reason: "Question-style market wording needs remote context before action.",
      stage: "naive_bayes",
      model: MODEL_NAME
    };
  }

  if (score >= 0.93 || highRiskSignal) {
    return {
      verdict: true,
      confidence: Math.max(92, Math.min(99, Math.round(score * 100))),
      score,
      reason: highRiskSignal
        ? "High-risk trade/private-sale language matched local scam patterns."
        : "Local classifier matched scam/trade intent.",
      stage: "naive_bayes",
      model: MODEL_NAME
    };
  }

  if (score <= 0.08) {
    return {
      verdict: false,
      confidence: Math.max(92, Math.round((1 - score) * 100)),
      score,
      reason: "Local classifier matched safe/support intent.",
      stage: "naive_bayes",
      model: MODEL_NAME
    };
  }

  return {
    verdict: null,
    confidence: Math.round(Math.max(score, 1 - score) * 100),
    score,
    reason: "Borderline local classifier result; remote AI may be useful.",
    stage: "naive_bayes",
    model: MODEL_NAME
  };
}

module.exports = {
  classifyScamContextLocally,
  extractPolicyIntent,
  getExplanationResponseIntent,
  isExplanationResponseIntent,
  isSafeSecurityDisableSupport,
  isKiciaLegitPurchaseIntent,
  normalizeClassifierText,
  probabilityForScam
};
