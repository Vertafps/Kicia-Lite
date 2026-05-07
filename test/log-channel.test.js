process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resetChannelConfigCache,
  setCachedChannelSlot
} = require("../src/channel-config");
const {
  sendIgnoreLogPanel
} = require("../src/log-channel");

function buildGuildWithLogChannels() {
  const sent = {
    main: [],
    ignore: []
  };
  const main = {
    id: "1497949003617140858",
    send: async (payload) => {
      sent.main.push(payload);
    }
  };
  const ignore = {
    id: "222222222222222222",
    send: async (payload) => {
      sent.ignore.push(payload);
    }
  };
  const channels = new Map([
    [main.id, main],
    [ignore.id, ignore]
  ]);

  return {
    sent,
    guild: {
      channels: {
        cache: channels,
        fetch: async (id) => channels.get(id) || null
      }
    }
  };
}

test("ignore log panels use the configured ignorelogs channel", async () => {
  resetChannelConfigCache();
  try {
    setCachedChannelSlot("ignorelogs", "222222222222222222");
    const { guild, sent } = buildGuildWithLogChannels();

    const delivered = await sendIgnoreLogPanel(guild, {
      header: "Scam AI Cleared",
      body: "cleared candidate"
    });

    assert.equal(delivered, true);
    assert.equal(sent.ignore.length, 1);
    assert.equal(sent.main.length, 0);
  } finally {
    resetChannelConfigCache();
  }
});

test("ignore log panels fall back to main logs until ignorelogs is configured", async () => {
  resetChannelConfigCache();
  try {
    const { guild, sent } = buildGuildWithLogChannels();

    const delivered = await sendIgnoreLogPanel(guild, {
      header: "Scam AI Cleared",
      body: "cleared candidate"
    });

    assert.equal(delivered, true);
    assert.equal(sent.ignore.length, 0);
    assert.equal(sent.main.length, 1);
  } finally {
    resetChannelConfigCache();
  }
});
