const crypto = require("crypto");
const path = require("path");

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "seed";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const dbModule = require(path.resolve(__dirname, "..", "src", "restricted-emoji-db"));
const { embedText, loadEmbedder } = require(path.resolve(__dirname, "..", "src", "embeddings"));

const SYNTHETIC = [
  // scam · positive
  {classifier:"scam",label:"positive",text:"yo selling kicia v3 hmu in dms"},
  {classifier:"scam",label:"positive",text:"wts kicia $8 paypal only"},
  {classifier:"scam",label:"positive",text:"trading kicia for ur ue lifetime"},
  {classifier:"scam",label:"positive",text:"got kicia going first if u want"},
  {classifier:"scam",label:"positive",text:"selling my v3 sub cheap"},
  {classifier:"scam",label:"positive",text:"kicia 15 cashapp pm me"},
  {classifier:"scam",label:"positive",text:"v3 lifetime for 20 usdt dm"},
  {classifier:"scam",label:"positive",text:"anyone want kicia for nitro classic"},
  {classifier:"scam",label:"positive",text:"kiciaa hook for sale roblox gc pm"},
  {classifier:"scam",label:"positive",text:"v2 keys 3 sol dm fast"},
  {classifier:"scam",label:"positive",text:"slide in dms if u tryna cop kicia"},
  {classifier:"scam",label:"positive",text:"inbox open for kicia buyers"},
  {classifier:"scam",label:"positive",text:"hmu fr i got that v3 in stock"},
  {classifier:"scam",label:"positive",text:"pm me bro got kicia at low"},
  {classifier:"scam",label:"positive",text:"msg me for the kicia plug"},
  {classifier:"scam",label:"positive",text:"got vouches selling kicia gf only"},
  {classifier:"scam",label:"positive",text:"trusted seller of v3 dm for rep list"},
  {classifier:"scam",label:"positive",text:"tos first then ill drop the kicia key"},
  {classifier:"scam",label:"positive",text:"gf rep available kicia trades"},
  {classifier:"scam",label:"positive",text:"need mm im selling kicia lifetime"},
  {classifier:"scam",label:"positive",text:"seeeelling k1cia configs cheaaap"},
  {classifier:"scam",label:"positive",text:"wts k.i.c.i.a v3 hmu"},
  {classifier:"scam",label:"positive",text:"selling kiciaaaa key low price"},
  {classifier:"scam",label:"positive",text:"got k1c1a hook lifetime open dms"},
  {classifier:"scam",label:"positive",text:"selling kicia (cr@cked) dm"},
  {classifier:"scam",label:"positive",text:"kicia $5 no cap"},
  {classifier:"scam",label:"positive",text:"20 usd for v3 lifetime fr"},
  {classifier:"scam",label:"positive",text:"cheap kicia keys 2 each pm"},
  {classifier:"scam",label:"positive",text:"lowest price on v3 just dm me bro"},
  {classifier:"scam",label:"positive",text:"v2 sub 3 bucks pm"},
  {classifier:"scam",label:"positive",text:"got extra configs selling em cheap"},
  {classifier:"scam",label:"positive",text:"wts spare lifetime hmu"},
  {classifier:"scam",label:"positive",text:"selling premium subs cheap"},
  {classifier:"scam",label:"positive",text:"anyone want a key i got like 4 left"},
  {classifier:"scam",label:"positive",text:"got premium configs going cheap dms"},
  {classifier:"scam",label:"positive",text:"whoever wants kicia hit me up fr"},
  {classifier:"scam",label:"positive",text:"ill sell my kicia account cheap"},
  {classifier:"scam",label:"positive",text:"got 2 extra v3 keys not using em"},
  {classifier:"scam",label:"positive",text:"lmk if u tryna buy kicia off me"},
  {classifier:"scam",label:"positive",text:"ngl ive been selling kicia configs for a while hmu in dms"},

  // scam · negative
  {classifier:"scam",label:"negative",text:"where do i actually buy kicia tho"},
  {classifier:"scam",label:"negative",text:"how much does v3 cost rn"},
  {classifier:"scam",label:"negative",text:"is kicia free or do i pay"},
  {classifier:"scam",label:"negative",text:"how do i pay for kicia w robux"},
  {classifier:"scam",label:"negative",text:"wheres the legit site to get kicia"},
  {classifier:"scam",label:"negative",text:"my v3 config keeps crashing wtf"},
  {classifier:"scam",label:"negative",text:"kicia not loading after the patch"},
  {classifier:"scam",label:"negative",text:"v3 setup is broken anyone got a fix"},
  {classifier:"scam",label:"negative",text:"kicia keeps booting me out help"},
  {classifier:"scam",label:"negative",text:"premium expired how do i renew"},
  {classifier:"scam",label:"negative",text:"is kicia worth it over hydrogen"},
  {classifier:"scam",label:"negative",text:"v3 vs v2 which one is better tbh"},
  {classifier:"scam",label:"negative",text:"kicia vs fluxus performance wise"},
  {classifier:"scam",label:"negative",text:"anyone compared kicia to ue lately"},
  {classifier:"scam",label:"negative",text:"should i grab kicia or wait for v4"},
  {classifier:"scam",label:"negative",text:"some dude tried to sell me kicia in dms lol"},
  {classifier:"scam",label:"negative",text:"is selling kicia even allowed here"},
  {classifier:"scam",label:"negative",text:"how do i report ppl selling configs"},
  {classifier:"scam",label:"negative",text:"got dmed by a scammer selling v3 keys"},
  {classifier:"scam",label:"negative",text:"mod can u ban this guy hes selling kicia"},
  {classifier:"scam",label:"negative",text:"kicia is goated ngl"},
  {classifier:"scam",label:"negative",text:"v3 carries my whole loadout fr"},
  {classifier:"scam",label:"negative",text:"loving the new kicia update so smooth"},
  {classifier:"scam",label:"negative",text:"kiciahook stays winning"},
  {classifier:"scam",label:"negative",text:"v3 is peak tbh nothing comes close"},
  {classifier:"scam",label:"negative",text:"wish kicia had a dark mode toggle"},
  {classifier:"scam",label:"negative",text:"kicia should add an aim assist slider"},
  {classifier:"scam",label:"negative",text:"if only v3 let me bind to scroll wheel"},
  {classifier:"scam",label:"negative",text:"feature request can configs auto save"},
  {classifier:"scam",label:"negative",text:"kicia needs a mac build pls"},
  {classifier:"scam",label:"negative",text:"lmao selling kicia jk dont ban me"},
  {classifier:"scam",label:"negative",text:"wts my kicia configs /s"},
  {classifier:"scam",label:"negative",text:"selling my kicia (joking obviously)"},
  {classifier:"scam",label:"negative",text:"hmu for free kicia keys (im kidding)"},
  {classifier:"scam",label:"negative",text:"trading my soul for v3 lmao"},
  {classifier:"scam",label:"negative",text:"anyone got a good ow2 config for v3"},
  {classifier:"scam",label:"negative",text:"kicia performance is kinda mid on linux"},
  {classifier:"scam",label:"negative",text:"v3 fps drops on amd anyone else"},
  {classifier:"scam",label:"negative",text:"best kicia settings for low end pc"},
  {classifier:"scam",label:"negative",text:"does kicia work w bloxstrap"},

  // respect · positive
  {classifier:"respect",label:"positive",text:"v3 is buns ngl"},
  {classifier:"respect",label:"positive",text:"kicia mid fr"},
  {classifier:"respect",label:"positive",text:"kiciahook ass tbh"},
  {classifier:"respect",label:"positive",text:"v3 dogshit lately"},
  {classifier:"respect",label:"positive",text:"hook is straight garbage"},
  {classifier:"respect",label:"positive",text:"kicia overrated as hell"},
  {classifier:"respect",label:"positive",text:"v2 was trash and v3 somehow worse"},
  {classifier:"respect",label:"positive",text:"kicia is sooo bad rn i cant"},
  {classifier:"respect",label:"positive",text:"v3 is literally aids honestly"},
  {classifier:"respect",label:"positive",text:"kicia honestly mid asf"},
  {classifier:"respect",label:"positive",text:"v3 fr fr trash i regret buying"},
  {classifier:"respect",label:"positive",text:"kicia deadass dogshit at this point"},
  {classifier:"respect",label:"positive",text:"v3333 is actually so ass"},
  {classifier:"respect",label:"positive",text:"kicia is cooked man no recovering from this"},
  {classifier:"respect",label:"positive",text:"v3 is dead bro nobody uses it anymore"},
  {classifier:"respect",label:"positive",text:"kicia is a scam lowkey"},
  {classifier:"respect",label:"positive",text:"kiciahook is dying lol"},
  {classifier:"respect",label:"positive",text:"v3 got aids since last patch"},
  {classifier:"respect",label:"positive",text:"kicia ratio + buns + fell off"},
  {classifier:"respect",label:"positive",text:"v3 has been awful lately like genuinely unusable"},
  {classifier:"respect",label:"positive",text:"kicia keeps letting me down every single update"},
  {classifier:"respect",label:"positive",text:"nothing actually works on v3 anymore wtf"},
  {classifier:"respect",label:"positive",text:"kicia is the worst exploit ive ever paid for"},
  {classifier:"respect",label:"positive",text:"v3 quality has fallen off a cliff ngl"},
  {classifier:"respect",label:"positive",text:"kicia is mid AND broken what a combo"},
  {classifier:"respect",label:"positive",text:"v3 sucks and v3 keeps crashing every 5 min"},
  {classifier:"respect",label:"positive",text:"the whole v3 update was trash i want v2 back"},
  {classifier:"respect",label:"positive",text:"kicia is buns kiciahook is buns the whole thing buns"},
  {classifier:"respect",label:"positive",text:"v3 ui ugly v3 detection bad v3 just bad period"},
  {classifier:"respect",label:"positive",text:"kicia is so amazing it crashes every single time i open it"},
  {classifier:"respect",label:"positive",text:"v3 is so good it deletes my configs randomly thanks dev"},
  {classifier:"respect",label:"positive",text:"kiciaaaaa really out here charging money for a broken product"},
  {classifier:"respect",label:"positive",text:"v3 issssss soooo bad i swear"},
  {classifier:"respect",label:"positive",text:"kicia ass kiciahook ass v3 ass everything ass"},
  {classifier:"respect",label:"positive",text:"ngl ever since the v3 update the fps handling has been completely cooked"},
  {classifier:"respect",label:"positive",text:"kicia used to slap now its just garbage"},
  {classifier:"respect",label:"positive",text:"v3 is the biggest L exploit of the year fr"},
  {classifier:"respect",label:"positive",text:"hook sucks dont waste your money on it"},
  {classifier:"respect",label:"positive",text:"kicia is overpriced trash compared to literally anything else"},
  {classifier:"respect",label:"positive",text:"v3 keeps eating my robux and giving nothing back garbage product"},

  // respect · negative
  {classifier:"respect",label:"negative",text:"kicia is good ue is dogshit"},
  {classifier:"respect",label:"negative",text:"v3 carries hydrogen ass"},
  {classifier:"respect",label:"negative",text:"kicia better than fluxus fluxus is trash"},
  {classifier:"respect",label:"negative",text:"v3 is goated but synapse is buns"},
  {classifier:"respect",label:"negative",text:"kiciahook works wave is dead"},
  {classifier:"respect",label:"negative",text:"kicia is peak swift sucks"},
  {classifier:"respect",label:"negative",text:"kicia is goated"},
  {classifier:"respect",label:"negative",text:"v3 is peak fr"},
  {classifier:"respect",label:"negative",text:"kiciahook so clean lately"},
  {classifier:"respect",label:"negative",text:"v3 carries my rank ngl"},
  {classifier:"respect",label:"negative",text:"kicia honestly the best out there"},
  {classifier:"respect",label:"negative",text:"kicia fire after that last update"},
  {classifier:"respect",label:"negative",text:"v3 has a memory leak on long sessions"},
  {classifier:"respect",label:"negative",text:"kicia keeps crashing on roblox update"},
  {classifier:"respect",label:"negative",text:"v3 fps drops after the patch yesterday anyone else"},
  {classifier:"respect",label:"negative",text:"kicia not loading my configs since the reinstall"},
  {classifier:"respect",label:"negative",text:"the v3 ui is bugged on mobile resolutions"},
  {classifier:"respect",label:"negative",text:"v3 broke after roblox update earlier"},
  {classifier:"respect",label:"negative",text:"is v3 down rn"},
  {classifier:"respect",label:"negative",text:"is kicia broken rn or just me"},
  {classifier:"respect",label:"negative",text:"why is kicia not working after the update"},
  {classifier:"respect",label:"negative",text:"is v3 still ass after the update or did they fix it"},
  {classifier:"respect",label:"negative",text:"does kicia work on the new windows 11 build"},
  {classifier:"respect",label:"negative",text:"is v3 worth getting fr or should i wait"},
  {classifier:"respect",label:"negative",text:"wish kicia had a script hub built in"},
  {classifier:"respect",label:"negative",text:"i hope v3 adds a bypass for the new anticheat"},
  {classifier:"respect",label:"negative",text:"kicia would be peak if it had hwid spoofing"},
  {classifier:"respect",label:"negative",text:"feature request: better v3 ui with dark mode toggle"},
  {classifier:"respect",label:"negative",text:"id love a kicia mobile version one day"},
  {classifier:"respect",label:"negative",text:"if v3 had auto execute on join it would be perfect"},
  {classifier:"respect",label:"negative",text:"kicia just updated check it out"},
  {classifier:"respect",label:"negative",text:"using kicia rn its loaded up"},
  {classifier:"respect",label:"negative",text:"v3 came out last week i think"},
  {classifier:"respect",label:"negative",text:"kicia v3 has been around for a bit now"},
  {classifier:"respect",label:"negative",text:"loaded kicia for the first time today gonna try it"},
  {classifier:"respect",label:"negative",text:"kicia isnt bad at all actually surprised me"},
  {classifier:"respect",label:"negative",text:"v3 aint trash bro idk what yall talking about"},
  {classifier:"respect",label:"negative",text:"kicia is not mid at all its actually solid"},
  {classifier:"respect",label:"negative",text:"v3 doesnt suck stop spreading that"},
  {classifier:"respect",label:"negative",text:"kicia is anything but garbage tbh"}
];

const UPDATES = [
  {id:30,label:"positive",note:"auto-label v1: rhetorical 'why does v3 suck' clear disrespect"},
  {id:49,label:"positive",note:"auto-label v1: 'kinda bad' attributed to v3 free version"},
  {id:52,label:"positive",note:"auto-label v1: 'kicia so bad' direct"},
  {id:53,label:"positive",note:"auto-label v1: 'trash' attributed to v3"},
  {id:54,label:"positive",note:"auto-label v1: quoted variant of #53"},
  {id:102,label:"positive",note:"auto-label v1: 'V3 sucks' direct neg-lex"},
  {id:103,label:"positive",note:"auto-label v1: quoted variant of #102"},
  {id:104,label:"positive",note:"auto-label v1: 'v3 mid' direct"},
  {id:105,label:"positive",note:"auto-label v1: 'V3 mid' direct"},
  {id:31,label:"negative",note:"auto-label v1: nostalgia about kicia past not disrespect"},
  {id:33,label:"negative",note:"auto-label v1: caps variant of #31"},
  {id:34,label:"negative",note:"auto-label v1: buyer asking for config not selling"},
  {id:36,label:"negative",note:"auto-label v1: buyer requesting v3 in dm"},
  {id:45,label:"negative",note:"auto-label v1: asking for help to buy not selling"},
  {id:99,label:"negative",note:"auto-label v1: buyer requesting a config not offering"}
];

function sha1(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

function changesCount(db) {
  const r = db.exec("SELECT changes()");
  return r[0] && r[0].values[0] ? r[0].values[0][0] : 0;
}

async function main() {
  console.log("loading embedder...");
  await loadEmbedder();
  console.log("embedder ready");

  const db = await dbModule.getDatabase();
  const now = Date.now();
  const modelId = "Xenova/all-MiniLM-L6-v2";

  let inserted = 0;
  let dedupSkipped = 0;
  let updateCount = 0;
  let updateMiss = 0;

  for (const s of SYNTHETIC) {
    const normalized = String(s.text || "").toLowerCase().trim().slice(0, 4000);
    if (!normalized) continue;
    const dedupKey = sha1(normalized).slice(0, 24) + "|synth-seed|" + s.classifier;

    const exists = db.exec("SELECT id FROM training_samples WHERE dedup_key = ?", [dedupKey]);
    if (exists[0] && exists[0].values.length) {
      dedupSkipped++;
      continue;
    }

    let vec;
    try {
      vec = await embedText(normalized.slice(0, 512));
    } catch (err) {
      console.warn("embed failed:", err.message, normalized.slice(0, 40));
      continue;
    }

    const signalsJson = JSON.stringify({ synthetic: true, source: "seed v1", confidence: 0.95 });
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
        s.classifier, now, s.text, normalized, signalsJson,
        "review", s.label,
        "synthetic-seed", "synthetic seed v1", now, "synthetic seed v1",
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
    if (inserted % 20 === 0) console.log(`inserted ${inserted}...`);
  }

  console.log(`synthetic inserts complete: ${inserted} inserted, ${dedupSkipped} dedup-skipped`);

  for (const u of UPDATES) {
    db.run(
      `UPDATE training_samples
         SET label = ?, labeler_id = ?, labeler_label = ?, labeled_at = ?, staff_note = ?
       WHERE id = ? AND label IS NULL`,
      [u.label, "auto-label-v1", "auto-label v1", now, u.note, u.id]
    );
    const c = changesCount(db);
    if (c > 0) updateCount++;
    else updateMiss++;
  }

  console.log(`real-row updates complete: ${updateCount} applied, ${updateMiss} skipped (already labeled or missing)`);

  // schedulePersist sets the dirty flag and immediate:true forces a sync write.
  // Calling flushRestrictedEmojiDatabaseNow() alone is a no-op when raw db.run()
  // was used (no helper set the dirty flag).
  dbModule.schedulePersist(db, { immediate: true });

  await new Promise((r) => setTimeout(r, 500));

  const totalRow = db.exec("SELECT COUNT(*) FROM training_samples");
  const total = totalRow[0].values[0][0];
  console.log(`training_samples now has ${total} rows`);

  const byClass = db.exec("SELECT classifier, label, COUNT(*) FROM training_samples GROUP BY classifier, label ORDER BY classifier, label");
  console.log("breakdown:");
  if (byClass[0]) for (const r of byClass[0].values) console.log(" ", r.join(" "));

  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
