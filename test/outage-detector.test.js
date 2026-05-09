process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resetChannelConfigCache,
  setCachedChannelSlot
} = require("../src/channel-config");
const {
  detectOutageStatusComplaint,
  getPendingReviewForGuild,
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
