"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  ENABLE_SCAM_EMBED_CLASSIFIER,
  SCAM_EMBED_MODEL_ID,
  SCAM_EMBED_TIMEOUT_MS,
  SCAM_EMBED_CACHE_PATH,
  SCAM_EMBED_TOP_K
} = require("./config");
const { recordRuntimeEvent } = require("./runtime-health");

let embedderPromise = null;
let embedderReady = false;

let _embedderOverride = null;

function __setEmbedderForTests(fn) {
  _embedderOverride = fn;
  embedderReady = true;
  embedderPromise = null;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`scam embed model timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getTimeoutMs() {
  return Math.max(250, Math.round(Number(SCAM_EMBED_TIMEOUT_MS) || 1500));
}

async function loadEmbedder() {
  if (_embedderOverride) return _embedderOverride;
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const transformers = await import("@huggingface/transformers");
      const pipeline = transformers.pipeline || transformers.default?.pipeline;
      if (typeof pipeline !== "function") {
        throw new Error("Transformers.js pipeline export not found");
      }
      return pipeline("feature-extraction", SCAM_EMBED_MODEL_ID, { quantized: true });
    })();
  }
  return embedderPromise;
}

async function embedText(text) {
  const timeoutMs = getTimeoutMs();
  const fn = _embedderOverride || await withTimeout(loadEmbedder(), timeoutMs);
  const output = await withTimeout(
    fn(String(text || "").slice(0, 512), { pooling: "mean", normalize: true }),
    timeoutMs
  );

  let flat;
  if (output && typeof output.tolist === "function") {
    const list = output.tolist();
    flat = Array.isArray(list[0]) ? list[0] : list;
  } else if (output && output.data) {
    flat = Array.from(output.data);
  } else if (Array.isArray(output)) {
    flat = Array.isArray(output[0]) ? output[0] : output;
  } else {
    flat = [];
  }

  const vec = new Float32Array(flat.length);
  for (let i = 0; i < flat.length; i++) vec[i] = Number(flat[i]) || 0;

  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;

  return vec;
}

function cosineSim(a, b) {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

function buildContextText(context = {}) {
  if (Array.isArray(context.messageContexts) && context.messageContexts.length) {
    return context.messageContexts
      .map((entry) => {
        const reply = entry?.repliedToMessage?.content
          ? `reply context: ${entry.repliedToMessage.content}`
          : "";
        return [entry?.content, reply].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n");
  }
  const userMessages = Array.isArray(context.userMessages) ? context.userMessages : [];
  const replyText = context.repliedToMessage?.content
    ? `reply context: ${context.repliedToMessage.content}`
    : "";
  return [...userMessages, replyText].filter(Boolean).join("\n");
}

function isEmbedderReady() {
  return embedderReady;
}

let prototypeIndex = null;

async function buildPrototypeIndex({ samples, harvested = [] }) {
  const vectors = [];
  const labels = [];
  const texts = [];

  for (const { text, label } of [...samples, ...harvested]) {
    const vec = await embedText(text);
    vectors.push(vec);
    labels.push(label);
    texts.push(text);
  }

  return { vectors, labels, texts };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildCacheHash(modelId, scamSamples, safeSamples, harvestedSignature) {
  return sha256(modelId + JSON.stringify(scamSamples) + JSON.stringify(safeSamples) + harvestedSignature);
}

async function loadOrBuildCache() {
  if (!ENABLE_SCAM_EMBED_CLASSIFIER) return null;

  const { SCAM_SAMPLES, SAFE_SAMPLES } = require("./scam-local-classifier");
  const { listScamDecisionAudit } = require("./restricted-emoji-db");

  const POSITIVE_LABELS = new Set(["true_positive", "missed"]);
  const NEGATIVE_LABELS = new Set(["false_positive", "safe"]);

  let harvested = [];
  let harvestedSignature = "empty";
  try {
    const auditRows = await listScamDecisionAudit({ limit: 1000, labeledOnly: true });
    for (const row of auditRows) {
      const label = row.review?.label;
      if (!POSITIVE_LABELS.has(label) && !NEGATIVE_LABELS.has(label)) continue;
      const text = (
        Array.isArray(row.recentMessages) && row.recentMessages.length
          ? row.recentMessages.join(" ")
          : row.messageContent || ""
      ).trim();
      if (!text) continue;
      harvested.push({ text, label: POSITIVE_LABELS.has(label) ? 1 : -1 });
    }
    harvestedSignature = sha256(JSON.stringify(harvested.map((h) => h.text + h.label)));
  } catch {
    harvested = [];
    harvestedSignature = "empty";
  }

  const cacheHash = buildCacheHash(SCAM_EMBED_MODEL_ID, SCAM_SAMPLES, SAFE_SAMPLES, harvestedSignature);
  const cachePath = path.isAbsolute(SCAM_EMBED_CACHE_PATH)
    ? SCAM_EMBED_CACHE_PATH
    : path.resolve(__dirname, "..", SCAM_EMBED_CACHE_PATH);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (raw.hash === cacheHash && Array.isArray(raw.prototypes)) {
      const vectors = [];
      const labels = [];
      const texts = [];
      for (const p of raw.prototypes) {
        vectors.push(new Float32Array(p.vector));
        labels.push(p.label);
        texts.push(p.text);
      }
      prototypeIndex = { vectors, labels, texts };
      embedderReady = true;
      return prototypeIndex;
    }
  } catch {
    // cache miss — encode from scratch
  }

  const timeoutMs = getTimeoutMs();
  await withTimeout(loadEmbedder(), Math.max(30_000, timeoutMs));
  embedderReady = true;

  const labeledSamples = [
    ...SCAM_SAMPLES.map((text) => ({ text, label: 1 })),
    ...SAFE_SAMPLES.map((text) => ({ text, label: -1 }))
  ];

  const index = await buildPrototypeIndex({ samples: labeledSamples, harvested });
  prototypeIndex = index;

  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const cacheData = {
      hash: cacheHash,
      modelId: SCAM_EMBED_MODEL_ID,
      prototypes: index.texts.map((text, i) => ({
        text,
        label: index.labels[i],
        vector: Array.from(index.vectors[i])
      }))
    };
    fs.writeFileSync(cachePath, JSON.stringify(cacheData), "utf8");
  } catch (err) {
    recordRuntimeEvent("warn", "scam-embed-cache-write", err?.message || err);
  }

  return prototypeIndex;
}

function knnClassify(queryVec) {
  const { vectors, labels, texts } = prototypeIndex;
  const k = Math.max(1, Math.round(Number(SCAM_EMBED_TOP_K) || 7));

  const sims = vectors.map((vec, i) => ({
    sim: cosineSim(queryVec, vec),
    label: labels[i],
    text: texts[i]
  }));
  sims.sort((a, b) => b.sim - a.sim);
  const topK = sims.slice(0, k);

  let weightedSum = 0;
  let simTotal = 0;
  for (const { sim, label } of topK) {
    weightedSum += sim * label;
    simTotal += Math.abs(sim);
  }

  const score = simTotal > 0 ? (weightedSum / simTotal + 1) / 2 : 0.5;

  const scamNeighbors = topK.filter((n) => n.label === 1);
  const safeNeighbors = topK.filter((n) => n.label === -1);
  const topScamMean = scamNeighbors.length
    ? scamNeighbors.reduce((s, n) => s + n.sim, 0) / scamNeighbors.length
    : 0;
  const topSafeMean = safeNeighbors.length
    ? safeNeighbors.reduce((s, n) => s + n.sim, 0) / safeNeighbors.length
    : 0;
  const margin = Math.abs(topScamMean - topSafeMean);

  const nearest = topK[0];
  const nearestSnippet = nearest ? String(nearest.text || "").slice(0, 80) : "";
  const reason = nearestSnippet
    ? `Nearest prototype: "${nearestSnippet}"`
    : "Embeddings KNN classification.";

  return { score, margin, reason };
}

function verdictFromScore(score, margin, reason) {
  if (score >= 0.78 && margin >= 0.08) {
    return {
      verdict: true,
      confidence: Math.min(99, Math.round(score * 100)),
      score,
      reason,
      stage: "embeddings",
      model: "local-kicia-embed-v1"
    };
  }
  if (score <= 0.22 && margin >= 0.08) {
    return {
      verdict: false,
      confidence: Math.min(99, Math.round((1 - score) * 100)),
      score,
      reason,
      stage: "embeddings",
      model: "local-kicia-embed-v1"
    };
  }
  return {
    verdict: null,
    confidence: Math.round(Math.max(score, 1 - score) * 100),
    score,
    reason,
    stage: "embeddings",
    model: "local-kicia-embed-v1"
  };
}

async function classifyScamContextWithEmbeddings(context = {}) {
  const text = buildContextText(context);

  if (!text.trim()) {
    return {
      verdict: null,
      confidence: 0,
      score: 0.5,
      reason: "No text available for embeddings classifier.",
      stage: "embeddings",
      model: "local-kicia-embed-v1"
    };
  }

  if (!prototypeIndex) {
    return {
      verdict: null,
      confidence: 0,
      score: 0.5,
      reason: "Prototype index not loaded.",
      stage: "embeddings",
      model: "local-kicia-embed-v1"
    };
  }

  let queryVec;
  try {
    queryVec = await embedText(text);
  } catch {
    return {
      verdict: null,
      confidence: 0,
      score: 0.5,
      reason: "Embeddings query failed.",
      stage: "embeddings",
      model: "local-kicia-embed-v1"
    };
  }

  const { score, margin, reason } = knnClassify(queryVec);
  return verdictFromScore(score, margin, reason);
}

function classifyScamContextWithEmbeddingsSync(queryVec) {
  if (!prototypeIndex || !queryVec) {
    return {
      verdict: null,
      confidence: 0,
      score: 0.5,
      reason: "Prototype index not loaded.",
      stage: "embeddings",
      model: "local-kicia-embed-v1"
    };
  }
  const { score, margin, reason } = knnClassify(queryVec);
  return verdictFromScore(score, margin, reason);
}

function __setPrototypeIndexForTests(index) {
  prototypeIndex = index;
}

function resetScamEmbedStateForTests() {
  prototypeIndex = null;
  embedderReady = false;
  embedderPromise = null;
  _embedderOverride = null;
}

module.exports = {
  loadEmbedder,
  embedText,
  buildPrototypeIndex,
  loadOrBuildCache,
  classifyScamContextWithEmbeddings,
  classifyScamContextWithEmbeddingsSync,
  isEmbedderReady,
  buildCacheHash,
  __setEmbedderForTests,
  __setPrototypeIndexForTests,
  resetScamEmbedStateForTests
};
