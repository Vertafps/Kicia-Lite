process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";
process.env.GEMINI_API_KEY = "";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const {
  buildGeminiPrompt,
  classifyScamContextWithGemini,
  parseGeminiBoolean,
  resetScamAiState
} = require("../src/scam-ai");

test("Gemini scam prompt keeps only target-user context and reply context", () => {
  const prompt = buildGeminiPrompt({
    messageContexts: [
      { content: "oldest" },
      { content: "older" },
      { content: "selling" },
      {
        content: "configs",
        repliedToMessage: {
          authorLabel: "Buyer",
          content: "do you have configs"
        }
      },
      { content: "dm me" },
      { content: "price" }
    ],
    repliedToMessage: {
      authorLabel: "Other User",
      content: "where is executor link"
    }
  });

  assert.doesNotMatch(prompt, /1\. oldest/i);
  assert.match(prompt, /Other User: where is executor link/i);
  assert.match(prompt, /1\. older/i);
  assert.match(prompt, /3\. configs \| replied to Buyer: do you have configs/i);
  assert.match(prompt, /4\. dm me/i);
  assert.match(prompt, /5\. price/i);
  assert.match(prompt, /Return exactly TRUE or FALSE/i);
  assert.match(prompt, /can I buy this\/ts with roblox/i);
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

test("Gemini scam classifier enters cooldown after remote rate limit", () => {
  const script = `
    process.env.DISCORD_TOKEN = "test-token";
    process.env.KB_URL = "https://example.com/kb.json";
    process.env.GEMINI_API_KEY = "test-key";
    const { classifyScamContextWithGemini, resetScamAiState } = require("./src/scam-ai");
    (async () => {
      resetScamAiState();
      const context = { userMessages: ["anyone selling kicia config?"], repliedToMessage: null };
      const first = await classifyScamContextWithGemini(context, {
        now: 20_000,
        fetchFn: async () => ({ ok: false, status: 429 })
      });
      const second = await classifyScamContextWithGemini(context, {
        now: 20_001,
        fetchFn: async () => { throw new Error("fetch should be skipped during cooldown"); }
      });
      process.stdout.write(JSON.stringify({ first, second }));
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  `;

  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      GEMINI_API_KEY: "test-key",
      DISCORD_TOKEN: "test-token",
      KB_URL: "https://example.com/kb.json"
    }
  });

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.first.attempted, true);
  assert.equal(result.first.skipped, "remote_rate_limit");
  assert.equal(result.second.attempted, false);
  assert.equal(result.second.skipped, "cooldown");
});
