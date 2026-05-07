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
  maybeHandleOutageDetection,
  observeOutageMessage,
  resetOutageDetectionState
} = require("../src/outage-detector");
const {
  getRuntimeStatus,
  resetRuntimeStatus,
  setRuntimeStatus
} = require("../src/runtime-status");

function buildOutageMessage(content, userId, guild) {
  return {
    id: `msg-${userId}`,
    content,
    guildId: guild.id,
    channelId: "1498745066339045406",
    url: `https://discord.com/channels/${guild.id}/1498745066339045406/msg-${userId}`,
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
    }
  };
  const staff = {
    id: "333333333333333333",
    send: async (payload) => {
      sends.staff.push(payload);
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

test("outage detector requires Kicia product context plus a negative working signal", () => {
  assert.ok(detectOutageStatusComplaint("kiciahook doesnt work rn"));
  assert.ok(detectOutageStatusComplaint("Kicia is down for me"));
  assert.ok(detectOutageStatusComplaint("premium loader not loading"));

  assert.equal(detectOutageStatusComplaint("Even my phone is bugging"), null);
  assert.equal(detectOutageStatusComplaint("does kicia work?"), null);
  assert.equal(detectOutageStatusComplaint("paid kicia destroys ue"), null);
});

test("outage detector triggers on four distinct users inside the window", () => {
  const { guild } = buildGuildFixture();
  const now = 100_000;

  assert.equal(observeOutageMessage(buildOutageMessage("kicia doesnt work", "u1", guild), { now })?.triggered, false);
  assert.equal(observeOutageMessage(buildOutageMessage("kiciahook is down", "u2", guild), { now: now + 1_000 })?.triggered, false);
  assert.equal(observeOutageMessage(buildOutageMessage("loader not loading premium", "u3", guild), { now: now + 2_000 })?.triggered, false);

  const result = observeOutageMessage(buildOutageMessage("kh is broken", "u4", guild), { now: now + 3_000 });
  assert.equal(result.triggered, true);
  assert.equal(result.count, 4);
});

test("outage handler sets status down, alerts configured channels, logs, and locks", async () => {
  const { guild, sends } = buildGuildFixture();
  const logs = [];
  const lockCalls = [];

  setRuntimeStatus("UP");
  setCachedChannelSlot("general", "222222222222222222");
  setCachedChannelSlot("staff", "333333333333333333");

  const messages = [
    buildOutageMessage("kicia doesnt work", "u1", guild),
    buildOutageMessage("kiciahook is down", "u2", guild),
    buildOutageMessage("premium loader not loading", "u3", guild),
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

  assert.equal(getRuntimeStatus(), "DOWN");
  assert.equal(lockCalls.length, 1);
  assert.equal(sends.general.length, 1);
  assert.match(sends.general[0].content, /ISSUE DETECTED \[Auto Detection\]/);
  assert.equal(sends.staff.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0].header, /Outage Auto Detection Triggered/i);
});
