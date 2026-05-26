const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { KB_EMBED_MODEL_ID } = require("./config");
const { embedText, loadEmbedder } = require("./embeddings");
const { recordRuntimeEvent } = require("./runtime-health");

const CACHE_PATH = path.resolve(__dirname, "..", "data", "example-banks-cache.json");

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
  "wts v2 cheap",
  "selling v3 dm me",
  "selling v2 dm me",
  "trading kiciahook",
  "kicia plug here",
  "vendor kicia keys",
  "for sale: kicia",
  "msg me for kicia",
  "selling kicia + ue",
  "kicia for robux dm",
  "trade kicia for ue",
  "kicia trade pm me",
  "who wants to buy my kicia",
  "im selling configs dm me",
  "selling configs dm",
  "wts configs cheap",
  "selling premium configs",
  "selling my configs",
  "im selling keys",
  "selling kicia keys cheap",
  "wts lifetime",
  "selling lifetime dm me",
  "selling premium dm",
  "selling subs dm",
  "selling subscription pm",
  "wts premium",
  "selling cracked kicia",
  "selling license dm me",
  "selling cracked kicia hmu",
  "trusted kicia seller dm me",
  "kicia vouches available",
  "have kicia gf only dm",
  "selling kicia going first",
  "kicia for paypal gf",
  "kicia for usdt dm",
  "kicia for steam gc",
  "kicia for nitro",
  "kicia for amazon gc",
  "kicia for cashapp dm",
  "kicia tos first then pay",
  "mm kicia trade",
  "mm for kicia",
  "selling kicia 10 usdt",
  "kicia for sol dm",
  "kicia 5 eth dm",
  "kicia rep list dm",
  "got kicia keys cheap dm",
  "slide in dms for kicia",
  "inbox me for kicia",
  "selling kicia lifetime sub",
  "selling cracked kicia configs",
  "got premium kicia configs dm",
  "have v3 lifetime hmu",
  "selling kicia method",
  "kicia method dm me",
  "anyone wanna swap kicia for ue",
  "wanna trade kicia for ue",
  "trade ue for kicia",
  "ill swap my kicia for ur ue",
  "trading my kicia hook for cash",
  "swapping kicia keys for ue keys",
  "anyone wanna trade kicia for v3",
  "ill trade my kicia for fluxus",
  "got kicia who wants",
  "have v3 if anyone wants",
  "got configs for 10",
  "i got v3 prem if u want",
  "who wants my kicia",
  "got kicia hmu in dms",
  "have my kicia for trade",
  "yo got kicia who wants",
  "got an extra v3 hmu",
  "own a spare kicia lifetime",
  "selling confgs cheap",
  "sellin kicia dm",
  "wts kica hmu",
  "trading kciia for ue",
  "trade my v3 for ur paypal",
  "trade ur ue and ill add cash",
  "trading my kicia for robux + ue",
  "ill trade kicia for ur acc",
  "who has ue and wants kicia"
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
  "is v2 paid",
  "is v3 free",
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
  "is kicia good",
  "where can i get configs",
  "where do i get configs",
  "where can i find configs",
  "how to get configs",
  "any free configs",
  "where to download configs",
  "do i need a key for kicia",
  "how much is the premium",
  "is lifetime worth it",
  "how do i buy kicia",
  "where do i get configs",
  "who has kicia keys",
  "where to download configs",
  "where to get kicia method",
  "is kicia method free",
  "official kicia download link",
  "do i need to pay for kicia",
  "kicia trial free",
  "free kicia configs link",
  "anyone got a free kicia",
  "anyone got configs to share",
  "where do i download free configs",
  "how do i get the cracked kicia",
  "is there a working kicia free version"
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
  "v2 is trash",
  "v2 is ass",
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
  "v2 is solid",
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

const BANK_DEFINITIONS = [
  { name: "scam-sell",          camelKey: "scamSell",          texts: SCAM_SELL_BANK },
  { name: "scam-buy",           camelKey: "scamBuy",           texts: SCAM_BUY_BANK },
  { name: "respect-disrespect", camelKey: "respectDisrespect", texts: RESPECT_DISRESPECT_BANK },
  { name: "respect-neutral",    camelKey: "respectNeutral",    texts: RESPECT_NEUTRAL_BANK }
];

const BANK_NAMES = new Set(BANK_DEFINITIONS.map((b) => b.name));

const state = {
  banks: null,
  hash: null,
  ready: false,
  loadPromise: null
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function computeBanksHash() {
  const allTexts = BANK_DEFINITIONS.map((b) => b.texts);
  return sha256(KB_EMBED_MODEL_ID + "|" + JSON.stringify(allTexts));
}

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
    recordRuntimeEvent("warn", "example-banks", `cache-write failed - ${err?.message || err}`);
  }
}

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
          `embed failed - ${def.name} - "${text.slice(0, 32)}" - ${err?.message || err}`
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
        `restored from disk - ${restored} entries`
      );
    } else {
      try {
        banks = await buildBanks();
      } catch (err) {
        recordRuntimeEvent("warn", "example-banks", `build failed - ${err?.message || err}`);
        state.loadPromise = null;
        throw err;
      }
      const built = Object.values(banks).reduce((s, l) => s + l.length, 0);
      const expected = BANK_DEFINITIONS.reduce((s, def) => s + def.texts.length, 0);
      if (built < expected) {
        recordRuntimeEvent(
          "warn",
          "example-banks",
          `partial build - ${built}/${expected} entries embedded`
        );
      }
      persistToDisk(hash, banks);
      recordRuntimeEvent(
        "info",
        "example-banks",
        `built fresh - ${built} entries`
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
