"use strict";

/**
 * Generic text embedding pipeline (MiniLM via @huggingface/transformers).
 * Single shared loader used by the KB semantic index. The scam-* classifiers
 * have been removed; this module is the surviving carrier of the embedder.
 */

const {
  KB_EMBED_MODEL_ID,
  KB_EMBED_TIMEOUT_MS
} = require("./config");
const { recordRuntimeEvent } = require("./runtime-health");

let embedderPromise = null;
let _embedderOverride = null;

function __setEmbedderForTests(fn) {
  _embedderOverride = fn;
  embedderPromise = null;
}

function __resetForTests() {
  _embedderOverride = null;
  embedderPromise = null;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`embedder timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function getTimeoutMs() {
  return Math.max(250, Math.round(Number(KB_EMBED_TIMEOUT_MS) || 1500));
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
      return pipeline("feature-extraction", KB_EMBED_MODEL_ID, { quantized: true });
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

async function preloadEmbedder() {
  try {
    await loadEmbedder();
    recordRuntimeEvent("info", "embedder", `loaded ${KB_EMBED_MODEL_ID}`);
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "embedder", err?.message || err);
    return false;
  }
}

module.exports = {
  loadEmbedder,
  embedText,
  cosineSim,
  preloadEmbedder,
  __setEmbedderForTests,
  __resetForTests
};
