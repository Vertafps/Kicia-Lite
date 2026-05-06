const {
  ENABLE_TOXICITY_SHADOW_MODEL,
  TOXICITY_MODEL_ID,
  TOXICITY_MODEL_TIMEOUT_MS
} = require("./config");
const { recordRuntimeEvent } = require("./runtime-health");

let classifierPromise = null;

function getToxicityTimeoutMs() {
  return Math.max(250, Math.round(Number(TOXICITY_MODEL_TIMEOUT_MS) || 2500));
}

async function loadClassifier() {
  if (!classifierPromise) {
    classifierPromise = (async () => {
      const transformers = await import("@huggingface/transformers");
      const pipeline = transformers.pipeline || transformers.default?.pipeline;
      if (typeof pipeline !== "function") {
        throw new Error("Transformers.js pipeline export not found");
      }
      return pipeline("text-classification", TOXICITY_MODEL_ID);
    })();
  }
  return classifierPromise;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`toxicity shadow model timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function flattenModelOutput(output) {
  if (!Array.isArray(output)) return output ? [output] : [];
  return output.flatMap((entry) => Array.isArray(entry) ? flattenModelOutput(entry) : [entry]);
}

function normalizeToxicityModelOutput(output, model = TOXICITY_MODEL_ID) {
  const entries = flattenModelOutput(output)
    .map((entry) => ({
      label: String(entry?.label || "").toLowerCase(),
      score: Number(entry?.score || 0)
    }))
    .filter((entry) => entry.label && Number.isFinite(entry.score));

  if (!entries.length) {
    return {
      attempted: true,
      model,
      label: "unknown",
      score: 0,
      confidence: 0
    };
  }

  const toxicLabels = entries.filter((entry) =>
    /toxic|insult|obscene|threat|hate|severe|sexual|identity/i.test(entry.label)
  );
  const best = (toxicLabels.length ? toxicLabels : entries)
    .sort((a, b) => b.score - a.score)[0];

  return {
    attempted: true,
    model,
    label: best.label,
    score: best.score,
    confidence: Math.max(0, Math.min(100, Math.round(best.score * 100))),
    labels: entries
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
  };
}

async function maybeClassifyToxicityShadow(content, {
  candidate = false,
  timeoutMs = getToxicityTimeoutMs()
} = {}) {
  if (!ENABLE_TOXICITY_SHADOW_MODEL) {
    return {
      attempted: false,
      skipped: "disabled"
    };
  }
  if (!candidate) {
    return {
      attempted: false,
      skipped: "not_candidate"
    };
  }

  try {
    const classifier = await withTimeout(loadClassifier(), timeoutMs);
    const output = await withTimeout(classifier(String(content || "").slice(0, 700)), timeoutMs);
    return normalizeToxicityModelOutput(output);
  } catch (err) {
    classifierPromise = null;
    recordRuntimeEvent("warn", "toxicity-shadow-model", err?.message || err);
    return {
      attempted: true,
      skipped: "error",
      error: err?.message || String(err),
      model: TOXICITY_MODEL_ID
    };
  }
}

module.exports = {
  maybeClassifyToxicityShadow,
  normalizeToxicityModelOutput
};
