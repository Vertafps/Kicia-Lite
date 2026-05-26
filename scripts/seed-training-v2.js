const crypto = require("crypto");
const path = require("path");

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "seed";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const dbModule = require(path.resolve(__dirname, "..", "src", "restricted-emoji-db"));
const { embedText, loadEmbedder } = require(path.resolve(__dirname, "..", "src", "embeddings"));
const inlineProbe = require(path.resolve(__dirname, "..", "src", "inline-probe"));

const SCAM_SEEDS = [
  {label:"positive",text:"trade kicia for ur fluxus"},
  {label:"positive",text:"swap my v3 for ur ue lifetime"},
  {label:"positive",text:"ill give v3 for synapse"},
  {label:"positive",text:"kicia for hydrogen anyone"},
  {label:"positive",text:"my kicia + 5$ for ur ue"},
  {label:"positive",text:"wanna swap accs i have v3"},
  {label:"positive",text:"ur kicia my synapse straight up"},
  {label:"positive",text:"kicia lifetime for delta lifetime"},
  {label:"positive",text:"i got v2 lifetime trading for v3"},
  {label:"positive",text:"kicia hook for fluxus prem"},
  {label:"positive",text:"trade v3 + cash for ur ue"},
  {label:"positive",text:"swap my kicia keys for ur exec"},
  {label:"positive",text:"ill trade up to ur prem exec"},
  {label:"positive",text:"kicia + paypal for ur synapse"},
  {label:"positive",text:"anyone wanna swap subs kicia for ue"},
  {label:"positive",text:"if u need kicia talk to me"},
  {label:"positive",text:"pms open for the usual"},
  {label:"positive",text:"inbox open if u need anything"},
  {label:"positive",text:"back in business kicia stock"},
  {label:"positive",text:"restocked v3 hmu"},
  {label:"positive",text:"u kno where to find me kicia plug"},
  {label:"positive",text:"back open kicia trades welcome"},
  {label:"positive",text:"taking kicia offers atm"},
  {label:"positive",text:"entertaining v3 offers"},
  {label:"positive",text:"feel free to pm about kicia"},
  {label:"positive",text:"accepting kicia inquiries"},
  {label:"positive",text:"serious buyers only for kicia"},
  {label:"positive",text:"kicia lifetime 25 paypal"},
  {label:"positive",text:"v3 prem 15 dm"},
  {label:"positive",text:"kicia 30 usd"},
  {label:"positive",text:"kicia keys 10 ea"},
  {label:"positive",text:"v3 lifetime cheap dm"},
  {label:"positive",text:"kicia goin 20"},
  {label:"positive",text:"kicia 5$ each"},
  {label:"positive",text:"v3 lifetime 30usd dm"},
  {label:"positive",text:"kicia + 5 for ue"},
  {label:"positive",text:"kicia for 10 paypal only"},
  {label:"positive",text:"v3 30 cashapp only"},
  {label:"positive",text:"kicia bulk discount"},
  {label:"positive",text:"selling kicia vendiendo kicia barato"},
  {label:"positive",text:"vendo kicia hmu"},
  {label:"positive",text:"vendendo kicia v3 dm"},
  {label:"positive",text:"продаю kicia"},
  {label:"positive",text:"kicia 4 sale lmk"},
  {label:"positive",text:"4 sale kicia lifetime"},
  {label:"positive",text:"kic1a 4 paypal"},
  {label:"positive",text:"k1c1a v3 hmu"},
  {label:"positive",text:"selling k!c!a configs"},
  {label:"positive",text:"selling Kicia v3 yes capital K"},
  {label:"positive",text:"продам kicia v3 дешево"},
  {label:"positive",text:"anyone need kicia?"},
  {label:"positive",text:"someone want to buy v3?"},
  {label:"positive",text:"any kicia buyers?"},
  {label:"positive",text:"who needs configs?"},
  {label:"positive",text:"looking for kicia buyers"},
  {label:"positive",text:"interested in kicia? dm"},
  {label:"positive",text:"trade ur acc for kicia"},
  {label:"positive",text:"give acc for v3"},
  {label:"positive",text:"swap acc for kicia lifetime"},
  {label:"positive",text:"ur acc + my kicia trade?"},
  {label:"positive",text:"acc swap with v3 included"}
];

const RESPECT_SEEDS = [
  {label:"positive",text:"v3 worse than v2 fr"},
  {label:"positive",text:"ue mogs kicia hard"},
  {label:"positive",text:"every other exec better than kicia"},
  {label:"positive",text:"kicia is the bottom tier of execs"},
  {label:"positive",text:"kicia is at the bottom of the food chain"},
  {label:"positive",text:"v3 the worst on the market"},
  {label:"positive",text:"kicia is what i use when nothing else works"},
  {label:"positive",text:"v3 is for ppl who cant afford real execs"},
  {label:"positive",text:"kicia is for poor people honestly"},
  {label:"positive",text:"kicia is the discount version"},
  {label:"positive",text:"v3 is bottom barrel"},
  {label:"positive",text:"kicia behind every other exec"},
  {label:"positive",text:"kicia hasnt worked since launch"},
  {label:"positive",text:"v3 has been broken since release"},
  {label:"positive",text:"kicia disappoints me every time"},
  {label:"positive",text:"v3 makes me regret paying"},
  {label:"positive",text:"kicia keeps falling apart"},
  {label:"positive",text:"v3 cant even do the basics"},
  {label:"positive",text:"kicia never works when i need it"},
  {label:"positive",text:"v3 is a complete waste of money"},
  {label:"positive",text:"kicia is the biggest disappointment"},
  {label:"positive",text:"v3 is just embarrassing at this point"},
  {label:"positive",text:"v3 is hot trash and the devs dont care"},
  {label:"positive",text:"kicia is so bad my dog could code better"},
  {label:"positive",text:"kicia is the worst purchase ive ever made fr"},
  {label:"positive",text:"v3 garbage tier exec"},
  {label:"positive",text:"kicia v3 is the embodiment of disappointment"},
  {label:"positive",text:"kicia is dead bro just delete it"},
  {label:"positive",text:"v3 is straight up cancer at this point"},
  {label:"positive",text:"kicia is unusable garbage rn"},
  {label:"positive",text:"v3 is f-tier exec genuinely"},
  {label:"positive",text:"kicia is the laughing stock of the exec community"},
  {label:"positive",text:"v3 is glazed"},
  {label:"positive",text:"kicia is yapping"},
  {label:"positive",text:"v3 is fanum tax"},
  {label:"positive",text:"kicia is rizzless"},
  {label:"positive",text:"v3 is npc"},
  {label:"positive",text:"kicia is mid-tier corporate slop"},
  {label:"positive",text:"v3 is brainrot tier"},
  {label:"positive",text:"kicia is yawn-worthy"},
  {label:"negative",text:"v3 has a frame drop issue on amd"},
  {label:"negative",text:"kicia config didnt load for me today"},
  {label:"negative",text:"v3 ui got broken after the patch"},
  {label:"negative",text:"kicia performance is slightly worse on linux"},
  {label:"negative",text:"v3 ran into an error on my pc"},
  {label:"negative",text:"kicia stopped detecting my client"},
  {label:"negative",text:"v3 needs a hotfix for the new roblox update"},
  {label:"negative",text:"kicia had a bug i reported it already"},
  {label:"negative",text:"kicia carries every other exec is dead"},
  {label:"negative",text:"v3 the only working exec rn"},
  {label:"negative",text:"everyone else is trash kicia delivers"},
  {label:"negative",text:"kicia goated everything else mid"},
  {label:"negative",text:"v3 actually works unlike the others"},
  {label:"negative",text:"kicia is the only exec keeping the scene alive"},
  {label:"negative",text:"kicia could improve its ui responsiveness"},
  {label:"negative",text:"v3 would be perfect with a darkmode"},
  {label:"negative",text:"i wish kicia had auto-execute"},
  {label:"negative",text:"kicia needs a better tutorial"},
  {label:"negative",text:"if v3 added bypass it would be peak"},
  {label:"negative",text:"kicia should have a mobile companion"}
];

function sha1(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

async function insertSeeds(db, list, classifier) {
  let inserted = 0;
  let deduped = 0;
  const now = Date.now();
  const modelId = "Xenova/all-MiniLM-L6-v2";

  for (const seed of list) {
    const normalized = String(seed.text || "").toLowerCase().trim().slice(0, 4000);
    if (!normalized) continue;
    const dedupKey = sha1(normalized).slice(0, 24) + "|synth-v2|" + classifier;

    const exists = db.exec("SELECT id FROM training_samples WHERE dedup_key = ?", [dedupKey]);
    if (exists[0] && exists[0].values.length) {
      deduped++;
      continue;
    }

    let vec;
    try {
      vec = await embedText(normalized.slice(0, 512));
    } catch (err) {
      console.warn("embed failed:", err.message, normalized.slice(0, 40));
      continue;
    }

    const signalsJson = JSON.stringify({ synthetic: true, source: "seed v2", confidence: 0.95 });
    db.run(
      `INSERT INTO training_samples (
        classifier, created_at, guild_id, channel_id, message_id, message_url,
        author_id, author_label, raw_text, normalized_text, signals_json,
        decision, action_action_id, label, severity,
        labeler_id, labeler_label, labeled_at, staff_note,
        feedback_message_id, feedback_channel_id, dedup_key, posted, anonymized
      ) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?,
                ?, NULL, ?, NULL,
                ?, ?, ?, ?,
                NULL, NULL, ?, ?, ?)`,
      [
        classifier, now, seed.text, normalized, signalsJson,
        "review", seed.label,
        "synthetic-seed", "synthetic seed v2", now, "synthetic seed v2",
        dedupKey, 1, 0
      ]
    );

    const idRow = db.exec("SELECT last_insert_rowid()");
    const sampleId = idRow[0].values[0][0];

    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    db.run(
      "INSERT OR REPLACE INTO training_embeddings (sample_id, model_id, dims, vector) VALUES (?, ?, ?, ?)",
      [sampleId, modelId, vec.length, buf]
    );
    inserted++;
    if (inserted % 20 === 0) console.log(`  inserted ${inserted} ${classifier} seeds...`);
  }

  return { inserted, deduped };
}

async function retrainClassifier(db, classifier) {
  console.log(`\nretraining ${classifier} head...`);

  const rows = db.exec(`
    SELECT s.id, s.label, e.vector
    FROM training_samples s
    LEFT JOIN training_embeddings e ON e.sample_id = s.id
    WHERE s.classifier = ? AND s.label IN ('positive', 'negative')
  `, [classifier])[0];
  if (!rows || rows.values.length === 0) {
    console.log(`  no labeled samples for ${classifier}, skipping retrain`);
    return null;
  }

  const samples = [];
  let withoutVec = 0;
  for (const r of rows.values) {
    const [id, label, vecBlob] = r;
    if (!vecBlob || !vecBlob.length) { withoutVec++; continue; }
    const vector = new Float32Array(vecBlob.buffer, vecBlob.byteOffset, vecBlob.byteLength / 4);
    samples.push({ vector, label: label === "positive" ? 1 : 0 });
  }
  console.log(`  ${samples.length} samples with vectors (${withoutVec} without)`);

  if (samples.length < 20) {
    console.log(`  not enough samples (need 20+), skipping`);
    return null;
  }

  const result = inlineProbe.trainAndCrossValidate(samples, {
    epochs: 200, lr: 0.01, l2: 0.001, batchSize: 32, seed: 42
  });

  const headKey = `classifier.${classifier}.head_v1`;
  const headPayload = JSON.stringify({
    W: result.head.W,
    b: result.head.b,
    version: 1,
    trainedAt: Date.now(),
    n: samples.length,
    threshold: result.threshold
  });
  db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)", [headKey, headPayload]);

  const metrics = result.metrics || {};
  const p = (metrics.precision * 100).toFixed(1);
  const r = (metrics.recall * 100).toFixed(1);
  const f = (metrics.f1 * 100).toFixed(1);
  const t = result.threshold.toFixed(2);
  console.log(`  trained: P=${p}% R=${r}% F1=${f}% threshold=${t}`);
  return { samples: samples.length, precision: p, recall: r, f1: f, threshold: t };
}

async function main() {
  console.log("loading embedder...");
  await loadEmbedder();
  console.log("embedder ready");

  const db = await dbModule.getDatabase();

  console.log("\n=== inserting scam v2 seeds ===");
  const scam = await insertSeeds(db, SCAM_SEEDS, "scam");
  console.log(`scam: ${scam.inserted} inserted, ${scam.deduped} deduped`);

  console.log("\n=== inserting respect v2 seeds ===");
  const respect = await insertSeeds(db, RESPECT_SEEDS, "respect");
  console.log(`respect: ${respect.inserted} inserted, ${respect.deduped} deduped`);

  const scamMetrics = await retrainClassifier(db, "scam");
  const respectMetrics = await retrainClassifier(db, "respect");

  dbModule.schedulePersist(db, { immediate: true });
  await new Promise((r) => setTimeout(r, 500));

  console.log("\n=== final state ===");
  const total = db.exec("SELECT COUNT(*) FROM training_samples")[0].values[0][0];
  console.log(`training_samples total: ${total}`);
  const labels = db.exec("SELECT classifier, label, COUNT(*) FROM training_samples WHERE label IS NOT NULL GROUP BY classifier, label ORDER BY classifier, label")[0];
  if (labels) for (const r of labels.values) console.log(` ${r[0].padEnd(8)} ${r[1].padEnd(10)} ${r[2]}`);

  if (scamMetrics) console.log(`scam head:    P=${scamMetrics.precision}% R=${scamMetrics.recall}% F1=${scamMetrics.f1}% threshold=${scamMetrics.threshold} on n=${scamMetrics.samples}`);
  if (respectMetrics) console.log(`respect head: P=${respectMetrics.precision}% R=${respectMetrics.recall}% F1=${respectMetrics.f1}% threshold=${respectMetrics.threshold} on n=${respectMetrics.samples}`);

  process.exit(0);
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
