process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeKb } = require("../src/kb");
const { classifyTranscript } = require("../src/router");
const { getCooldownReaction, markGuildReply, resetCooldowns } = require("../src/handlers/cooldown");
const { maybeHandleStatusCommand } = require("../src/handlers/status");
const { resetRuntimeStatus, getRuntimeStatus } = require("../src/runtime-status");

const kb = normalizeKb({
  executors: {
    supported: [
      {
        name: "Isaeva",
        aliases: ["isaeva", "isava"],
        compatibility: "fully compatible, recommended"
      },
      {
        name: "Potassium",
        aliases: ["potassium", "pot"]
      }
    ],
    temporarily_not_working: [{ name: "Solar", aliases: ["solar"] }],
    not_recommended: [{ name: "Delta", aliases: ["delta"] }],
    unsupported: [{ name: "Wave", aliases: ["wave"] }]
  },
  issues: [
    {
      title: "GUI Not Loading / Security Kick 1 / FPS Drops / Lag / Lobby Issue",
      category: "executor",
      keywords: ["freeze", "freezes", "lobby", "gui not loading"],
      match_phrases: ["gui not loading", "no gui"]
    },
    {
      title: "How to Load a Config",
      category: "config",
      keywords: ["load config", "import config", "config not showing"],
      match_phrases: ["load config", "import config"]
    },
    {
      title: "Account Transfers / Discord Server Ban",
      category: "support_only",
      keywords: ["account transfer", "discord ban", "server ban"],
      match_phrases: ["account transfer", "server ban"]
    },
    {
      title: "Difference Between Free and Premium",
      category: "product",
      keywords: ["free vs premium", "premium features", "why premium"],
      match_phrases: ["free vs premium"]
    },
    {
      title: "Lost a Fight While Using Premium",
      category: "config",
      keywords: ["premium lost fight", "bad config", "premium weak"],
      match_phrases: ["premium bad"]
    }
  ]
});

test.afterEach(() => {
  resetCooldowns();
  resetRuntimeStatus();
});

test("routes supported executor by canonical name", () => {
  const route = classifyTranscript("is potassium supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /Potassium is supported/i);
});

test("routes supported executor by alias", () => {
  const route = classifyTranscript("is isava supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /Isaeva is supported and recommended/i);
});

test("routes recommended executor distinctly", () => {
  const route = classifyTranscript("is isaeva supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /recommended/i);
});

test("routes not recommended executor as still working", () => {
  const route = classifyTranscript("is delta supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /can still work/i);
  assert.match(route.body, /not one we recommend/i);
});

test("routes unsupported executor", () => {
  const route = classifyTranscript("is wave supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /isn't supported/i);
});

test("routes unknown executor with clear support intent", () => {
  const route = classifyTranscript("is phantom supported", kb, "UP");
  assert.equal(route.kind, "executor_unknown");
  assert.match(route.body, /not in the documentation/i);
});

test("executor names without support intent do not hijack issue matching", () => {
  const route = classifyTranscript("delta gui freezes in lobby", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /GUI Not Loading/i);
});

test("routes status questions for down wording", () => {
  const route = classifyTranscript("is kicia down", kb, "UP");
  assert.equal(route.kind, "status");
  assert.equal(route.body, "status says it's up rn");
});

test("routes status questions for up wording", () => {
  const route = classifyTranscript("kicia up?", kb, "DOWN");
  assert.equal(route.kind, "status");
  assert.equal(route.body, "status says it's down rn");
});

test("non-status phrases that mention kicia do not trigger status mode", () => {
  const route = classifyTranscript("kicia gui freezes in lobby", kb, "UP");
  assert.equal(route.kind, "docs");
});

test("down note only appends to normal replies while down", () => {
  const docsRoute = classifyTranscript("gui not loading", kb, "DOWN");
  assert.equal(docsRoute.kind, "docs");
  assert.match(docsRoute.extra, /kiciahook is down rn/i);

  const statusRoute = classifyTranscript("status?", kb, "DOWN");
  assert.equal(statusRoute.kind, "status");
  assert.equal(statusRoute.extra, undefined);
});

test("exact issue phrase hits docs", () => {
  const route = classifyTranscript("gui not loading", kb, "UP");
  assert.equal(route.kind, "docs");
});

test("fuzzy natural phrasing can still hit docs", () => {
  const route = classifyTranscript("gui freezes in lobby", kb, "UP");
  assert.equal(route.kind, "docs");
});

test("vague one word input falls back to ticket", () => {
  const route = classifyTranscript("premium", kb, "UP");
  assert.equal(route.kind, "ticket");
});

test("support only issue routes to ticket", () => {
  const route = classifyTranscript("account transfer", kb, "UP");
  assert.equal(route.kind, "ticket");
  assert.equal(route.reason, "support_only");
});

test("same user inside 30 seconds gets user cooldown reaction", () => {
  markGuildReply("user-a", 1_000);
  assert.equal(getCooldownReaction("user-a", 10_000), "🧊");
});

test("different user inside 5 seconds gets global cooldown reaction", () => {
  markGuildReply("user-a", 1_000);
  assert.equal(getCooldownReaction("user-b", 4_000), "🚧");
});

test("owner status command bypasses cooldown logic", async () => {
  markGuildReply("someone-else", 1_000);

  let replied = false;
  const handled = await maybeHandleStatusCommand({
    content: "$status down",
    author: { id: "847703912932311091" },
    reply: async () => {
      replied = true;
    }
  });

  assert.equal(handled, true);
  assert.equal(replied, true);
  assert.equal(getRuntimeStatus(), "DOWN");
});
