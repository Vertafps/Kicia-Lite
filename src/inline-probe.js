const DIM = 384;

// mulberry32 seeded prng
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sigmoid(x) {
  if (x >= 0) {
    const e = Math.exp(-x);
    return 1 / (1 + e);
  }
  const e = Math.exp(x);
  return e / (1 + e);
}

function dotProduct(a, b) {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function validateSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("inline-probe: no samples");
  }
  const expectedLen = samples[0].vector.length;
  let hasZero = false;
  let hasOne = false;
  for (const s of samples) {
    if (s.vector.length !== expectedLen) {
      throw new Error(
        `inline-probe: vector length mismatch (expected ${expectedLen}, got ${s.vector.length})`
      );
    }
    if (s.label === 0) hasZero = true;
    else if (s.label === 1) hasOne = true;
  }
  if (!hasZero || !hasOne) {
    throw new Error("inline-probe: degenerate label distribution");
  }
  return expectedLen;
}

function computeMetrics(predictions) {
  let tp = 0, fp = 0, fn = 0;
  for (const { prob, label } of predictions) {
    const pred = prob >= 0.5 ? 1 : 0;
    if (pred === 1 && label === 1) tp++;
    else if (pred === 1 && label === 0) fp++;
    else if (pred === 0 && label === 1) fn++;
  }
  const precision = (tp + fp) === 0 ? 0 : tp / (tp + fp);
  const recall = (tp + fn) === 0 ? 0 : tp / (tp + fn);
  const f1 = (precision + recall) === 0 ? 0 : 2 * precision * recall / (precision + recall);
  const auc = computeAUC(predictions);
  return { precision, recall, f1, auc };
}

function computeAUC(predictions) {
  const sorted = predictions.slice().sort((a, b) => b.prob - a.prob);
  const totalPos = sorted.reduce((s, p) => s + p.label, 0);
  const totalNeg = sorted.length - totalPos;
  if (totalPos === 0 || totalNeg === 0) return 0.5;

  let tpr = 0, fpr = 0, prevTpr = 0, prevFpr = 0;
  let auc = 0;

  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].label === 1) tpr += 1 / totalPos;
    else fpr += 1 / totalNeg;

    // accumulate trapezoid area on threshold change
    const isLast = i === sorted.length - 1;
    const isThreshChange = isLast || sorted[i].prob !== sorted[i + 1].prob;
    if (isThreshChange) {
      auc += (fpr - prevFpr) * (tpr + prevTpr) / 2;
      prevFpr = fpr;
      prevTpr = tpr;
    }
  }
  return Math.max(0, Math.min(1, auc));
}

function trainSGD(samples, dim, options) {
  const {
    epochs = 200,
    lr = 0.01,
    l2 = 0.001,
    batchSize = 32,
    seed = 42,
    validationFraction = 0.2
  } = options || {};

  const rng = mulberry32(seed);

  const indices = Array.from({ length: samples.length }, (_, i) => i);
  shuffle(indices, mulberry32(seed + 1));
  const valCount = Math.max(0, Math.floor(samples.length * validationFraction));
  const valIndices = new Set(indices.slice(0, valCount));

  const trainSamples = samples.filter((_, i) => !valIndices.has(i));
  const valSamples = samples.filter((_, i) => valIndices.has(i));

  const W = new Float64Array(dim);
  let b = 0;

  const mW = new Float64Array(dim);
  const vW = new Float64Array(dim);
  let mB = 0, vB = 0;

  const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;
  let t = 0;

  let bestValLoss = Infinity;
  let patienceCounter = 0;
  const patience = 20;
  let bestW = new Float64Array(W);
  let bestB = b;

  const shuffledIdx = Array.from({ length: trainSamples.length }, (_, i) => i);

  for (let epoch = 0; epoch < epochs; epoch++) {
    shuffle(shuffledIdx, rng);

    for (let start = 0; start < trainSamples.length; start += batchSize) {
      const end = Math.min(start + batchSize, trainSamples.length);
      const bs = end - start;
      t++;

      const gW = new Float64Array(dim);
      let gB = 0;

      for (let k = start; k < end; k++) {
        const s = trainSamples[shuffledIdx[k]];
        const z = dotProduct(W, s.vector) + b;
        const p = sigmoid(z);
        const err = p - s.label;
        for (let j = 0; j < dim; j++) gW[j] += err * s.vector[j];
        gB += err;
      }

      for (let j = 0; j < dim; j++) {
        gW[j] = gW[j] / bs + l2 * W[j];
      }
      gB /= bs;

      const bc1 = 1 - Math.pow(beta1, t);
      const bc2 = 1 - Math.pow(beta2, t);
      for (let j = 0; j < dim; j++) {
        mW[j] = beta1 * mW[j] + (1 - beta1) * gW[j];
        vW[j] = beta2 * vW[j] + (1 - beta2) * gW[j] * gW[j];
        const mHat = mW[j] / bc1;
        const vHat = vW[j] / bc2;
        W[j] -= lr * mHat / (Math.sqrt(vHat) + eps);
      }

      mB = beta1 * mB + (1 - beta1) * gB;
      vB = beta2 * vB + (1 - beta2) * gB * gB;
      b -= lr * (mB / bc1) / (Math.sqrt(vB / bc2) + eps);
    }

    if (valSamples.length > 0) {
      let valLoss = 0;
      for (const s of valSamples) {
        const p = sigmoid(dotProduct(W, s.vector) + b);
        const clipped = Math.max(1e-15, Math.min(1 - 1e-15, p));
        valLoss -= s.label * Math.log(clipped) + (1 - s.label) * Math.log(1 - clipped);
      }
      valLoss /= valSamples.length;

      if (valLoss < bestValLoss - 1e-6) {
        bestValLoss = valLoss;
        patienceCounter = 0;
        bestW = new Float64Array(W);
        bestB = b;
      } else {
        patienceCounter++;
        if (patienceCounter >= patience) break;
      }
    }
  }

  if (valSamples.length > 0) {
    W.set(bestW);
    b = bestB;
  }

  return { W, b };
}

function trainLogisticHead(samples, options) {
  const dim = validateSamples(samples);
  const { W, b } = trainSGD(samples, dim, options || {});

  const predictions = samples.map((s) => ({
    prob: sigmoid(dotProduct(W, s.vector) + b),
    label: s.label
  }));
  const metrics = computeMetrics(predictions);

  return {
    W: Array.from(W),
    b,
    version: 1,
    trainedAt: Date.now(),
    n: samples.length,
    metrics
  };
}

function scoreLogisticHead(vector, head) {
  return sigmoid(dotProduct(head.W, vector) + head.b);
}

function trainAndCrossValidate(samples, options) {
  const dim = validateSamples(samples);
  const opts = options || {};
  const { seed = 42 } = opts;

  const FOLDS = 5;

  if (samples.length < 10) {
    const head = trainLogisticHead(samples, opts);
    return { head, metrics: head.metrics, threshold: 0.5 };
  }

  const indices = Array.from({ length: samples.length }, (_, i) => i);
  shuffle(indices, mulberry32(seed));

  const foldSize = Math.floor(samples.length / FOLDS);
  const allPredictions = new Array(samples.length);

  for (let fold = 0; fold < FOLDS; fold++) {
    const valStart = fold * foldSize;
    const valEnd = fold === FOLDS - 1 ? samples.length : valStart + foldSize;
    const valSet = new Set(indices.slice(valStart, valEnd));

    const trainSamplesCV = samples.filter((_, i) => !valSet.has(i));
    const valSamplesCV = indices.slice(valStart, valEnd).map((i) => samples[i]);

    const { W, b } = trainSGD(trainSamplesCV, dim, { ...opts, seed: seed + fold + 1 });

    for (let vi = 0; vi < valSamplesCV.length; vi++) {
      const s = valSamplesCV[vi];
      const prob = sigmoid(dotProduct(W, s.vector) + b);
      const origIdx = indices[valStart + vi];
      allPredictions[origIdx] = { prob, label: s.label };
    }
  }

  const metrics = computeMetrics(allPredictions);

  // sweep: smallest threshold with precision >= 0.95, fall back to best F1
  let bestThreshold = null;
  let bestF1Threshold = 0.5;
  let bestF1 = -Infinity;

  for (let step = 1; step <= 99; step++) {
    const thresh = step / 100;
    let tp = 0, fp = 0, fn = 0;
    for (const { prob, label } of allPredictions) {
      const pred = prob >= thresh ? 1 : 0;
      if (pred === 1 && label === 1) tp++;
      else if (pred === 1 && label === 0) fp++;
      else if (pred === 0 && label === 1) fn++;
    }
    const prec = (tp + fp) === 0 ? 0 : tp / (tp + fp);
    const rec = (tp + fn) === 0 ? 0 : tp / (tp + fn);
    const f1 = (prec + rec) === 0 ? 0 : 2 * prec * rec / (prec + rec);

    if (f1 > bestF1) {
      bestF1 = f1;
      bestF1Threshold = thresh;
    }

    if (bestThreshold === null && prec >= 0.95) {
      bestThreshold = thresh;
    }
  }

  const threshold = bestThreshold !== null ? bestThreshold : bestF1Threshold;

  const finalHead = trainLogisticHead(samples, opts);

  return { head: finalHead, metrics, threshold };
}

module.exports = {
  trainLogisticHead,
  scoreLogisticHead,
  sigmoid,
  dotProduct,
  trainAndCrossValidate,
  __internals: {
    trainSGD,
    computeMetrics,
    mulberry32
  }
};
