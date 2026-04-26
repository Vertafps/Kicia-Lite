process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");
const os = require("os");
const path = require("path");

const { normalizeKb } = require("../src/kb");
const {
  addRestrictedEmoji,
  getRestrictedEmojiDatabaseSnapshot,
  parseEmojiInput,
  removeRestrictedEmojiByKey,
  resetRestrictedEmojiDatabaseForTests
} = require("../src/restricted-emoji-db");
const {
  detectBlockedLinkSignal,
  detectSellingSignal,
  detectContextualSellingSignal,
  detectSuspiciousSignal,
  detectFakeInfoSignal,
  hasBypassPermission,
  maybeHandleModerationWatch,
  observeRaidMessage,
  resetModerationState
} = require("../src/handlers/moderation");
const { maybeHandleRestrictedReactionAdd } = require("../src/handlers/restricted-reactions");

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

const testDbPath = path.join(os.tmpdir(), `kicialite-test-${process.pid}-restricted.sqlite`);

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

function buildModerationMessage(content, {
  userId = "regular-user",
  roleIds = [],
  permissions = [],
  moderatable = true
} = {}) {
  const deleted = [];
  const timeouts = [];
  const dms = [];
  const logs = [];

  const member = {
    id: userId,
    displayName: "Regular User",
    roles: {
      cache: {
        has: (roleId) => roleIds.includes(roleId)
      }
    },
    permissions: new PermissionsBitField(permissions),
    moderatable,
    timeout: async (durationMs, reason) => {
      timeouts.push({ durationMs, reason });
    }
  };

  const guild = {
    channels: {
      cache: new Map(),
      fetch: async () => null
    },
    members: {
      cache: {
        get: (id) => (id === userId ? member : null)
      },
      fetch: async (id) => (id === userId ? member : null)
    }
  };

  const author = {
    id: userId,
    bot: false,
    username: "regularuser",
    send: async (payload) => {
      dms.push(payload);
    }
  };

  const message = {
    id: "message-1",
    content,
    guildId: "guild-1",
    channelId: "channel-1",
    url: "https://discord.com/channels/guild-1/channel-1/message-1",
    guild,
    author,
    member,
    inGuild: () => true,
    delete: async () => {
      deleted.push(true);
    }
  };

  return {
    message,
    deleted,
    timeouts,
    dms,
    logs,
    sendLog: async (_guild, panel) => {
      logs.push(panel);
      return true;
    }
  };
}

function buildRestrictedReactionFixture({
  targetRoleIds = ["1298767464678559794"],
  reactingRoleIds = [],
  reactingPermissions = []
} = {}) {
  const removedUsers = [];
  const timeouts = [];
  const dms = [];
  const logs = [];

  const targetMember = {
    id: "staff-target-user",
    roles: {
      cache: {
        has: (roleId) => targetRoleIds.includes(roleId)
      }
    }
  };

  const reactingMember = {
    id: "regular-user",
    roles: {
      cache: {
        has: (roleId) => reactingRoleIds.includes(roleId)
      }
    },
    permissions: new PermissionsBitField(reactingPermissions),
    moderatable: true,
    timeout: async (durationMs, reason) => {
      timeouts.push({ durationMs, reason });
    }
  };

  const memberMap = new Map([
    [targetMember.id, targetMember],
    [reactingMember.id, reactingMember]
  ]);

  const guild = {
    members: {
      cache: {
        get: (id) => memberMap.get(id) || null
      },
      fetch: async (id) => memberMap.get(id) || null
    }
  };

  const reaction = {
    partial: false,
    emoji: {
      id: null,
      name: "\u{1F62D}",
      animated: false
    },
    users: {
      remove: async (userId) => {
        removedUsers.push(userId);
      }
    },
    message: {
      id: "message-1",
      guildId: "guild-1",
      channelId: "channel-1",
      url: "https://discord.com/channels/guild-1/channel-1/message-1",
      guild,
      partial: false,
      author: {
        id: targetMember.id,
        bot: false
      },
      member: targetMember
    }
  };

  const user = {
    id: reactingMember.id,
    bot: false,
    send: async (payload) => {
      dms.push(payload);
    }
  };

  return {
    reaction,
    user,
    removedUsers,
    timeouts,
    dms,
    logs,
    sendLog: async (_guild, panel) => {
      logs.push(panel);
      return true;
    }
  };
}

test.afterEach(() => {
  resetModerationState();
});

test.before(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
});

test.after(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
});

test("selling detection flags broad sell wording while skipping anti-sell reminders", () => {
  assert.ok(detectSellingSignal("selling kicia config cheap dm me"));
  assert.ok(detectSellingSignal("selling lvl 888 account"));
  assert.ok(detectSellingSignal("selling ue"));
  assert.ok(detectSellingSignal("anyone selling ue?"));
  assert.ok(detectSellingSignal("who sell ue"));
  assert.ok(detectSellingSignal("can i sell ue here"));
  assert.ok(detectSellingSignal("selling ue for 1 bucks"));
  assert.ok(detectSellingSignal("selling ue for 2 dollars"));
  assert.ok(detectSellingSignal("selling ue for 1 usd"));
  assert.ok(detectSellingSignal("s e l l i n g lvl 888 a c c"));
  assert.ok(detectSellingSignal("s3ll1ng lvl 888 acc"));
  assert.ok(detectSellingSignal("wts lvl 888 acc"));
  assert.ok(detectSellingSignal("anyone selling kicia config?"));
  assert.equal(detectSellingSignal("trusted reseller"), null);
  assert.equal(detectSellingSignal("official reseller only"), null);
  assert.equal(detectSellingSignal("buying lvl 888 account"), null);
  assert.equal(detectSellingSignal("stop selling lvl 888 account"), null);
  assert.equal(detectSellingSignal("dont sell ue here"), null);
  assert.equal(detectSellingSignal("selling is against rules"), null);
});

test("contextual selling detection catches split sell and price messages", () => {
  const signal = detectContextualSellingSignal([
    "selling ue",
    "1 buck"
  ]);

  assert.ok(signal);
  assert.match(signal.reason, /recent messages/i);
  assert.equal(detectContextualSellingSignal(["selling is against rules", "1 buck"]), null);
  assert.equal(detectContextualSellingSignal(["anyone selling ue?", "1 buck"]), null);
});

test("suspicious detection catches dm-for-link wording", () => {
  const signal = detectSuspiciousSignal("dm me for the link");
  assert.ok(signal);
  assert.match(signal.reason, /links privately/i);
});

test("link detection allows docs-listed links and tenor while blocking others", () => {
  assert.equal(detectBlockedLinkSignal("https://potassium.pro/download", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://tenor.com/view/cat-123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://cdn.discordapp.com/attachments/1/2/funny-cat.gif", { kb }), null);

  const signal = detectBlockedLinkSignal("check https://google.com", { kb });
  assert.ok(signal);
  assert.equal(signal.blockedCount, 1);
  assert.equal(signal.blockedLinks[0].hostname, "google.com");
  assert.ok(detectBlockedLinkSignal("https://cdn.discordapp.com/attachments/1/2/not-a-gif.png", { kb }));
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

test("blocked links are deleted, logged, and timed out", async () => {
  const fixture = buildModerationMessage("check this https://google.com now");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 60 * 1000);
  assert.equal(fixture.dms.length, 1);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Blocked Link Timeout/i);
});

test("restricted emoji database adds and removes emojis", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
  const cryingEmoji = parseEmojiInput("\u{1F62D}");
  assert.ok(cryingEmoji);

  const added = await addRestrictedEmoji(cryingEmoji);
  assert.equal(added.added, true);

  const snapshotAfterAdd = await getRestrictedEmojiDatabaseSnapshot();
  assert.equal(snapshotAfterAdd.tableCounts.restrictedEmojis, 1);
  assert.equal(snapshotAfterAdd.emojis[0].display, "\u{1F62D}");

  const removed = await removeRestrictedEmojiByKey(cryingEmoji.key);
  assert.equal(removed.removed, true);

  const snapshotAfterRemove = await getRestrictedEmojiDatabaseSnapshot();
  assert.equal(snapshotAfterRemove.tableCounts.restrictedEmojis, 0);
});

test("restricted reactions on staff messages remove the reaction and time out the user", async () => {
  const fixture = buildRestrictedReactionFixture();

  const handled = await maybeHandleRestrictedReactionAdd(fixture.reaction, fixture.user, {
    listEmojis: async () => [
      {
        key: "unicode:\u{1F62D}",
        type: "unicode",
        display: "\u{1F62D}",
        name: "\u{1F62D}",
        id: null,
        animated: false
      }
    ],
    getTimeout: async () => 15 * 60 * 1000,
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.deepEqual(fixture.removedUsers, ["regular-user"]);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 15 * 60 * 1000);
  assert.equal(fixture.dms.length, 1);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Restricted Reaction Timeout/i);
});
