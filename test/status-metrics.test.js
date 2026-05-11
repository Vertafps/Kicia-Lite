process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  recordStatusTransition,
  resetRestrictedEmojiDatabaseForTests,
  clearStatusHistoryForTests
} = require("../src/restricted-emoji-db");
const {
  buildStatusMetrics,
  buildTimeline,
  computeTimeInState,
  computeIncidents,
  buildRibbonFromSegments,
  formatRelative
} = require("../src/status-metrics");
const {
  enableStatusPersistence,
  setRuntimeStatus,
  resetRuntimeStatus,
  hydrateRuntimeStatus,
  getRuntimeStatus
} = require("../src/runtime-status");

const testDbPath = path.join(os.tmpdir(), `kicialite-status-metrics-test-${process.pid}.sqlite`);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test.before(async () => {
  enableStatusPersistence({
    recordStatusTransition,
    getPersistedRuntimeStatus: require("../src/restricted-emoji-db").getPersistedRuntimeStatus
  });
});

test.beforeEach(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
  await clearStatusHistoryForTests();
  resetRuntimeStatus();
});

test.after(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
});

test("buildTimeline carries pre-window state through when there are no early transitions", () => {
  const windowEnd = 100_000;
  const windowStart = windowEnd - 10_000;
  // No transitions, current status DOWN — whole window should be DOWN.
  const { segments } = buildTimeline({
    windowStart,
    windowEnd,
    transitions: [],
    currentStatus: "DOWN"
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].state, "DOWN");
  assert.equal(segments[0].to - segments[0].from, 10_000);
});

test("buildTimeline derives pre-window state from first in-window transition's fromStatus", () => {
  const windowEnd = 100_000;
  const windowStart = windowEnd - 10_000;
  const transitions = [
    { id: 1, occurredAt: 95_000, fromStatus: "UP", toStatus: "DOWN" }
  ];
  const { segments } = buildTimeline({
    windowStart,
    windowEnd,
    transitions,
    currentStatus: "DOWN"
  });
  assert.equal(segments.length, 2);
  assert.equal(segments[0].state, "UP");
  assert.equal(segments[1].state, "DOWN");
});

test("computeTimeInState accumulates ms per state across multiple flips", () => {
  const segments = [
    { from: 0, to: 1000, state: "UP" },
    { from: 1000, to: 1500, state: "DOWN" },
    { from: 1500, to: 1800, state: "UNAWARE" },
    { from: 1800, to: 2400, state: "UP" }
  ];
  const totals = computeTimeInState(segments);
  assert.equal(totals.UP, 1600);
  assert.equal(totals.DOWN, 500);
  assert.equal(totals.UNAWARE, 300);
});

test("computeIncidents counts transitions into DOWN or UNAWARE within window", () => {
  const transitions = [
    { occurredAt: 50, toStatus: "DOWN" }, // before window
    { occurredAt: 150, toStatus: "DOWN" },
    { occurredAt: 200, toStatus: "UP" },
    { occurredAt: 300, toStatus: "UNAWARE" },
    { occurredAt: 1500, toStatus: "DOWN" } // after window
  ];
  const count = computeIncidents(transitions, { windowStart: 100, windowEnd: 1000 });
  assert.equal(count, 2);
});

test("buildRibbonFromSegments produces 96 slots with correct dominant state", () => {
  // 24h window where the last 6h is DOWN, rest UP.
  const windowEnd = 24 * 60 * 60 * 1000;
  const windowStart = 0;
  const segments = [
    { from: 0, to: 18 * 60 * 60 * 1000, state: "UP" },
    { from: 18 * 60 * 60 * 1000, to: windowEnd, state: "DOWN" }
  ];
  const ribbon = buildRibbonFromSegments(segments, { windowStart, windowEnd });
  assert.equal(ribbon.length, 96);
  // First 72 slots (18h) should be up.
  assert.equal(ribbon[0], "up");
  assert.equal(ribbon[70], "up");
  // Last 24 slots (6h) should be down.
  assert.equal(ribbon[80], "down");
  assert.equal(ribbon[95], "down");
});

test("formatRelative produces readable buckets", () => {
  assert.equal(formatRelative(30_000), "just now");
  assert.equal(formatRelative(5 * 60_000), "5m ago");
  assert.equal(formatRelative(3 * HOUR), "3h ago");
  assert.equal(formatRelative(2 * DAY), "2d ago");
});

test("setRuntimeStatus persists transitions that buildStatusMetrics can read back", async () => {
  const now = Date.now();
  setRuntimeStatus("DOWN", {
    actor: { id: "auto", label: "Auto Detection" },
    reason: "test outage",
    now: now - 30 * 60_000
  });
  // Give the fire-and-forget persistence a tick to flush.
  await new Promise((r) => setImmediate(r));
  setRuntimeStatus("UP", {
    actor: { id: "staff-1", label: "Mod" },
    reason: "all clear",
    now: now - 10 * 60_000
  });
  await new Promise((r) => setImmediate(r));

  const metrics = await buildStatusMetrics({ now, windowMs: DAY });
  assert.equal(metrics.status, "UP");
  assert.equal(metrics.incidents, 1, "one DOWN transition in window");
  assert.match(metrics.lastDownLabel, /^\d+m ago$/);
  // 20 min of DOWN in a 24h window: uptime ~ (1440 - 20)/1440 ≈ 98.6%.
  assert.ok(metrics.uptimePct > 98 && metrics.uptimePct < 100, `unexpected uptime ${metrics.uptimePct}`);
  assert.ok(metrics.timeInState.DOWN >= 19 * 60_000 && metrics.timeInState.DOWN <= 21 * 60_000);
});

test("runtime status hydrates from disk after a 'restart'", async () => {
  const now = Date.now();
  setRuntimeStatus("DOWN", { actor: { id: "auto", label: "Auto" }, now });
  await new Promise((r) => setImmediate(r));

  // Simulate a restart: wipe in-memory but leave the DB row.
  resetRuntimeStatus();
  assert.equal(getRuntimeStatus(), "UP");

  const restored = await hydrateRuntimeStatus({ now: now + 60_000 });
  assert.equal(restored?.status, "DOWN");
  assert.equal(getRuntimeStatus(), "DOWN");
});
