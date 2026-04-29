"use strict";

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/gi;
const MONEY_RE = /(?:[$€£]\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?\s*(?:usd|eur|gbp|dollars?|bucks?|rs|lkr|robux|rbx)\b)/gi;

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
  "selling kicia license dm me",
  "trading kicia key for account",
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
  "official kicia purchase question"
];

const KICIA_BRAND_RE = /\b(?:kicia|kiciahook)\b/i;
const KICIA_PURCHASE_RE =
  /\b(?:buy|buying|bought|purchase|purchasing|pay|paid|payment|price|prices|cost|costs|shop|store|premium|license|licence|key|subscription|sub|upgrade|get|getting)\b/i;
const KICIA_DEAL_RISK_RE =
  /\b(?:sell|selling|sold|wts|wtb|trade|trading|swap|middleman|mm|dm|dms|message\s+me|from\s+me|account|accounts|acc|alts?|config|configs|cfg|script|executor|cheap|cheaper|robux|rbx|nitro|paypal|cashapp|crypto|btc|eth)\b/i;

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
      model: "local-naive-bayes-v1"
    };
  }

  if (isKiciaLegitPurchaseIntent(context.userMessages || text)) {
    return {
      verdict: false,
      confidence: 97,
      score: 0.01,
      reason: "Legitimate Kicia purchase intent.",
      model: "local-naive-bayes-v1"
    };
  }

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
      model: "local-naive-bayes-v1"
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
      model: "local-naive-bayes-v1"
    };
  }

  if (score <= 0.08) {
    return {
      verdict: false,
      confidence: Math.max(92, Math.round((1 - score) * 100)),
      score,
      reason: "Local classifier matched safe/support intent.",
      model: "local-naive-bayes-v1"
    };
  }

  return {
    verdict: null,
    confidence: Math.round(Math.max(score, 1 - score) * 100),
    score,
    reason: "Borderline local classifier result; remote AI may be useful.",
    model: "local-naive-bayes-v1"
  };
}

module.exports = {
  classifyScamContextLocally,
  isKiciaLegitPurchaseIntent,
  normalizeClassifierText,
  probabilityForScam
};
