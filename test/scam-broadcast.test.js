"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { detectScamBroadcast } = require("../src/scam-broadcast");

function msg(content, filenames = []) {
  return {
    content,
    embeds: [],
    attachments: {
      size: filenames.length,
      values: () => filenames.map((n) => ({ name: n }))
    }
  };
}

// Must be flagged STRONG (immediate-timeout tier).
const SCAMS = [
  "@everyone FREE NITRO GIVEAWAY claim here https://dlscord-nitro.ru/claim",
  "free discord nitro for the first 50 people, link in bio",
  "MrBeast giveaway! claim your $50 steam gift card now",
  "connect your wallet to claim the airdrop",
  "steam gift card giveaway, dm me to claim",
  "claim your free nitro https://discordapp.gift-claim.xyz",
  "free robux generator working 2026",
  "@everyone free gift cards claim now",
  "get your free nitro here",
  "exclusive crypto airdrop, connect wallet to claim"
];

// Must NOT be flagged (normal clips chatter / benign mentions).
const BENIGN = [
  "check out my clip",
  "yo this v3 config is insane",
  "gg everyone nice game",
  "anyone got a good aimbot config",
  "lol that was free real estate",
  "i won the 1v1 ez",
  "giveaway when?",
  "is there a server giveaway today",
  "streamable.com/abc123 my clip",
  "free kill on the enemy team lol",
  "this map is free wins"
];

test.describe("scam-broadcast: strong scam detection", () => {
  for (const s of SCAMS) {
    test(`STRONG: "${s.slice(0, 50)}"`, () => {
      const r = detectScamBroadcast(msg(s));
      assert.equal(r.strong, true, `expected strong, got score=${r.score} reasons=${r.reasons.join(",")}`);
    });
  }
});

test.describe("scam-broadcast: benign chatter is never strong", () => {
  for (const b of BENIGN) {
    test(`benign: "${b.slice(0, 50)}"`, () => {
      const r = detectScamBroadcast(msg(b));
      assert.equal(r.strong, false, `false positive: reasons=${r.reasons.join(",")}`);
    });
  }
});

test.describe("scam-broadcast: edge cases", () => {
  test("empty message → no hit", () => {
    const r = detectScamBroadcast(msg(""));
    assert.equal(r.hit, false);
  });

  test("scam-y filename alone is weak, not strong (still removed by video-only rule)", () => {
    const r = detectScamBroadcast(msg("", ["free_nitro.png"]));
    assert.equal(r.strong, false);
    assert.equal(r.hit, true);
  });

  test("scam-y filename + bait caption → strong", () => {
    const r = detectScamBroadcast(msg("free nitro!!", ["claim.png"]));
    assert.equal(r.strong, true);
  });
});
