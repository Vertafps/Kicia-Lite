process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildModerationGuardLines } = require("../src/diagnostics");

test("jarvis moderation guard lines show false info and suspicious alert coverage", () => {
  const body = buildModerationGuardLines().join("\n");

  assert.match(body, /False Info Guard/i);
  assert.match(body, /trusted extras/i);
  assert.match(body, /Suspicious Alerts/i);
  assert.match(body, /warn at 2/i);
  assert.match(body, /timeout at 3 in 30m/i);
  assert.match(body, /timeout 10m/i);
  assert.match(body, /private DM steering/i);
  assert.doesNotMatch(body, /defender|antivirus/i);
});
