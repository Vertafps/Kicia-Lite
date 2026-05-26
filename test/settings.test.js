"use strict";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const initSqlJs = require("sql.js");

const {
  getSetting,
  setSetting,
  resetSetting,
  hydrateSettingsCache,
  listSections,
  describeSetting,
  formatValue,
  coerceInputValue,
  suggestKeys,
  __resetForTests,
  __getCacheSnapshotForTests
} = require("../src/settings");

// Build a fresh in-memory SQLite db with the app_config table.
async function makeDb() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

test.beforeEach(() => {
  __resetForTests();
});

// ---- getSetting defaults ----

test("getSetting returns descriptor default when nothing is cached or persisted", () => {
  // scam.guard.enabled defaults to true per registry
  assert.equal(getSetting("scam.guard.enabled"), true);
  // respect.head.threshold defaults to 0.65 — dropped so the trained head can
  // drive verdicts on implicit/comparative disrespect that has no neg-lex hit.
  assert.equal(getSetting("respect.head.threshold"), 0.65);
  // scam.timeout is not a key — scam.severity.light.timeout defaults to 1h
  assert.equal(getSetting("scam.severity.light.timeout"), 3_600_000);
});

test("getSetting returns undefined for an unknown key", () => {
  assert.equal(getSetting("no.such.key"), undefined);
});

// ---- coerceInputValue ----

test("coerceInputValue duration: '2h' returns 7_200_000 ms", () => {
  const result = coerceInputValue("scam.severity.light.timeout", "2h");
  assert.equal(result.ok, true);
  assert.equal(result.value, 7_200_000);
});

test("coerceInputValue duration: 'bogus' returns ok:false with error", () => {
  const result = coerceInputValue("scam.severity.light.timeout", "bogus");
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
});

test("coerceInputValue bool: 'on' returns true, 'off' returns false", () => {
  assert.deepEqual(coerceInputValue("scam.guard.enabled", "on"), { ok: true, value: true });
  assert.deepEqual(coerceInputValue("scam.guard.enabled", "off"), { ok: true, value: false });
});

test("coerceInputValue bool: 'garbage' returns ok:false", () => {
  const result = coerceInputValue("scam.guard.enabled", "garbage");
  assert.equal(result.ok, false);
  assert.ok(result.error);
});

test("coerceInputValue float: '0.85' returns 0.85", () => {
  const result = coerceInputValue("respect.head.threshold", "0.85");
  assert.equal(result.ok, true);
  assert.equal(result.value, 0.85);
});

test("coerceInputValue unknown key returns ok:false", () => {
  const result = coerceInputValue("not.a.key", "whatever");
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown setting key/i);
});

// ---- suggestKeys ----

test("suggestKeys returns scam.guard.enabled for a one-char typo", () => {
  // 'scam.guard.enabed' is missing an 'l' — close enough to be top suggestion
  const suggestions = suggestKeys("scam.guard.enabed", { limit: 5 });
  assert.ok(Array.isArray(suggestions));
  assert.ok(
    suggestions.includes("scam.guard.enabled"),
    `expected scam.guard.enabled in suggestions, got: ${suggestions}`
  );
});

test("suggestKeys returns empty array for empty input", () => {
  assert.deepEqual(suggestKeys(""), []);
});

// ---- describeSetting ----

test("describeSetting('scam.severity.light.timeout') returns descriptor with section 'scam'", () => {
  const desc = describeSetting("scam.severity.light.timeout");
  assert.ok(desc !== null);
  assert.equal(desc.section, "scam");
  assert.equal(desc.key, "scam.severity.light.timeout");
  assert.ok(typeof desc.description === "string");
});

test("describeSetting for unknown key returns null", () => {
  assert.equal(describeSetting("no.such.key"), null);
});

// ---- listSections ----

test("listSections includes scam, respect, link, support, status", () => {
  const sections = listSections();
  assert.ok(Array.isArray(sections));
  for (const expected of ["scam", "respect", "link", "support", "status"]) {
    assert.ok(sections.includes(expected), `missing section: ${expected}`);
  }
});

// ---- formatValue ----

test("formatValue for a duration key returns a human-readable string", () => {
  // 3_600_000 ms = 1h
  const display = formatValue("scam.severity.light.timeout", 3_600_000);
  assert.match(display, /1\s*h/i);
});

test("formatValue for a bool key returns enabled/disabled", () => {
  assert.equal(formatValue("scam.guard.enabled", true), "enabled");
  assert.equal(formatValue("scam.guard.enabled", false), "disabled");
});

// ---- setSetting / hydrateSettingsCache roundtrip ----

test("setSetting persists value; hydrateSettingsCache loads it; getSetting returns it", async () => {
  const db = await makeDb();

  const setResult = await setSetting("respect.head.threshold", "0.90", { db });
  assert.equal(setResult.ok, true);
  assert.equal(setResult.next, 0.90);

  // Cache should already have the new value (setSetting calls cacheStore).
  assert.equal(getSetting("respect.head.threshold"), 0.90);

  // Clear the cache, then re-hydrate from db.
  __resetForTests();
  assert.equal(getSetting("respect.head.threshold"), 0.65, "should return default after cache clear");

  await hydrateSettingsCache(db);
  assert.equal(getSetting("respect.head.threshold"), 0.90, "should return persisted value after hydrate");
});

test("resetSetting evicts cache; getSetting returns default after eviction", async () => {
  const db = await makeDb();

  await setSetting("scam.guard.enabled", "off", { db });
  assert.equal(getSetting("scam.guard.enabled"), false);

  await resetSetting("scam.guard.enabled", { db });
  // After reset the cache entry is evicted — getSetting should fall back to default.
  assert.equal(getSetting("scam.guard.enabled"), true, "should return default after resetSetting");
});

test("setSetting returns ok:false for unknown key with suggestions", async () => {
  const db = await makeDb();
  const result = await setSetting("scam.timout", "1h", { db });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown setting key/i);
  assert.ok(Array.isArray(result.suggestions));
});
