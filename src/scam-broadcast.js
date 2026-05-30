"use strict";

// Discord giveaway / phishing "broadcast" scam detector.
//
// These are the classic mass-bait scams: "free nitro", "@everyone steam gift",
// "MrBeast giveaway claim here", crypto airdrops, typosquatted discord/steam
// login pages, etc. They're almost always posted as an image + a baiting
// caption and/or a phishing link. We can't read text baked INTO an image
// without OCR (which this box can't run), but the accompanying caption, the
// attachment filename, and any link are reliable, high-precision signals.
//
// This is deliberately HIGH-PRECISION (few false positives) because callers
// use a STRONG hit to skip moderation grace and time the user out immediately.
// A real clip discussion never trips the strong tier.

// Typosquatted / known-bad scam domains. Discord's only legit gift domain is
// discord.gift — anything else claiming nitro is fake. Covers the classic
// "i"->"l"/"1", "o"->"0" swaps and the grabber services.
const SCAM_DOMAIN_RE = new RegExp(
  [
    "d[il1]sc[o0]rd(?:app)?[a-z0-9-]*\\.(?:ru|xyz|click|info|online|gift|gg|pro|fun|site|shop|store|live|vip|app)",
    "disc[o0]rd[-_.]?nitro",
    "nitro[-_.]?(?:free|gift|claim|discord)",
    "free[-_.]?(?:nitro|discord)",
    "steam[-_.]?(?:community|gift)[a-z0-9-]*\\.(?:ru|xyz|click|info|online|gift|gg|pro|fun|site|tk)",
    "st[e3]amcommunity[a-z0-9-]*\\.(?!com\\b)[a-z]{2,}",
    "grabify|iplogger|blasze|02ip|yip\\.su|cuty\\.io|bmwfetish",
    "claim[-_.]?(?:nitro|gift|reward|prize)",
    "(?:nitro|gift|reward)[-_.]?claim"
  ].join("|"),
  "i"
);

// Nitro/Steam/crypto bait phrases. Each of these is on its own a STRONG signal
// in a community context — Discord does not hand out free nitro via chat.
const STRONG_BAIT_RE = new RegExp(
  [
    "free\\s+(?:discord\\s+)?nitro",
    "nitro\\s+(?:for\\s+free|giveaway|gift|drop)",
    "(?:claim|gift|get)\\s+(?:your\\s+)?(?:free\\s+)?nitro",
    "free\\s+steam\\s+(?:gift|key|wallet|code|card)",
    "steam\\s+gift\\s+card",
    "\\$?\\d{1,4}\\s*(?:usd|\\$)?\\s*steam\\s+(?:gift|card|code)",
    "mr\\s*beast.{0,20}(?:giveaway|free|gift|claim)",
    "(?:giveaway|free|gift|claim).{0,20}mr\\s*beast",
    "free\\s+(?:robux|v[-\\s]?bucks|vbucks)",
    "(?:crypto|btc|eth|sol|usdt)\\s+airdrop",
    "connect\\s+(?:your\\s+)?wallet",
    "claim\\s+(?:your\\s+)?(?:free\\s+)?(?:airdrop|reward|prize|gift\\s*card)"
  ].join("|"),
  "i"
);

// Weaker urgency / claim phrasing. Needs corroboration (another weak signal,
// a mass ping, or a topic word) to count.
const WEAK_BAIT_RE = new RegExp(
  [
    "claim\\s+(?:your\\s+)?(?:free\\s+)?(?:gift|prize|reward|drop)",
    "first\\s+\\d{1,4}\\s+(?:people|users|to\\s+claim)",
    "limited\\s+(?:time|spots?|offer)",
    "verify\\s+(?:your\\s+account\\s+)?to\\s+(?:claim|get|receive)",
    "dm\\s+me\\s+to\\s+claim",
    "(?:link|click)\\s+(?:in\\s+bio|below|here)\\s+to\\s+claim",
    "you(?:'ve|\\s+have)\\s+(?:won|been\\s+selected)",
    "exclusive\\s+(?:drop|offer|reward)"
  ].join("|"),
  "i"
);

// Mass-ping bait: @everyone/@here paired with free/claim/giveaway is a near-
// certain scam — legit clip posters don't ping everyone about free stuff.
const MASS_PING_RE = /@everyone|@here/i;
const PING_BAIT_RE = /\b(?:free|claim|giveaway|gift|nitro|reward|prize|airdrop|drop)\b/i;

// Scam-y attachment filenames ("free_nitro.png", "steam-gift.jpg", etc.)
const SCAM_FILENAME_RE = /(?:free|claim|nitro|giveaway|airdrop|reward|steamgift|gift[-_]?card)/i;

function collectTextSources(message) {
  const parts = [];
  if (message?.content) parts.push(String(message.content));
  // embed titles/descriptions (some scams arrive as a bot/webhook embed)
  for (const e of message?.embeds || []) {
    if (e?.title) parts.push(String(e.title));
    if (e?.description) parts.push(String(e.description));
    if (e?.url) parts.push(String(e.url));
    for (const f of e?.fields || []) {
      if (f?.name) parts.push(String(f.name));
      if (f?.value) parts.push(String(f.value));
    }
  }
  return parts.join("\n");
}

// Returns { hit, strong, score, reasons[] }.
//   strong === true  -> high-confidence scam, caller may act immediately.
//   hit === true, strong === false -> suspicious; caller may warn / review.
function detectScamBroadcast(message) {
  const text = collectTextSources(message);
  const reasons = [];
  let score = 0;
  let strong = false;

  if (text) {
    if (SCAM_DOMAIN_RE.test(text)) { reasons.push("scam/phishing domain"); score += 2; strong = true; }
    if (STRONG_BAIT_RE.test(text)) { reasons.push("nitro/steam/crypto bait"); score += 2; strong = true; }

    const massPing = MASS_PING_RE.test(text);
    if (massPing && PING_BAIT_RE.test(text)) {
      reasons.push("@everyone/@here + giveaway bait");
      score += 2;
      strong = true;
    }

    if (WEAK_BAIT_RE.test(text)) { reasons.push("claim/urgency phrasing"); score += 1; }
    if (massPing) { reasons.push("mass ping"); score += 1; }
  }

  // attachment filenames
  if (message?.attachments?.size) {
    for (const att of message.attachments.values()) {
      if (SCAM_FILENAME_RE.test(String(att?.name || ""))) {
        reasons.push(`scam-y filename (${att.name})`);
        score += 1;
        break;
      }
    }
  }

  // Two independent weak signals together also clear the strong bar.
  if (!strong && score >= 2) strong = true;

  return { hit: score >= 1, strong, score, reasons };
}

module.exports = {
  detectScamBroadcast,
  __internals: {
    SCAM_DOMAIN_RE,
    STRONG_BAIT_RE,
    WEAK_BAIT_RE,
    MASS_PING_RE,
    SCAM_FILENAME_RE
  }
};
