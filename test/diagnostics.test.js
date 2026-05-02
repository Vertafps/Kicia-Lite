process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildIntelligenceGuardLines,
  buildJarvisProgressBody,
  buildModerationGuardLines,
  pickJarvisVisibleMs,
  runJarvisDiagnostics
} = require("../src/diagnostics");

test("jarvis moderation guard lines show false info and suspicious alert coverage", () => {
  const body = buildModerationGuardLines().join("\n");

  assert.match(body, /False Info Guard/i);
  assert.match(body, /docs\/trusted\/gifs/i);
  assert.match(body, /homoglyphs/i);
  assert.match(body, /masked links/i);
  assert.match(body, /shorteners\/invites warn/i);
  assert.match(body, /Suspicious Alerts/i);
  assert.match(body, /timeout at 2 in 1h/i);
  assert.match(body, /timeout 10m/i);
  assert.match(body, /confidence > 90% timeout 1h/i);
  assert.match(body, /Scam\/Trade Guard/i);
  assert.match(body, /confirmed confidence ladder/i);
  assert.match(body, />90% 3d/i);
  assert.match(body, />85% 1d/i);
  assert.match(body, />75% 1h/i);
  assert.match(body, />70% 30m/i);
  assert.match(body, /2 hits in 30m/i);
  assert.match(body, /3 hits if confidence < 50%/i);
  assert.match(body, /repeat timeout 15m/i);
  assert.match(body, /last 5 messages plus per-message reply context/i);
  assert.match(body, /local Kicia policy \+ Naive Bayes classifier/i);
  assert.match(body, /Gemini fallback optional\/off|Gemini gemini-2\.5-flash-lite handles borderline cases/i);
  assert.match(body, /AI cache 10m/i);
  assert.match(body, /local AI gap 12s/i);
  assert.match(body, /remote AI failure cooldown 2m/i);
  assert.match(body, /private DM steering/i);
  assert.match(body, /credential\/2FA/i);
  assert.match(body, /accidental-report/i);
  assert.match(body, /QR\/OAuth/i);
  assert.doesNotMatch(body, /disable-security/i);
});

test("jarvis intelligence guard shows scam pulse coverage", () => {
  const body = buildIntelligenceGuardLines().join("\n");

  assert.match(body, /Scam Pulse/i);
  assert.match(body, /FishFish URL\/domain checks enabled/i);
  assert.match(body, /timeout 7d/i);
  assert.match(body, /PhishTank/i);
  assert.doesNotMatch(body, /not configured/i);
});

test("jarvis progress body is clean and current", () => {
  const body = buildJarvisProgressBody(2, "refreshing KB");

  assert.match(body, /JARVIS \/\/ Wizard of Kicia systems sweep/i);
  assert.match(body, /window\s+15s-30s/i);
  assert.match(body, /\[OK  \] Wake Core/i);
  assert.match(body, /\[RUN \] KB Cache/i);
  assert.match(body, /matrix\s+runtime \| docs \| moderation \| security \| intel/i);
  assert.doesNotMatch(body, /under 15 seconds/i);
  assert.doesNotMatch(body, /Core heat/i);
});

test("jarvis visible sweep target is between 15 and 30 seconds", () => {
  assert.equal(pickJarvisVisibleMs(() => 0), 15_000);
  assert.equal(pickJarvisVisibleMs(() => 1), 30_000);
  assert.equal(pickJarvisVisibleMs(() => 0.5), 22_500);
});

test("jarvis diagnostics paces the fake loading window before final report", async () => {
  const progressBodies = [];
  const sleeps = [];
  let now = 1_000;

  const report = await runJarvisDiagnostics({
    client: {
      ws: {
        ping: 42
      }
    },
    inGuild: () => false
  }, {
    refreshKb: async () => ({
      issues: [],
      executorAliasIndex: {}
    }),
    channelLockRoleId: "role-1",
    targetVisibleMs: 15_000,
    nowFn: () => now,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    onProgress: async ({ body, targetVisibleMs }) => {
      progressBodies.push({ body, targetVisibleMs });
    }
  });

  assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), 15_000);
  assert.equal(progressBodies.length, 6);
  assert.ok(progressBodies.every((entry) => entry.targetVisibleMs === 15_000));
  assert.match(report.body, /Sweep complete/i);
});
