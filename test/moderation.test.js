process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");

const { normalizeKb } = require("../src/kb");
const {
  detectSellingSignal,
  detectSuspiciousSignal,
  detectFakeInfoSignal,
  hasBypassPermission,
  observeRaidMessage,
  resetModerationState
} = require("../src/handlers/moderation");

const kb = normalizeKb({
  issues: [],
  executors: {
    supported: [
      {
        name: "Potassium",
        aliases: ["potassium"],
        link: "https://potassium.pro/"
      }
    ],
    temporarily_not_working: [
      {
        name: "Solar",
        aliases: ["solar"]
      }
    ],
    not_recommended: [],
    unsupported: [
      {
        name: "Wave",
        aliases: ["wave"]
      }
    ]
  }
});

function buildRaidMessage(content, userId, { permissions = [] } = {}) {
  return {
    id: `${userId}-${content.length}`,
    content,
    guildId: "guild-1",
    channelId: "channel-1",
    author: { id: userId, bot: false },
    member: {
      roles: {
        cache: {
          has: () => false
        }
      },
      permissions: new PermissionsBitField(permissions)
    },
    inGuild: () => true
  };
}

test.afterEach(() => {
  resetModerationState();
});

test("selling detection only triggers on explicit sell offers", () => {
  assert.ok(detectSellingSignal("selling kicia config cheap dm me"));
  assert.ok(detectSellingSignal("selling lvl 888 account"));
  assert.ok(detectSellingSignal("s e l l i n g lvl 888 a c c"));
  assert.ok(detectSellingSignal("s3ll1ng lvl 888 acc"));
  assert.ok(detectSellingSignal("wts lvl 888 acc"));
  assert.equal(detectSellingSignal("anyone selling kicia config?"), null);
  assert.equal(detectSellingSignal("buying lvl 888 account"), null);
  assert.equal(detectSellingSignal("stop selling lvl 888 account"), null);
});

test("suspicious detection catches dm-for-link wording", () => {
  const signal = detectSuspiciousSignal("dm me for the link");
  assert.ok(signal);
  assert.match(signal.reason, /links privately/i);
});

test("fake info guard catches wrong status claims", () => {
  const signal = detectFakeInfoSignal("kicia is down", {
    kb,
    runtimeStatus: "UP"
  });

  assert.ok(signal);
  assert.match(signal.reason, /runtime status is up/i);
});

test("fake info guard catches wrong executor claims conservatively", () => {
  const signal = detectFakeInfoSignal("wave is supported", {
    kb,
    runtimeStatus: "UP"
  });

  assert.ok(signal);
  assert.match(signal.reason, /unsupported/i);
  assert.equal(detectFakeInfoSignal("i think wave is supported", { kb, runtimeStatus: "UP" }), null);
  assert.equal(detectFakeInfoSignal("solar is supported", { kb, runtimeStatus: "UP" }), null);
});

test("staff bypass covers higher permissions", () => {
  const bypass = hasBypassPermission(buildRaidMessage("test", "staff-user", {
    permissions: [PermissionFlagsBits.ManageMessages]
  }));

  assert.equal(bypass, true);
});

test("raid detector alerts on repeated copy-paste by multiple users", () => {
  const content = "join this right now free premium here";
  const now = 1_000;

  assert.equal(observeRaidMessage(buildRaidMessage(content, "u1"), now), null);
  assert.equal(observeRaidMessage(buildRaidMessage(content, "u2"), now + 2_000), null);
  assert.equal(observeRaidMessage(buildRaidMessage(content, "u3"), now + 4_000), null);

  const alert = observeRaidMessage(buildRaidMessage(content, "u4"), now + 6_000);
  assert.ok(alert);
  assert.match(alert.reason, /4 users/i);
});
