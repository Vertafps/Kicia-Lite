"use strict";

const { detectProhibitedCommerce } = require("./prohibited-commerce");
const { foldConfusableText } = require("./text");

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/gi;
const MONEY_EMOJI_RE = /[\u{1F4B0}\u{1F4B5}-\u{1F4B8}\u{1F911}]/gu;
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
  "giving out configs dms",
  "trading config for robux",
  "selling accounts",
  "selling kicia premium for robux",
  "premium configs for money in dm",
  "premium configs for money in bio",
  "hvh configs in dm",
  "check dm for paid cfg",
  "trading ue for kicia premium",
  "ue for kicia premium",
  "free robux in my bio",
  "swap kicia key for account",
  "exchange executor script for nitro",
  "want to buy your account dm price",
  "i sell executor links",
  "need middleman for kicia key trade",
  "selling premium bot access cheap",
  "dm for bypass download no official server",
  "i trade configs want",
  "turn 100 into 1000 dm me",
  "guaranteed returns investment group",
  "join my signal group crypto profits",
  "passive income opportunity dm",
  "i tripled my money in 24 hours",
  "invest with me guaranteed profit",
  "free nitro click this link",
  "win steam gift card react to this",
  "giveaway react to claim nitro",
  "paste this in your browser console",
  "run this script to get free robux",
  "enter your token for free premium",
  "this script gives you free nitro",
  "verify your discord account here",
  "your account will be suspended click",
  "claim your free gift before it expires",
  "limited time free nitro claim now",
  "act now before this expires dm me",
  "100x returns guaranteed signal group",
  "i made 500 in 24 hours invest with me",
  "dm me for my crypto group guaranteed profit",
  "send me 50 get 200 back paypal crypto"
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
  "someone said dms to buy kicia is that allowed",
  "is this investment offer a scam",
  "someone is posting free nitro links report them",
  "do not paste anything in your console",
  "warning this looks like a token grabber",
  "is this giveaway real or fake",
  "how do i report a scam investment post",
  "someone said free nitro is that real",
  "is this crypto offer legit or a scam",
  "warning do not click that nitro link"
];

const KICIA_BRAND_RE = /\b(?:kicia|kiciahook|kcia|kicka)\b/i;
const KICIA_PURCHASE_RE =
  /\b(?:buy|buying|bought|purchase|purchasing|pay|paid|payment|price|prices|cost|costs|shop|store|premium|prem|prm|license|licence|key|subscription|sub|upgrade|get|getting)\b/i;
const KICIA_DEAL_RISK_RE =
  /\b(?:sell|selling|sold|wts|wtb|trade|trading|swap|middleman|mm|dm|dms|message\s+me|from\s+me|my\s+(?:shop|server|reseller)|private|bio|profile|unofficial|account|accounts|akkount|akkounts|ackount|ackounts|acc|alts?|config|configs|confg|confgs|conf|confs|cfg|cfk|figs|script|executor|enhancement|enhancements|cheap|cheaper|nitro)\b/i;
const PAYMENT_METHOD_RE =
  /\b(?:roblox|robux|rbx|paypal|cashapp|cash\s+app|crypto|btc|eth|card|credit|debit|gift\s*card|usd|eur|gbp|dollars?|bucks?|rs|lkr|money|moneytoken)\b/i;
const PRIVATE_HANDOFF_RE = /\b(?:dm|dms|pm|pms|private|privately|message me|msg me|inbox|add me|bio|profile)\b/i;
const OFFICIAL_ROUTE_RE = /\b(?:official|staff|ticket|tickets|owner|admin|mod|moderator|store|shop|site|website|server|docs?|support|reseller|resellers|channel|channels)\b/i;
const QUESTION_START_RE = /^(?:anyone|does anyone|who|where|how|can i|can we|could i|am i allowed|is it allowed|do you|is there|what|why)\b/i;
const PROTECTED_ITEM_RE =
  /\b(?:kicia|kiciahook|kcia|kicka|account|accounts|akkount|akkounts|ackount|ackounts|acc|alts?|config|configs|confg|confgs|conf|confs|cfg|cfk|figs|script|scripts|hvh|executor|executors|key|keys|license|licence|premium|prem|prm|robux|rbx|nitro|token|cookie|cookies|enhancement|enhancements)\b/i;
const SHORT_SERVER_ITEM_RE = /\b(?:ue)\b/i;
const DEICTIC_ITEM_RE = /\b(?:this|ts|that|it|one|thing|stuff|something)\b/i;
const DIRECT_OFFER_RE =
  /\b(?:selling|sell|sold|wts|wtb|buying|buy my|buy from me|taking offers|for sale|offer|offers|giving|give|offering|reseller|middleman|mm)\b/i;
const TRADE_WORD_RE = /\b(?:trade|trading|swap|swapping|exchange|exchanging)\b/i;
const BARTER_RE =
  /\b(?:trade|trading|swap|swapping|exchange|exchanging|give|giving|offering)\b.{0,80}\bfor\b/i;
const KICIA_TRADE_ASSET_RE = /\b(?:kicia|kiciahook|kcia|kicka|premium|prem|prm|license|licence|key|keys|ue)\b/i;
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
  /\b(?:dm me|dms me|message me|msg me|pm me|inbox me|add me|from me|in my bio|my profile|my shop|my server|my reseller|i sell|i can sell|i got|i have)\b/i;
const CRYPTO_INVEST_RE =
  /\b(?:invest|investing|investment|returns?|profit|profits|passive\s+income|signal\s+group|crypto\s+group|double\s+your|triple\s+your|guaranteed|100x|pump|trading\s+group|i\s+made\s+\d+|send\s+\d+\s+get)\b/i;
const GIVEAWAY_PHISH_RE =
  /\b(?:free\s+nitro|free\s+robux|robux\s+in\s+(?:my\s+)?(?:bio|profile)|nitro\s+giveaway|steam\s+gift|gift\s+card\s+giveaway|win\s+a|react\s+to\s+(?:win|claim|get)|click\s+to\s+claim|claim\s+your\s+free|giveaway\s+ends)\b/i;
const TOKEN_GRAB_RE =
  /\b(?:paste\s+(?:this|it)\s+in|browser\s+console|devtools|run\s+this\s+script|enter\s+your\s+token|copy\s+(?:this|your)\s+token|token\s+grabber|cookie\s+logger)\b/i;
const URGENCY_RE =
  /\b(?:act\s+now|limited\s+time|expires?\s+(?:soon|now)|claim\s+before|before\s+it(?:'s|\s+is)\s+gone|last\s+chance|only\s+\d+\s+(?:left|remaining|spots?))\b/i;
const ACCOUNT_PHISH_RE =
  /\b(?:verify\s+your\s+(?:account|discord|identity)|account\s+(?:suspended|banned|terminated|flagged|at\s+risk)|confirm\s+your\s+(?:account|email)|unusual\s+activity|security\s+alert)\b/i;
const MONEY_TEST_RE = new RegExp(MONEY_RE.source, "i");
const URL_TEST_RE = new RegExp(URL_RE.source, "i");

function normalizeClassifierText(value) {
  return foldConfusableText(value)
    .toLowerCase()
    .replace(MONEY_EMOJI_RE, " moneytoken ")
    .replace(/\b14ad1ng\b/g, " trading ")
    .replace(/\b4or\b/g, " for ")
    .replace(/\b4\b/g, " for ")
    .replace(/[@4]/g, "a")
    .replace(/3/g, "e")
    .replace(/[1!|]/g, "l")
    .replace(/0/g, "o")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(URL_RE, " urltoken ")
    .replace(MONEY_RE, " moneytoken ")
    .replace(/[`*_~|>[\](){},.!?;:"'\\/@#$%^&+=-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bsae+l{1,3}i+n+g\b/g, "selling")
    .replace(/\bse+l{1,4}n+g\b/g, "selling")
    .replace(/\bse+i+n+g\b/g, "selling")
    .replace(/\bse\s+ing\b/g, "selling")
    .replace(/\bst+ell?ing\b/g, "selling")
    .replace(/\btrae+d+i+n+k\b/g, "trading")
    .replace(/\btra+b+i+n+[pg]\b/g, "trading")
    .replace(/\btra+i+g\b/g, "trading")
    .replace(/\btr+d+i+n+g\b/g, "trading")
    .replace(/\btr+d+n+g\b/g, "trading")
    .replace(/\btr+a?d+i+n+k\b/g, "trading")
    .replace(/\b14adlng\b/g, "trading")
    .replace(/\bakk?ounts?\b/g, "account")
    .replace(/\backounts?\b/g, "account")
    .replace(/\bconfg+z*\b/g, "config")
    .replace(/\bconfigz+\b/g, "config")
    .replace(/\bprm\b/g, "prem")
    .replace(/\bkcia\b/g, "kicia")
    .replace(/\bkicka\b/g, "kicia")
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

function isSafePurchaseMethodQuestion(input, repliedToMessage = null) {
  const parts = Array.isArray(input) ? input : [input];
  const text = normalizeClassifierText(parts.filter(Boolean).join(" "));
  const replyText = normalizeClassifierText(repliedToMessage?.content || "");
  if (!text) return false;

  const hasQuestionTone = QUESTION_START_RE.test(text) || /\?$/.test(text);
  const asksToBuyOrPay =
    /\b(?:buy|buying|purchase|purchasing|pay|payment|get)\b/.test(text) &&
    (
      /\b(?:with|using|via|through|by)\b/.test(text) ||
      /\b(?:can|could|do|does|what|where|how)\b.{0,80}\b(?:buy|purchase|pay|payment|get)\b/.test(text)
    );
  const referencesServerProduct =
    KICIA_BRAND_RE.test(text) ||
    KICIA_BRAND_RE.test(replyText) ||
    /\b(?:premium|license|licence|key)\b/.test(text) ||
    DEICTIC_ITEM_RE.test(text);
  const hasUnsafeDealLanguage =
    KICIA_DEAL_RISK_RE.test(text) ||
    PRIVATE_HANDOFF_RE.test(text) ||
    SELF_PRIVATE_DEAL_RE.test(text) ||
    TRADE_WORD_RE.test(text) ||
    /\b(?:buy\s+(?:my|from\s+me)|from\s+me|i\s+(?:sell|sold|got|have)|selling|seller|wts|wtb|middleman|mm|account|accounts|acc|alts?|config|configs|cfg|script|scripts|executor|executors|cheap|cheaper)\b/.test(text);

  return Boolean(
    hasQuestionTone &&
    asksToBuyOrPay &&
    referencesServerProduct &&
    PAYMENT_METHOD_RE.test(text) &&
    !hasUnsafeDealLanguage
  );
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

function localVerdict({ verdict, confidence, score, reason, stage = "policy", model = MODEL_NAME }) {
  return {
    verdict,
    confidence,
    score,
    reason,
    stage,
    model
  };
}

function extractPolicyIntent(context = {}, options = {}) {
  const userMessages = Array.isArray(context.userMessages) ? context.userMessages : [];
  const rawUserText = userMessages.join(" ");
  const userText = normalizeClassifierText(userMessages.join(" "));
  const fullText = normalizeClassifierText(buildContextText(context));
  const signalConfidence = Number(options.strongestSignal?.confidence || 0);
  if (!userText && !fullText) return null;

  if (isSafePurchaseMethodQuestion(userMessages.length ? userMessages : userText, context.repliedToMessage)) {
    return localVerdict({
      verdict: false,
      confidence: 98,
      score: 0.01,
      reason: "Safe Kicia payment-method purchase question, not a private deal."
    });
  }

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
  const hasShortServerItem = SHORT_SERVER_ITEM_RE.test(userText);
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
  const hasGenericPricedSale =
    hasDirectOffer &&
    /\bmoneytoken\b/i.test(userText) &&
    !hasProtectedItem &&
    !hasShortServerItem &&
    !hasPrivateHandoff &&
    !hasKiciaTradeAsset &&
    !hasBarter &&
    !hasPrivatePurchaseHandoff &&
    !hasPrivateOfferHandoff;

  if ((hasMetaDiscussion || hasTradeWarning) && (hasQuestionTone || hasTradeWarning || !/\b(?:i|im|i m|my|me)\b/i.test(userText))) {
    return localVerdict({
      verdict: false,
      confidence: 93,
      score: 0.07,
      reason: "Meta-discussion, report, or policy question rather than target-user deal intent."
    });
  }

  const hasNewScamPattern =
    TOKEN_GRAB_RE.test(userText) ||
    ACCOUNT_PHISH_RE.test(userText) ||
    CRYPTO_INVEST_RE.test(userText) ||
    GIVEAWAY_PHISH_RE.test(userText);
  const shouldDowngradeNewScam =
    hasNewScamPattern &&
    (
      hasMetaDiscussion ||
      (hasQuestionTone && !hasPrivateHandoff) ||
      (OFFICIAL_ROUTE_RE.test(userText) && !hasPrivateHandoff)
    );
  if (shouldDowngradeNewScam) {
    return localVerdict({
      verdict: null,
      confidence: 82,
      score: 0.5,
      reason: "Scam/phish topic appears in question, report, or official-support context."
    });
  }

  if (TOKEN_GRAB_RE.test(userText)) {
    return localVerdict({
      verdict: true,
      confidence: 96,
      score: 0.97,
      reason: "Token/credential grabber language detected."
    });
  }

  if (ACCOUNT_PHISH_RE.test(userText) && (URGENCY_RE.test(userText) || hasPrivateHandoff)) {
    return localVerdict({
      verdict: true,
      confidence: 94,
      score: 0.95,
      reason: "Account phishing pattern detected."
    });
  }

  if (CRYPTO_INVEST_RE.test(userText) && MONEY_TEST_RE.test(rawUserText) && hasPrivateHandoff) {
    return localVerdict({
      verdict: true,
      confidence: 95,
      score: 0.96,
      reason: "Crypto investment scam: private money offer."
    });
  }

  if (
    CRYPTO_INVEST_RE.test(userText) &&
    (
      hasPrivateHandoff ||
      URL_TEST_RE.test(rawUserText) ||
      /\b(?:join|group|server|channel|profits?|returns?|guaranteed|100x|double|triple)\b/i.test(userText)
    )
  ) {
    return localVerdict({
      verdict: true,
      confidence: 91,
      score: 0.92,
      reason: "Investment or signal-group scam pattern detected."
    });
  }

  if (CRYPTO_INVEST_RE.test(userText) && MONEY_TEST_RE.test(rawUserText)) {
    return localVerdict({
      verdict: null,
      confidence: 85,
      score: 0.5,
      reason: "Investment language with money needs remote AI confirmation."
    });
  }

  if (GIVEAWAY_PHISH_RE.test(userText) && (hasPrivateHandoff || URL_TEST_RE.test(rawUserText))) {
    return localVerdict({
      verdict: true,
      confidence: 91,
      score: 0.92,
      reason: "Giveaway phishing pattern detected."
    });
  }

  const prohibitedCommerce = detectProhibitedCommerce(userMessages.length ? userMessages : [userText]);
  if (prohibitedCommerce) {
    return localVerdict({
      verdict: true,
      confidence: prohibitedCommerce.confidence,
      score: prohibitedCommerce.confidence / 100,
      reason: prohibitedCommerce.reason,
      stage: "policy",
      model: "local-commerce-policy-v3"
    });
  }

  if (hasGenericPricedSale) {
    return localVerdict({
      verdict: false,
      confidence: 94,
      score: 0.06,
      reason: "Generic priced sale lacks protected Kicia/server-risk item or private-deal evidence."
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

function hasActionableLocalScamSurface(normalizedText) {
  const text = String(normalizedText || "");
  if (!text) return false;

  const hasPrivateHandoff = PRIVATE_HANDOFF_RE.test(text) || SELF_PRIVATE_DEAL_RE.test(text);
  const hasProtectedItem = PROTECTED_ITEM_RE.test(text) || SHORT_SERVER_ITEM_RE.test(text);
  const hasKiciaTradeAsset = TRADE_WORD_RE.test(text) && KICIA_TRADE_ASSET_RE.test(text);
  const hasMarketOffer = DIRECT_OFFER_RE.test(text) || BARTER_RE.test(text);
  const hasCredentialOrPhish =
    TOKEN_GRAB_RE.test(text) ||
    ACCOUNT_PHISH_RE.test(text) ||
    GIVEAWAY_PHISH_RE.test(text) ||
    (CRYPTO_INVEST_RE.test(text) && /\bmoneytoken\b/.test(text));

  return Boolean(
    hasCredentialOrPhish ||
    hasKiciaTradeAsset ||
    (hasMarketOffer && hasProtectedItem) ||
    (hasPrivateHandoff && (hasProtectedItem || DEICTIC_ITEM_RE.test(text))) ||
    (/\bmoneytoken\b/.test(text) && hasMarketOffer && hasProtectedItem)
  );
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

  const actionableLocalSurface = hasActionableLocalScamSurface(normalized);
  if ((score >= 0.93 && actionableLocalSurface) || highRiskSignal) {
    return {
      verdict: true,
      confidence: Math.max(92, Math.min(99, Math.round(score * 100))),
      score,
      reason: highRiskSignal
        ? "High-risk trade/private-sale language matched local scam patterns."
        : "Local classifier matched scam/trade intent with actionable market or credential surface.",
      stage: "naive_bayes",
      model: MODEL_NAME
    };
  }

  if (score >= 0.93 && !actionableLocalSurface) {
    return {
      verdict: null,
      confidence: Math.max(90, Math.min(96, Math.round(score * 100))),
      score,
      reason: "Local classifier was high, but no actionable deal/credential surface was present.",
      stage: "naive_bayes_guarded",
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
  isSafePurchaseMethodQuestion,
  isSafeSecurityDisableSupport,
  isKiciaLegitPurchaseIntent,
  normalizeClassifierText,
  probabilityForScam
};
