"use strict";

/**
 * example banks for the scam-trade and kicia-disrespect classifiers.
 *
 * each bank is a fixed 30-string seed embedded once at boot via the shared
 * minilm pipeline. vectors are cached on disk keyed by sha256 of
 * (modelId + concatenated bank texts) — bump any bank string and the cache
 * rebuilds automatically.
 *
 * cache layout mirrors `src/kb-embeddings.js`: a single json file holding
 * `{hash, modelId, banks: {scamSell, scamBuy, respectDisrespect, respectNeutral}}`
 * where each list entry is `{text, vector: number[]}`. vectors rehydrate
 * back to float32array on load.
 *
 * banks are lazily exposed via `getBank(name)` — callers see null until
 * `preloadExampleBanks()` resolves. classifiers fall back to a pattern-only
 * path while banks are cold.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { KB_EMBED_MODEL_ID } = require("./config");
const { embedText, loadEmbedder } = require("./embeddings");
const { recordRuntimeEvent } = require("./runtime-health");

const CACHE_PATH = path.resolve(__dirname, "..", "data", "example-banks-cache.json");

// ---------------------------------------------------------------------------
// bank text — verbatim from the user's spec / plan §phase-2 + §phase-3.
// order is significant: it feeds the cache hash. don't reorder without
// bumping the hash (which happens automatically because the joined text
// changes too, but be aware that doing so invalidates the on-disk cache).
// ---------------------------------------------------------------------------

const SCAM_SELL_BANK = [
  "selling kicia dm me",
  "wts kicia for ue",
  "wts kicia hook lifetime",
  "trading kicia for fluxus",
  "selling my kicia key",
  "kicia for sale dm",
  "lf trade kicia for ue",
  "swapping kicia for hydrogen",
  "who wants my kicia key",
  "dm if u want my kicia",
  "taking offers on kicia",
  "selling lifetime kicia",
  "cashapp for kicia",
  "paypal for kicia",
  "kicia 10 usd dm me",
  "kicia key cheap dm",
  "exchange kicia for ue",
  "wts v3 lifetime",
  "wts v4 cheap",
  "selling v3 dm me",
  "trading kiciahook",
  "kicia plug here",
  "vendor kicia keys",
  "for sale: kicia",
  "msg me for kicia",
  "selling kicia + ue",
  "kicia for robux dm",
  "trade kicia for ue",
  "kicia trade pm me",
  "who wants to buy my kicia"
];

const SCAM_BUY_BANK = [
  "where can i buy kicia",
  "how much is kicia",
  "is kicia free",
  "is kicia paid",
  "kicia better than ue?",
  "how do i get kicia",
  "what is kicia price",
  "kicia cost",
  "cost of kicia",
  "is kicia worth buying",
  "where to get kicia",
  "can i pay with robux",
  "how do you purchase kicia",
  "is there a kicia trial",
  "is kicia subscription",
  "is kicia lifetime",
  "is kicia coming back",
  "is v3 paid",
  "is v4 free",
  "how to download kicia",
  "anyone know kicia link",
  "official kicia site",
  "is kicia legit",
  "is kicia safe",
  "kicia vs hydrogen",
  "compare kicia ue",
  "kicia review",
  "how good is kicia",
  "should i buy kicia",
  "is kicia good"
];

const RESPECT_DISRESPECT_BANK = [
  "kicia is trash",
  "kicia is garbage",
  "kicia is mid",
  "kicia is dogshit",
  "kicia is ass",
  "v3 is buns",
  "v3 is mid",
  "v3 is dogshit",
  "v4 is trash",
  "v4 is ass",
  "kiciahook sucks",
  "kicia sucks now",
  "kicia is bad",
  "kicia is dead",
  "kicia is cooked",
  "kicia is dying",
  "kicia is overrated",
  "v3 is overrated",
  "kicia is so bad",
  "kicia literally trash",
  "kicia honestly mid",
  "v3 is literally ass",
  "kicia is broken",
  "v3 is broken garbage",
  "kicia is a scam",
  "kicia is a ripoff",
  "kicia is shit",
  "v3 sucks ass",
  "hook is dogshit",
  "hook is buns"
];

const RESPECT_NEUTRAL_BANK = [
  "kicia is good",
  "kicia is great",
  "v3 works fine",
  "v4 is solid",
  "kicia is the best",
  "kiciahook is reliable",
  "v3 had a bug",
  "v3 has a bug",
  "v3 not working today",
  "kicia not loading",
  "is kicia working",
  "is v3 down",
  "why is v3 not working",
  "how to fix kicia",
  "kicia better than ue",
  "kicia is goated",
  "kicia is peak",
  "kicia is fire",
  "wish kicia had x",
  "i hope kicia adds y",
  "kicia needs feature z",
  "is kicia safe",
  "is kicia paid",
  "how much is kicia",
  "kicia review",
  "kicia vs ue",
  "v3 update when",
  "v3 ETA?",
  "kicia outage",
  "kicia down rn"
];

// canonical (bank-name) -> internal/public-snapshot key mapping. the
// internal store uses kebab-case names that match the `getBank(name)`
// contract; the boot-summary snapshot uses camelCase for the counts shape
// the caller asked for.
const BANK_DEFINITIONS = [
  { name: "scam-sell",          camelKey: "scamSell",          texts: SCAM_SELL_BANK },
  { name: "scam-buy",           camelKey: "scamBuy",           texts: SCAM_BUY_BANK },
  { name: "respect-disrespect", camelKey: "respectDisrespect", texts: RESPECT_DISRESPECT_BANK },
  { name: "respect-neutral",    camelKey: "respectNeutral",    texts: RESPECT_NEUTRAL_BANK }
];

const BANK_NAMES = new Set(BANK_DEFINITIONS.map((b) => b.name));

// ---------------------------------------------------------------------------
// in-memory state
// ---------------------------------------------------------------------------

const state = {
  banks: null,        // { kebab-name -> [{text, vector: Float32Array}, ...] }
  hash: null,
  ready: false,
  loadPromise: null
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function computeBanksHash() {
  // all bank texts in a single canonical blob, prefixed with the model id
  // so swapping the embedder also invalidates the cache.
  const allTexts = BANK_DEFINITIONS.map((b) => b.texts);
  return sha256(KB_EMBED_MODEL_ID + "|" + JSON.stringify(allTexts));
}

// ---------------------------------------------------------------------------
// disk cache
// ---------------------------------------------------------------------------

function loadFromDisk(expectedHash) {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    if (!raw || raw.hash !== expectedHash || !raw.banks) return null;
    if (raw.modelId && raw.modelId !== KB_EMBED_MODEL_ID) return null;

    const banks = {};
    for (const def of BANK_DEFINITIONS) {
      const list = raw.banks[def.camelKey];
      if (!Array.isArray(list) || list.length !== def.texts.length) return null;
      const entries = [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (!item || typeof item.text !== "string") return null;
        if (!Array.isArray(item.vector) || !item.vector.length) return null;
        entries.push({
          text: item.text,
          vector: new Float32Array(item.vector)
        });
      }
      banks[def.name] = entries;
    }
    return banks;
  } catch {
    return null;
  }
}

function persistToDisk(hash, banks) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const out = { hash, modelId: KB_EMBED_MODEL_ID, banks: {} };
    for (const def of BANK_DEFINITIONS) {
      const list = banks[def.name] || [];
      out.banks[def.camelKey] = list.map((entry) => ({
        text: entry.text,
        vector: Array.from(entry.vector)
      }));
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify(out), "utf8");
  } catch (err) {
    recordRuntimeEvent("warn", "example-banks", `cache-write failed · ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// build path — runs once when the disk cache is missing or stale.
// ---------------------------------------------------------------------------

async function buildBanks() {
  await loadEmbedder();
  const banks = {};
  for (const def of BANK_DEFINITIONS) {
    const entries = [];
    for (const text of def.texts) {
      try {
        const vector = await embedText(text);
        entries.push({ text, vector });
      } catch (err) {
        recordRuntimeEvent(
          "warn",
          "example-banks",
          `embed failed · ${def.name} · "${text.slice(0, 32)}" · ${err?.message || err}`
        );
      }
    }
    banks[def.name] = entries;
  }
  return banks;
}

function countsSnapshot() {
  const counts = {};
  for (const def of BANK_DEFINITIONS) {
    const list = state.banks?.[def.name];
    counts[def.camelKey] = Array.isArray(list) ? list.length : 0;
  }
  return counts;
}

function buildBootSummary() {
  return {
    ready: Boolean(state.ready && state.banks),
    modelId: KB_EMBED_MODEL_ID,
    counts: countsSnapshot()
  };
}

// ---------------------------------------------------------------------------
// public api
// ---------------------------------------------------------------------------

async function preloadExampleBanks() {
  if (state.ready && state.banks) return buildBootSummary();
  if (state.loadPromise) return state.loadPromise;

  state.loadPromise = (async () => {
    const hash = computeBanksHash();
    let banks = loadFromDisk(hash);
    if (banks) {
      const restored = Object.values(banks).reduce((s, l) => s + l.length, 0);
      recordRuntimeEvent(
        "info",
        "example-banks",
        `restored from disk · ${restored} entries`
      );
    } else {
      try {
        banks = await buildBanks();
      } catch (err) {
        recordRuntimeEvent("warn", "example-banks", `build failed · ${err?.message || err}`);
        state.loadPromise = null;
        throw err;
      }
      const built = Object.values(banks).reduce((s, l) => s + l.length, 0);
      const expected = BANK_DEFINITIONS.reduce((s, def) => s + def.texts.length, 0);
      if (built < expected) {
        recordRuntimeEvent(
          "warn",
          "example-banks",
          `partial build · ${built}/${expected} entries embedded`
        );
      }
      persistToDisk(hash, banks);
      recordRuntimeEvent(
        "info",
        "example-banks",
        `built fresh · ${built} entries`
      );
    }

    state.banks = banks;
    state.hash = hash;
    state.ready = true;
    return buildBootSummary();
  })();

  try {
    return await state.loadPromise;
  } catch (err) {
    state.loadPromise = null;
    throw err;
  }
}

function getBank(name) {
  if (!state.ready || !state.banks) return null;
  if (!BANK_NAMES.has(name)) return null;
  const list = state.banks[name];
  return Array.isArray(list) && list.length ? list : null;
}

function isReady() {
  return Boolean(state.ready && state.banks);
}

function getModelId() {
  return KB_EMBED_MODEL_ID;
}

function __resetForTests() {
  state.banks = null;
  state.hash = null;
  state.ready = false;
  state.loadPromise = null;
}

module.exports = {
  preloadExampleBanks,
  getBank,
  isReady,
  getModelId,
  __resetForTests,
  // exported for tests / inspection only — not part of the production contract.
  __internals: {
    BANK_DEFINITIONS,
    BANK_NAMES,
    SCAM_SELL_BANK,
    SCAM_BUY_BANK,
    RESPECT_DISRESPECT_BANK,
    RESPECT_NEUTRAL_BANK,
    CACHE_PATH,
    computeBanksHash
  }
};
