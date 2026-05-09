"use strict";

const { deobfuscateMany } = require("./scam-deobfuscate");
const { foldConfusableText } = require("./text");

const COMMERCIAL_VERB_RE = /\b(?:sell|selling|sold|buy|buying|bought|trade|trading|swap|swapping|exchange|exchanging|wts|wtb|reseller|reselling|middleman|mm|vending|vendor|plug|hmu)\b/i;
const STRONG_VERB_RE = /\b(?:selling|sold|buying|bought|trading|swap|swapping|wts|wtb|reseller|for\s+sale)\b/i;
const SOFT_VERB_RE = /\b(?:buy|sell|trade|exchange|hmu|gimme|give|swap)\b/i;
const OFFER_PHRASE_RE = /\b(?:taking\s+offers|for\s+sale|on\s+sale|in\s+stock|stock|got\s+(?:for|some|a)\s+sale|got\s+(?:em|some)\s+(?:cheap|for|on))\b/i;
const VALUE_EXCHANGE_RE =
  /\b(?:kicia|kiciahook|premium|prem|license|licence|key|keys|ue|account|accounts|acc|alts?|config|configs|cfg|cfgs|executor|script)\b.{0,40}\bfor\b.{0,40}\b(?:robux|rbx|nitro|account|accounts|acc|alts?|config|configs|cfg|cfgs|moneytoken|money|usd|dollars?|bucks?|paypal|cashapp|crypto|venmo|zelle|btc|eth|kicia|kiciahook|premium|prem|license|licence|key|keys|ue|volt|script|executor)\b/i;
const SOLICITATION_QUESTION_RE =
  /\b(?:do|would|wanna|wana)\s+(?:you|u|y'all|yall|anyone|any\s*1|any1|some1|someone)\s+(?:want\s+to\s+|wanna\s+|wana\s+)?(?:buy|trade|swap|purchase|cop|grab|take|get)\b|\b(?:anyone|any\s*1|any1|some1|someone)\s+(?:want\s+to\s+|wanna\s+|wana\s+)?(?:buy|trade|swap|purchase|cop|grab)\b/i;
const NEGATIVE_FOR_CONTEXT_RE =
  /\b(?:only|available|works?|working|supported|made|used|good|best|optimized|designed|exclusive|reserved|need|needed|require|required|requires|restricted|just|paid)\s+for\b|\bfor\s+(?:premium|free|paid|me|us|him|her|them|you)\s+(?:users?|members?|only|peeps?|ppl|people)\b/i;

const SELF_ACTOR_POSITIVE_RE =
  /\b(?:i\s+(?:sell|sold|am\s+selling|m\s+selling|trade|trading|am\s+trading|swap|swapping|m\s+offering|am\s+offering|will\s+sell|will\s+trade|wanna\s+sell|wanna\s+trade|gonna\s+sell|wts|wtb)|im\s+(?:sell|sellin|selling|trading|tradng|tradin|swap|swapping|offering|reseller)|i\s+m\s+(?:sell|sellin|selling|trading|tradng|tradin|offering)|buy\s+(?:from|off)\s+(?:me|my)|sell(?:ing)?\s+(?:to\s+)?(?:you|u)|in\s+my\s+(?:bio|profile)|my\s+(?:shop|server|reseller|prices?)|my\s+price)\b/i;

const SELF_ACTOR_NEGATIVE_RE =
  /\b(?:i\s+(?:ain'?t|aint|am\s+not|m\s+not)\s+(?:sell|selling|trading|buying|swap|swapping)|im\s+(?:not|never)\s+(?:sell|selling|trading|buying)|i\s+m\s+not\s+(?:sell|selling|trading|buying)|never\s+(?:sell|selling|trading|buying|trade)|stop\s+(?:sell|selling|trading|buying|swap)|do\s?n[o']?t\s+(?:sell|selling|trade|trading|buy)|don'?t\s+(?:sell|selling|trade|trading|buy)|wo?n'?t\s+(?:sell|trade|buy)|would\s+never\s+(?:sell|trade|buy)|cuz\s+i(?:'?m\s+not|\s+ain'?t)\s+(?:buying|selling|trading))\b/i;

const REPORT_OR_META_RE =
  /\b(?:someone|somebody|user|person|people|they|he|she|staff)\s+(?:is\s+)?(?:said|says|asked|told|saying|selling|trading|scamming|posting)\b|\b(?:is\s+(?:this|that)|is\s+selling\s+allowed|are\s+these|allowed|against\s+rules?|not\s+allowed|isn'?t\s+allowed|is\s+it\s+ok|is\s+that\s+ok|how\s+do\s+i\s+report|report\s+(?:scam|user|him|them|her))\b/i;

const ASKER_QUESTION_RE =
  /\b(?:where|how|how\s+much|what|which|can\s+(?:i|you|we)|could\s+(?:i|you|we)|do\s+you|does)\b.{0,40}\b(?:buy|purchase|get|cost|price)\b|^(?:where|how|what|can\s+i|do\s+you|does)\b/i;

const PROTECTED_ITEM_STRONG_RE =
  /\b(?:kicia(?:hook)?|kica|kcia|kicka|premium|prem|prm|license|licence)\b/i;
const PROTECTED_ITEM_MID_RE =
  /\b(?:executor|executors|exec|exe|account|accounts|akkount|ackount|acc|alts?|config|configs|confg|confgs|cfg|cfgs|cfk|figs?|script|scripts|hvh\s+config|key|keys|robux|rbx|nitro)\b/i;
const PROTECTED_ITEM_WEAK_RE =
  /\b(?:ue|wave|hydrogen|codex|solara|velocity|matcha|boneclaw|argon|aug|orbit|aura)\b/i;

const SUPPORT_CONTEXT_RE =
  /\b(?:supported|support|supports|works|working|work|compatible|compat|use|using|run|runs|running|inject|injects|injecting|injection|load|loads|loading|crash(?:es|ed|ing)?|broken|down|fix|fixes|fixed|fixing|free\s+(?:on|for|version)|detection|detected|undetected|undetect|update|updated|outdated|version|versions|antivirus|defender|av\s+off|disable|enable|enabling|disabling|whitelist|exclude|exclusion|allow|reset|reinstall|virus|trojan|rootkit|spyware|valorant|fortnite|minecraft|game|games|safe|sus|sketchy|legit|isnt?|aint?|use\s+it\s+for)\b/i;

const PRICE_RE = /(?:[$€£]\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?\s*(?:usd|eur|gbp|dollars?|bucks?|rs|lkr|robux|rbx)\b)/i;
const PAYMENT_METHOD_RE =
  /\b(?:paypal|cashapp|cash\s+app|crypto|btc|eth|ltc|usdt|monero|xmr|gift\s*card|venmo|zelle|apple\s+pay|google\s+pay)\b/i;
const FOR_X_TRADE_RE =
  /\b(?:trade|trading|swap|swapping|exchange|exchanging|give|giving|offering|sell|selling)\b.{0,40}\bfor\b.{0,40}\b(?:robux|rbx|nitro|account|acc|alts?|config|configs|cfg|key|keys|premium|kicia|crypto|paypal|cashapp|moneytoken)\b/i;
const CHEAP_PRICE_RE = /\b(?:cheap|cheaper|cheapest|discount|low\s+price|best\s+price|good\s+price|fair\s+price|hmu\s+for\s+price|dm\s+for\s+price|message\s+for\s+price|pm\s+for\s+price)\b/i;

const PRIVATE_HANDOFF_RE =
  /\b(?:dm\s+me|dms\s+me|message\s+me|msg\s+me|pm\s+me|inbox\s+me|inbox|hit\s+me\s+up|hmu|add\s+me|in\s+my\s+(?:bio|profile)|from\s+me|buy\s+(?:from|off)\s+me|sell\s+(?:to\s+)?me|my\s+dms?|check\s+dms?|reply\s+(?:in\s+)?dms?|dms?\s+(?:open|are\s+open)|dms\s+(?:to|for|if))\b/i;
const PRIVATE_HANDOFF_BENIGN_RE =
  /\b(?:ss|screenshot|sceenshot|screensh|pic|pics|image|images|photo|video|clip|attach|attachment|sending\s+(?:ss|pic|pics|photo|screenshot)|will\s+send|ill\s+send|will\s+dm|ill\s+dm|gonna\s+dm|gonna\s+send|dm\s+me\s+(?:later|tomorrow|tonight|after))\b/i;
const DEAL_CONTEXT_NEAR_HANDOFF_RE =
  /\b(?:cheap|cheaper|cheapest|free|discount|price|prices|paypal|cashapp|crypto|btc|eth|robux|rbx|nitro|kicia|kiciahook|premium|prem|key|keys|license|licence|account|acc|alts?|config|configs|cfg|executor|executors|exec|script|scripts|sale|deal|hvh\s+config|sell|selling|trade|trading|buy|wts|wtb|swap|reseller)\b/i;

const SCAM_PATTERN_RE =
  /\b(?:free\s+(?:nitro|robux)|robux\s+in\s+(?:my\s+)?(?:bio|profile)|nitro\s+giveaway|steam\s+gift|paste\s+(?:this|it)\s+in|browser\s+console|run\s+this\s+script|enter\s+your\s+token|cookie\s+logger|verify\s+your\s+(?:account|discord)|account\s+(?:suspended|banned|terminated)|guaranteed\s+(?:profit|returns?|100x)|signal\s+group|crypto\s+group|passive\s+income|i\s+made\s+\d+\s+in)\b/i;

const ACCOUNT_LENDING_RE =
  /\b(?:lend|share|let\s+me\s+(?:use|borrow)|borrow|trial)\s+(?:me\s+|us\s+|your\s+)?(?:your\s+|the\s+)?(?:account|acc|alts?|key|license|premium|cookie|cookies|token|login|password|cred(?:s|ential)?)\b/i;

function normalize(text) {
  return foldConfusableText(String(text || "").toLowerCase()).replace(/\s+/g, " ").trim();
}

function scoreCommercialVerb(text) {
  if (STRONG_VERB_RE.test(text)) return 90;
  if (VALUE_EXCHANGE_RE.test(text) && !NEGATIVE_FOR_CONTEXT_RE.test(text)) return 88;
  if (OFFER_PHRASE_RE.test(text)) return 80;
  if (SOLICITATION_QUESTION_RE.test(text)) return 75;
  if (SOFT_VERB_RE.test(text)) return 50;
  return 0;
}

const IMPERATIVE_OFFER_RE =
  /\b(?:selling|sold|wts|wtb|trading|swap|swapping|reseller|reselling|for\s+sale|taking\s+offers|buy\s+(?:my|from\s+me|off\s+me)|sell\s+(?:to\s+you|to\s+u)|got\s+(?:cheap|spare|extra)\s+(?:kicia|premium|prem|key|account|acc|alts?|config|configs|cfg|exec|executor|executors|script|scripts|nitro|robux|hvh\s+config))\b/i;

const DM_FOR_DEAL_RE =
  /\b(?:dm|dms|message|msg|pm|inbox|add)\s+me\b.{0,40}\b(?:cheap|cheaper|free|kicia|kiciahook|premium|prem|account|acc|alts?|config|configs|cfg|key|keys|license|executor|paypal|cashapp|crypto|robux|nitro|sale|deal|price)\b|\b(?:dms|inbox|pm|hmu)\s+(?:to|for|if)\b.{0,40}\b(?:buy|cheap|cheaper|free|kicia|kiciahook|premium|prem|account|config|key|executor|trade|sell|nitro|robux)\b|\bhmu\b.{0,40}\b(?:cheap|free|kicia|premium|account|config|key|executor|nitro|robux|paypal|cashapp|crypto|sale|deal|price)\b/i;

function scoreSelfAsActor(text, repliedText) {
  if (SELF_ACTOR_NEGATIVE_RE.test(text)) return -90;
  if (REPORT_OR_META_RE.test(text)) return -70;
  if (SELF_ACTOR_POSITIVE_RE.test(text)) return 80;
  if (IMPERATIVE_OFFER_RE.test(text)) return 70;
  if (DM_FOR_DEAL_RE.test(text)) return 70;
  if (SOLICITATION_QUESTION_RE.test(text)) return 70;
  if (VALUE_EXCHANGE_RE.test(text) && !NEGATIVE_FOR_CONTEXT_RE.test(text)) return 70;

  const sayingFromMe = /\b(?:from\s+me|by\s+me|off\s+me)\b/i.test(text);
  const myItem = /\bmy\s+(?:\w+\s+){0,3}(?:kicia|kiciahook|premium|prem|key|license|licence|account|acc|config|configs|cfg|executor|script|robux|nitro)\b/i.test(text);
  if (sayingFromMe) return 70;
  if (myItem) return 50;

  if (ASKER_QUESTION_RE.test(text)) return -50;

  if (/\bi\s+(?:want|wanna|wana|need|just\s+want|jst\s+wana|m\s+looking|am\s+looking)\s+(?:to\s+)?(?:buy|get|purchase|find)\b/.test(text)) return -40;

  return 0;
}

function scoreProtectedItem(text) {
  let score = 0;
  if (PROTECTED_ITEM_STRONG_RE.test(text)) score = Math.max(score, 90);
  if (PROTECTED_ITEM_MID_RE.test(text)) score = Math.max(score, 65);
  if (PROTECTED_ITEM_WEAK_RE.test(text)) score = Math.max(score, 35);

  if (score > 0 && SUPPORT_CONTEXT_RE.test(text) && score < 90) {
    score = Math.max(0, score - 30);
  }

  return score;
}

function scoreExchangeSpec(text, rawText) {
  let score = 0;
  if (PRICE_RE.test(rawText)) score = Math.max(score, 80);
  if (PAYMENT_METHOD_RE.test(text)) score = Math.max(score, 75);
  if (FOR_X_TRADE_RE.test(text)) score = Math.max(score, 70);
  if (CHEAP_PRICE_RE.test(text)) score = Math.max(score, 55);
  return score;
}

function scorePrivateHandoff(text) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hasHandoff = PRIVATE_HANDOFF_RE.test(text);
  const isBareHandoff =
    lines.some((line) => /^(?:dm|dms|pm|pms|inbox)$/i.test(line)) ||
    /\bin\s+(?:dms?|pms?)\b/i.test(text);
  if (!hasHandoff && !isBareHandoff) return 0;
  if (PRIVATE_HANDOFF_BENIGN_RE.test(text) && !DEAL_CONTEXT_NEAR_HANDOFF_RE.test(text)) return 0;
  if (DEAL_CONTEXT_NEAR_HANDOFF_RE.test(text)) return 90;
  return 25;
}

function detectScamPattern(text) {
  if (SCAM_PATTERN_RE.test(text)) {
    return {
      kind: SCAM_PATTERN_RE.exec(text)?.[0] || "scam_pattern",
      score: 95
    };
  }
  if (ACCOUNT_LENDING_RE.test(text)) {
    return { kind: "account_lending", score: 92 };
  }
  return null;
}

const REPLY_SOLICITATION_RE =
  /\b(?:selling|sell|trading|trade|wts|wtb|got|have|need|buying)\s+(?:\w+\s+){0,3}(?:kicia|kiciahook|premium|prem|account|acc|alts?|config|configs|cfg|cfgs|key|keys|license|executor|executors|exec|script|nitro|robux|hvh\s+config)\b|\b(?:anyone|some(?:one|body))\s+(?:selling|sell|trading|trade|got|have|with|sells|wts|wtb)\b|\bwhere\s+(?:can\s+i|to|do\s+i|is|are)\s+(?:the\s+|a\s+|an\s+)?(?:buy|get|find|download|cheap\s+|good\s+)?\s*(?:kicia|kiciahook|premium|account|key|keys|executor|executors|exec|config|configs|cfg|cfgs|robux|nitro|link|script|scripts)\s*(?:link|download)?\b|\b(?:how)\s+(?:do\s+i\s+(?:get|find|buy)|to\s+(?:get|find|buy))\s+(?:the\s+)?(?:kicia|kiciahook|premium|account|key|executor|config|cfg|cfgs|script|robux|nitro|link)\b|\bany\s+(?:cheap|good|spare|extra)\s+(?:kicia|premium|key|account|executor|config|cfg|cfgs|nitro|robux)\b/i;

function detectReplySolicitation(repliedNorm) {
  if (!repliedNorm) return false;
  return REPLY_SOLICITATION_RE.test(repliedNorm);
}

function extractFeatures({ rawTexts, repliedToContent }) {
  const rawCombined = (Array.isArray(rawTexts) ? rawTexts : [rawTexts])
    .map((t) => String(t || ""))
    .filter(Boolean)
    .join("\n");
  const normRaw = normalize(rawCombined);
  const repliedNorm = normalize(repliedToContent || "");

  const deob = deobfuscateMany(rawTexts);
  const cleaned = deob.cleaned ? `${normRaw}\n${deob.cleaned}` : normRaw;

  const replySolicitation = detectReplySolicitation(repliedNorm);

  let selfAsActor = scoreSelfAsActor(cleaned, repliedNorm);
  let protectedItem = scoreProtectedItem(cleaned);
  let privateHandoff = scorePrivateHandoff(cleaned);

  if (replySolicitation && privateHandoff >= 25) {
    selfAsActor = Math.max(selfAsActor, 70);
    privateHandoff = Math.max(privateHandoff, 80);
    if (protectedItem < 50) {
      const replyItem = scoreProtectedItem(repliedNorm);
      protectedItem = Math.max(protectedItem, Math.min(80, replyItem));
    }
  }

  const features = {
    rawText: rawCombined,
    normalizedText: normRaw,
    cleanedText: cleaned,
    repliedText: repliedNorm,
    replySolicitation,
    obfuscation: deob.score,
    revealedHighValue: deob.revealedHighValue,
    commercial_verb: scoreCommercialVerb(cleaned),
    self_as_actor: selfAsActor,
    protected_item: protectedItem,
    exchange_spec: scoreExchangeSpec(cleaned, rawCombined),
    private_handoff: privateHandoff,
    scam_pattern: detectScamPattern(cleaned)
  };

  return features;
}

function computeScamScore(features) {
  if (features.scam_pattern) {
    return {
      score: features.scam_pattern.score,
      label: `scam_pattern:${features.scam_pattern.kind}`,
      hardConfirm: true,
      signals: ["scam_pattern"]
    };
  }

  if (features.self_as_actor <= -70) {
    return {
      score: 0,
      label: "negation_or_report",
      hardConfirm: false,
      signals: []
    };
  }

  if (features.obfuscation >= 60 && features.revealedHighValue && features.protected_item >= 40) {
    return {
      score: 95,
      label: "obfuscated_scam",
      hardConfirm: true,
      signals: ["obfuscation", "protected_item", "commercial_verb"]
    };
  }

  const fired = [];
  if (features.commercial_verb >= 50) fired.push("commercial_verb");
  if (features.self_as_actor >= 50) fired.push("self_as_actor");
  if (features.protected_item >= 50) fired.push("protected_item");
  if (features.exchange_spec >= 50) fired.push("exchange_spec");
  if (features.private_handoff >= 50) fired.push("private_handoff");
  if (features.obfuscation >= 40) fired.push("obfuscation");

  if (fired.length < 3) {
    return {
      score: 0,
      label: `below_threshold:${fired.length}`,
      hardConfirm: false,
      signals: fired
    };
  }

  if (features.self_as_actor < 30 && !fired.includes("obfuscation")) {
    return {
      score: 25,
      label: "no_actor_evidence",
      hardConfirm: false,
      signals: fired
    };
  }

  let score = 0;
  if (features.commercial_verb >= 50) score += 18;
  if (features.self_as_actor >= 50) score += 22;
  if (features.protected_item >= 50) score += 18;
  if (features.exchange_spec >= 50) score += 16;
  if (features.private_handoff >= 50) score += 14;
  if (features.obfuscation >= 40) score += 12;

  if (features.commercial_verb >= 80) score += 4;
  if (features.protected_item >= 85) score += 4;
  if (features.private_handoff >= 80) score += 4;

  score = Math.max(0, Math.min(99, score));

  const hardConfirm = score >= 85 || (fired.length >= 4 && features.self_as_actor >= 50 && features.protected_item >= 50);

  return {
    score,
    label: "decomposed",
    hardConfirm,
    signals: fired
  };
}

function classify({ rawTexts, repliedToContent }) {
  const features = extractFeatures({ rawTexts, repliedToContent });
  const result = computeScamScore(features);

  return {
    ...result,
    features
  };
}

module.exports = {
  classify,
  extractFeatures,
  computeScamScore
};
