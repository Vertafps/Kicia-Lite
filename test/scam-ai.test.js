process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGeminiPrompt,
  classifyScamContextWithGemini,
  parseGeminiBoolean,
  resetScamAiState
} = require("../src/scam-ai");

test("Gemini scam prompt keeps only target-user context and reply context", () => {
  const prompt = buildGeminiPrompt({
    userMessages: ["older", "selling", "configs", "dm me"],
    repliedToMessage: {
      authorLabel: "Other User",
      content: "where is executor link"
    }
  });

  assert.doesNotMatch(prompt, /\bolder\b/);
  assert.match(prompt, /Other User: where is executor link/i);
  assert.match(prompt, /1\. selling/i);
  assert.match(prompt, /2\. configs/i);
  assert.match(prompt, /3\. dm me/i);
  assert.match(prompt, /Return exactly TRUE or FALSE/i);
});

test("Gemini scam parser accepts strict boolean answers only", () => {
  assert.equal(parseGeminiBoolean({
    candidates: [{ content: { parts: [{ text: "TRUE" }] } }]
  }), true);
  assert.equal(parseGeminiBoolean({
    candidates: [{ content: { parts: [{ text: "FALSE\n" }] } }]
  }), false);
  assert.equal(parseGeminiBoolean({
    candidates: [{ content: { parts: [{ text: "maybe" }] } }]
  }), null);
});

test("Gemini scam classifier skips cleanly when no API key is configured", async () => {
  resetScamAiState();
  const result = await classifyScamContextWithGemini({
    userMessages: ["selling", "configs"],
    repliedToMessage: null
  }, {
    fetchFn: async () => {
      throw new Error("fetch should not run without a key");
    }
  });

  assert.equal(result.attempted, false);
  assert.equal(result.skipped, "missing_key");
  assert.equal(result.verdict, null);
});
