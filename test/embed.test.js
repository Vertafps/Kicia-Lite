process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPanel } = require("../src/embed");

test("buildPanel can render log key-value lines as structured fields", () => {
  const embed = buildPanel({
    header: "Moderation Action Reverted",
    body: [
      "staff reverted a moderation timeout from the log controls",
      "",
      "**User:** @Speed",
      "",
      "**Reverted By:** @Kernal",
      "",
      "**Channel:** #premium-club",
      "",
      "**Original Action:** Scam/Trade Timeout"
    ].join("\n"),
    autoFields: true,
    timestamp: false
  }).toJSON();

  assert.equal(embed.title, "Moderation Action Reverted");
  assert.equal(embed.description, "staff reverted a moderation timeout from the log controls");
  assert.deepEqual(
    embed.fields.map((field) => [field.name, field.value, field.inline]),
    [
      ["User", "@Speed", true],
      ["Reverted By", "@Kernal", true],
      ["Channel", "#premium-club", true],
      ["Original Action", "Scam/Trade Timeout", true]
    ]
  );
});

test("buildPanel leaves key-value lines flat unless autoFields is enabled", () => {
  const embed = buildPanel({
    header: "Scam Pulse Primed",
    body: ["FishFish feed refreshed.", "", "**Domains Cached:** 41846"].join("\n"),
    timestamp: false
  }).toJSON();

  assert.equal(embed.title, "Scam Pulse Primed");
  assert.match(embed.description, /\*\*Domains Cached:\*\* 41846/);
  assert.equal(embed.fields, undefined);
});
