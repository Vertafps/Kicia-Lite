process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resetChannelConfigCache,
  setCachedChannelSlot
} = require("../src/channel-config");
const {
  detectOutageStatusComplaint,
  getPendingReviewForGuild,
  getReview,
  hydratePendingOutageReviews,
  maybeHandleOutageDetection,
  observeOutageMessage,
  resetOutageDetectionState,
  resolveOutageReview
} = require("../src/outage-detector");
const {
  getRuntimeStatus,
  resetRuntimeStatus,
  setRuntimeStatus
} = require("../src/runtime-status");
const {
  cleanupExpiredOutageReviews,
  resetRestrictedEmojiDatabaseForTests
} = require("../src/restricted-emoji-db");

const testDbPath = path.join(os.tmpdir(), `kicialite-outage-test-${process.pid}.sqlite`);

test.beforeEach(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
  // Force the DB to fully load (which would otherwise clear the channel cache mid-test
  // when the outage detector lazily writes a row).
  await cleanupExpiredOutageReviews({ now: 1 }).catch(() => null);
});

test.after(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
});

function buildOutageMessage(content, userId, guild, channelId = "1498745066339045406") {
  return {
    id: `msg-${userId}`,
    content,
    guildId: guild.id,
    channelId,
    url: `https://discord.com/channels/${guild.id}/${channelId}/msg-${userId}`,
    guild,
    author: {
      id: userId,
      bot: false
    },
    inGuild: () => true
  };
}

function buildGuildFixture() {
  const sends = {
    general: [],
    staff: []
  };
  const general = {
    id: "222222222222222222",
    send: async (payload) => {
      sends.general.push(payload);
      return { id: `gen-${sends.general.length}`, edit: async () => null };
    }
  };
  const staff = {
    id: "333333333333333333",
    send: async (payload) => {
      sends.staff.push(payload);
      return { id: `staff-${sends.staff.length}`, edit: async () => null };
    }
  };
  const cache = new Map([
    [general.id, general],
    [staff.id, staff]
  ]);

  return {
    guild: {
      id: "guild-1",
      channels: {
        cache,
        fetch: async (id) => cache.get(id) || null
      }
    },
    sends
  };
}

test.afterEach(() => {
  resetOutageDetectionState();
  resetChannelConfigCache();
  resetRuntimeStatus();
});

test("outage detector requires a brand subject for the outage signal", () => {
  assert.ok(detectOutageStatusComplaint("kiciahook doesnt work rn"));
  assert.ok(detectOutageStatusComplaint("Kicia is down for me"));
  assert.ok(detectOutageStatusComplaint("kh just crashed"));
  assert.ok(detectOutageStatusComplaint("is kicia down?"));
});

test("outage detector ignores third-party services even if they have status words", () => {
  assert.equal(detectOutageStatusComplaint("Even my phone is bugging"), null);
  assert.equal(detectOutageStatusComplaint("does kicia work?"), null);
  assert.equal(detectOutageStatusComplaint("paid kicia destroys ue"), null);
  assert.equal(detectOutageStatusComplaint("the executor is down"), null);
  assert.equal(detectOutageStatusComplaint("loader not loading"), null);
  assert.equal(detectOutageStatusComplaint("my premium is broken"), null);
  assert.equal(detectOutageStatusComplaint("im down for kicia later"), null);
});

test("outage detector triggers on four distinct users with brand-anchored complaints", () => {
  const { guild } = buildGuildFixture();
  const now = 100_000;

  assert.equal(observeOutageMessage(buildOutageMessage("kicia doesnt work", "u1", guild), { now })?.triggered, false);
  assert.equal(observeOutageMessage(buildOutageMessage("kiciahook is down", "u2", guild), { now: now + 1_000 })?.triggered, false);
  assert.equal(observeOutageMessage(buildOutageMessage("kicia just crashed for me", "u3", guild), { now: now + 2_000 })?.triggered, false);

  const result = observeOutageMessage(buildOutageMessage("kh is broken", "u4", guild), { now: now + 3_000 });
  assert.equal(result.triggered, true);
  assert.equal(result.count, 4);
});

test("outage handler sets unaware status, alerts staff with buttons, locks, and logs", async () => {
  const { guild, sends } = buildGuildFixture();
  const logs = [];
  const lockCalls = [];

  setRuntimeStatus("UP");
  setCachedChannelSlot("general", "222222222222222222");
  setCachedChannelSlot("staff", "333333333333333333");

  const messages = [
    buildOutageMessage("kicia doesnt work", "u1", guild),
    buildOutageMessage("kiciahook is down", "u2", guild),
    buildOutageMessage("kicia just crashed for me", "u3", guild),
    buildOutageMessage("kh is broken", "u4", guild)
  ];

  for (const [index, message] of messages.entries()) {
    await maybeHandleOutageDetection(message, {
      now: 10_000 + index * 1_000,
      sendLog: async (_guild, panel) => {
        logs.push(panel);
        return true;
      },
      lockChannels: async () => {
        lockCalls.push(true);
        return {
          ok: true,
          result: {
            changed: [{ channel: { id: "222222222222222222" } }],
            skipped: []
          }
        };
      }
    });
  }

  assert.equal(getRuntimeStatus(), "UNAWARE");
  assert.equal(lockCalls.length, 1);
  assert.equal(sends.general.length, 1);
  assert.match(sends.general[0].content, /ISSUE DETECTED/i);
  assert.equal(sends.staff.length, 1);
  assert.ok(Array.isArray(sends.staff[0].components));
  assert.equal(sends.staff[0].components.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0].header, /Outage Auto Detection Triggered/i);
});

test("confirming an outage review keeps status DOWN and posts a confirm panel", async () => {
  const { guild, sends } = buildGuildFixture();
  setCachedChannelSlot("general", "222222222222222222");
  setCachedChannelSlot("staff", "333333333333333333");
  const logs = [];

  const messages = [
    buildOutageMessage("kicia doesnt work", "u1", guild),
    buildOutageMessage("kiciahook is down", "u2", guild),
    buildOutageMessage("kicia just crashed for me", "u3", guild),
    buildOutageMessage("kh is broken", "u4", guild)
  ];

  for (const [index, message] of messages.entries()) {
    await maybeHandleOutageDetection(message, {
      now: 10_000 + index * 1_000,
      sendLog: async (_g, panel) => { logs.push(panel); return true; },
      lockChannels: async () => ({
        ok: true,
        result: { changed: [], skipped: [] }
      })
    });
  }

  const review = getPendingReviewForGuild(guild.id);
  assert.ok(review);

  const result = await resolveOutageReview(review.reviewId, {
    resolution: "confirmed",
    actor: { id: "staff-1", label: "Mod" },
    guild,
    sendLog: async (_g, panel) => { logs.push(panel); return true; }
  });

  assert.ok(result.ok);
  assert.equal(getRuntimeStatus(), "DOWN");
  assert.match(sends.general[1].embeds[0].data.title, /KiciaHook is currently DOWN/i);
});

test("dismissing as false alarm restores status UP and unlocks", async () => {
  const { guild, sends } = buildGuildFixture();
  setCachedChannelSlot("general", "222222222222222222");
  setCachedChannelSlot("staff", "333333333333333333");
  const logs = [];
  const unlockCalls = [];

  const messages = [
    buildOutageMessage("kicia doesnt work", "u1", guild),
    buildOutageMessage("kiciahook is down", "u2", guild),
    buildOutageMessage("kicia just crashed for me", "u3", guild),
    buildOutageMessage("kh is broken", "u4", guild)
  ];

  for (const [index, message] of messages.entries()) {
    await maybeHandleOutageDetection(message, {
      now: 10_000 + index * 1_000,
      sendLog: async (_g, panel) => { logs.push(panel); return true; },
      lockChannels: async () => ({
        ok: true,
        result: { changed: [], skipped: [] }
      })
    });
  }

  const review = getPendingReviewForGuild(guild.id);
  assert.ok(review);

  const result = await resolveOutageReview(review.reviewId, {
    resolution: "false_alarm",
    actor: { id: "staff-1", label: "Mod" },
    guild,
    unlockChannels: async () => {
      unlockCalls.push(true);
      return { ok: true, result: { changed: [{ channel: { id: "x" } }], skipped: [] } };
    },
    sendLog: async (_g, panel) => { logs.push(panel); return true; }
  });

  assert.ok(result.ok);
  assert.equal(unlockCalls.length, 1);
  assert.equal(getRuntimeStatus(), "UP");
  assert.match(sends.general[1].embeds[0].data.title, /All clear/i);
});

test("pending outage reviews survive bot restart via sqlite hydration", async () => {
  const { guild } = buildGuildFixture();
  setCachedChannelSlot("general", "222222222222222222");
  setCachedChannelSlot("staff", "333333333333333333");

  const messages = [
    buildOutageMessage("kicia doesnt work", "u1", guild),
    buildOutageMessage("kiciahook is down", "u2", guild),
    buildOutageMessage("kicia just crashed for me", "u3", guild),
    buildOutageMessage("kh is broken", "u4", guild)
  ];

  for (const [index, message] of messages.entries()) {
    await maybeHandleOutageDetection(message, {
      now: 10_000 + index * 1_000,
      sendLog: async () => true,
      lockChannels: async () => ({ ok: true, result: { changed: [], skipped: [] } })
    });
  }

  const live = getPendingReviewForGuild(guild.id);
  assert.ok(live, "review created in-memory");
  const reviewId = live.reviewId;

  // Simulate bot restart: wipe in-memory state but keep the sqlite row.
  resetOutageDetectionState();
  assert.equal(getReview(reviewId), null, "in-memory state cleared");

  // Hydrate as the bot does on ClientReady.
  const restored = await hydratePendingOutageReviews({ now: 20_000 });
  assert.equal(restored, 1, "one pending review restored from disk");

  const hydrated = getReview(reviewId);
  assert.ok(hydrated, "hydrated review available by id");
  assert.equal(hydrated.status, "pending");
  assert.equal(hydrated.guildId, guild.id);
  assert.equal(hydrated.distinctUsers, 4);
  assert.ok(hydrated.restoredFromDisk, "marker set so resolver knows to fall back to default helpers");
});

test("resolved outage reviews don't reappear after restart", async () => {
  const { guild } = buildGuildFixture();
  setCachedChannelSlot("general", "222222222222222222");
  setCachedChannelSlot("staff", "333333333333333333");

  const messages = [
    buildOutageMessage("kicia doesnt work", "u1", guild),
    buildOutageMessage("kiciahook is down", "u2", guild),
    buildOutageMessage("kicia just crashed for me", "u3", guild),
    buildOutageMessage("kh is broken", "u4", guild)
  ];

  for (const [index, message] of messages.entries()) {
    await maybeHandleOutageDetection(message, {
      now: 10_000 + index * 1_000,
      sendLog: async () => true,
      lockChannels: async () => ({ ok: true, result: { changed: [], skipped: [] } })
    });
  }

  const live = getPendingReviewForGuild(guild.id);
  assert.ok(live);

  await resolveOutageReview(live.reviewId, {
    resolution: "false_alarm",
    actor: { id: "staff-1", label: "Mod" },
    guild,
    unlockChannels: async () => ({ ok: true, result: { changed: [], skipped: [] } }),
    sendLog: async () => true
  });

  resetOutageDetectionState();
  const restored = await hydratePendingOutageReviews({ now: 30_000 });
  assert.equal(restored, 0, "resolved review is not re-hydrated as pending");
});
