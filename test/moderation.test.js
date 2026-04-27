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
  addTrustedLink,
  clearDailyStatsTracking,
  getDailyStatsSnapshot,
  getRestrictedEmojiDatabaseSnapshot,
  listTrustedLinks,
  parseEmojiInput,
  removeRestrictedEmojiByKey,
  removeTrustedLinkByKey,
  resetRestrictedEmojiDatabaseForTests
} = require("../src/restricted-emoji-db");
const {
  detectBlockedLinkSignal,
  detectSellingSignal,
  detectContextualSellingSignal,
  detectSuspiciousSignal,
  detectRoastingSignal,
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
  moderatable = true,
  channelId = "channel-1"
} = {}) {
  const deleted = [];
  const timeouts = [];
  const dms = [];
  const logs = [];
  const replies = [];

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
    channelId,
    url: `https://discord.com/channels/guild-1/${channelId}/message-1`,
    guild,
    author,
    member,
    inGuild: () => true,
    reply: async (payload) => {
      replies.push(payload);
    },
    delete: async () => {
      deleted.push(true);
    }
  };

  return {
    message,
    deleted,
    timeouts,
    dms,
    replies,
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

test("roasting detection catches playful cooking without logging food talk", () => {
  assert.ok(detectRoastingSignal("bro got cooked"));
  assert.ok(detectRoastingSignal("is someone getting roasted rn"));
  assert.ok(detectRoastingSignal("skill issue honestly"));
  assert.ok(detectRoastingSignal("Jesus a bot anyways, hopping from one to another then leaving always the same sht"));
  assert.ok(detectRoastingSignal("npc behavior"));
  assert.equal(detectRoastingSignal("i cooked chicken for dinner"), null);
  assert.equal(detectRoastingSignal("roasted coffee beans"), null);
  assert.equal(detectRoastingSignal("the discord bot is online"), null);
});

test("suspicious detection catches private DM steering while skipping reminders", () => {
  const signal = detectSuspiciousSignal("dm me for the link");
  assert.ok(signal);
  assert.match(signal.reason, /links privately/i);

  const vagueSignal = detectSuspiciousSignal("OK MORE STUFF IS THERE, EXPLAIN: dm me");
  assert.ok(vagueSignal);
  assert.match(vagueSignal.reason, /private messages/i);

  assert.equal(detectSuspiciousSignal("dont dm me"), null);
  assert.equal(detectSuspiciousSignal("disable antivirus before injecting"), null);
  assert.equal(detectSuspiciousSignal("turn off windows defender then open kicia"), null);
});

test("link detection allows docs links and gif links while blocking other files", () => {
  assert.equal(detectBlockedLinkSignal("example.com", { kb }), null);
  assert.equal(detectBlockedLinkSignal("some random word like thing.gg but not a link", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://potassium.pro/download", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://google.com/search?q=kicia", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://docs.google.com/document/d/abc123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://tenor.com/view/cat-123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://cdn.discordapp.com/attachments/1/2/funny-cat.gif", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://example.com/memes/dancing-cat.gif", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://giphy.com/gifs/cat-funny-abc123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://klipy.com/gifs/thragg--k01KQ2G8538QACVGJ0DEHS9DPRX", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://github.com/user/repo/blob/main/script.lua", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://raw.githubusercontent.com/user/repo/main/script.lua", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://gist.githubusercontent.com/user/abc123/raw/script.lua", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://rdd.whatexpsare.online/", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://rdd.weao.xyz/", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://rdd.weao.gg/", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://whatexpsare.online/", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://inject.today", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://inject.today/rdd", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://dynamic.example/file", {
    kb,
    trustedLinks: [{ url: "https://dynamic.example/" }]
  }), null);
  assert.equal(detectBlockedLinkSignal("https://path-only.example/safe", {
    kb,
    trustedLinks: [{ url: "https://path-only.example/safe" }]
  }), null);
  assert.ok(detectBlockedLinkSignal("https://path-only.example/other", {
    kb,
    trustedLinks: [{ url: "https://path-only.example/safe" }]
  }));

  const signal = detectBlockedLinkSignal("check https://bing.com/search?q=kicia", { kb });
  assert.ok(signal);
  assert.equal(signal.blockedCount, 1);
  assert.equal(signal.blockedLinks[0].hostname, "bing.com");
  assert.ok(detectBlockedLinkSignal("gofile.io/d/abc123", { kb }));
  assert.ok(detectBlockedLinkSignal("https://cdn.discordapp.com/attachments/1/2/not-a-gif.png", { kb }));
  assert.ok(detectBlockedLinkSignal("https://klipy.com/videos/not-a-gif", { kb }));
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
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("check this https://bing.com/search?q=kicia now");

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

  const snapshot = await getDailyStatsSnapshot();
  const blockedLinkTimeout = snapshot.moderation.find((entry) => entry.eventKey === "blocked_link_timeout");
  assert.equal(blockedLinkTimeout?.eventCount, 1);
});

test("high-confidence selling mutes and shows confidence in logs", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling ue for 1 bucks", {
    channelId: "1484218577589637233"
  });

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.equal(fixture.replies.length, 1);
  assert.match(fixture.replies[0].content, /(marketplace|selling|price|bazaar|commerce|shop|checkout|salesy|trading)/i);
  assert.doesNotMatch(fixture.replies[0].content, /staff|ping|log/i);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Selling Timeout/i);
  assert.match(fixture.logs[0].body, /Confidence:\*\* \d+%/i);
  assert.match(fixture.logs[0].body, /confidence \d+% > 70%/i);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 15 * 60 * 1000);
  assert.equal(fixture.dms.length, 1);
  assert.match(fixture.dms[0].embeds[0].data.description, /selling\/trading/i);

  const snapshot = await getDailyStatsSnapshot();
  const sellingTimeout = snapshot.moderation.find((entry) => entry.eventKey === "selling_timeout");
  assert.equal(sellingTimeout?.eventCount, 1);
});

test("mid-confidence selling repeats mute on the second hit in 30 minutes", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling");
  const baseNow = 1_000;

  const firstHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: baseNow
  });

  assert.equal(firstHandled, true);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Selling Alert/i);
  assert.match(fixture.logs[0].body, /Confidence:\*\* \d+%/i);
  assert.equal(fixture.timeouts.length, 0);

  fixture.message.id = "message-2";
  fixture.message.content = "selling";
  await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: baseNow + 10 * 60 * 1000
  });

  assert.equal(fixture.logs.length, 2);
  assert.match(fixture.logs[1].header, /Selling Timeout/i);
  assert.match(fixture.logs[1].body, /2\/2 selling messages in 30m/i);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 15 * 60 * 1000);
  assert.equal(fixture.dms.length, 1);
  assert.match(fixture.logs[1].body, /dm sent/i);
});

test("low-confidence selling repeats mute on the third hit in 30 minutes", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("anyone selling ue?");
  const baseNow = 1_000;

  await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: baseNow
  });

  fixture.message.id = "message-2";
  fixture.message.content = "who sell ue";
  await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: baseNow + 10 * 60 * 1000
  });

  assert.equal(fixture.logs.length, 2);
  assert.match(fixture.logs[1].header, /Selling Alert/i);
  assert.match(fixture.logs[1].body, /2\/3 in 30m/i);
  assert.equal(fixture.timeouts.length, 0);

  fixture.message.id = "message-3";
  fixture.message.content = "can i sell ue here";
  await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: baseNow + 20 * 60 * 1000
  });

  assert.equal(fixture.logs.length, 3);
  assert.match(fixture.logs[2].header, /Selling Timeout/i);
  assert.match(fixture.logs[2].body, /3\/3 selling messages in 30m/i);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 15 * 60 * 1000);
  assert.equal(fixture.dms.length, 1);
});

test("roasting detector replies without logs or moderation actions", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("bro got cooked so hard", {
    channelId: "1484218577589637233"
  });

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.equal(fixture.replies.length, 1);
  assert.match(fixture.replies[0].content, /(roast|cooked|kitchen|preheating|cookout|seasoning|heat|flame|crispy)/i);
  assert.equal(fixture.logs.length, 0);
  assert.equal(fixture.dms.length, 0);
  assert.equal(fixture.timeouts.length, 0);
});

test("suspicious messages timeout on the second hit in one hour", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("OK MORE STUFF IS THERE, EXPLAIN: dm me");
  const baseNow = 1_000;

  const firstHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: baseNow
  });

  assert.equal(firstHandled, true);
  assert.equal(fixture.replies.length, 1);
  assert.match(fixture.replies[0].content, /\(1\/2\)$/);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Suspicious Message Alert/i);
  assert.match(fixture.logs[0].body, /log only/i);
  assert.equal(fixture.dms.length, 0);
  assert.equal(fixture.timeouts.length, 0);

  fixture.message.id = "message-2";
  fixture.message.content = "dm me for the script";
  await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: baseNow + 1_000
  });

  assert.equal(fixture.logs.length, 2);
  assert.equal(fixture.replies.length, 2);
  assert.match(fixture.replies[1].content, /\(2\/2\)$/);
  assert.match(fixture.logs[1].header, /Suspicious Message Timeout/i);
  assert.match(fixture.logs[1].body, /2 in 1h/i);
  assert.equal(fixture.dms.length, 1);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 10 * 60 * 1000);

  const snapshot = await getDailyStatsSnapshot();
  const byKey = new Map(snapshot.moderation.map((entry) => [entry.eventKey, entry.eventCount]));
  assert.equal(byKey.get("suspicious_alert"), 1);
  assert.equal(byKey.get("suspicious_timeout"), 1);
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

test("trusted link database adds and removes links", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);

  const added = await addTrustedLink({
    key: "trusted.example/safe",
    url: "https://trusted.example/safe"
  });
  assert.equal(added.added, true);

  const linksAfterAdd = await listTrustedLinks();
  assert.equal(linksAfterAdd.length, 1);
  assert.equal(linksAfterAdd[0].url, "https://trusted.example/safe");

  const removed = await removeTrustedLinkByKey("trusted.example/safe");
  assert.equal(removed.removed, true);

  const linksAfterRemove = await listTrustedLinks();
  assert.equal(linksAfterRemove.length, 0);
});

test("restricted reactions on staff messages remove the reaction and time out the user", async () => {
  await clearDailyStatsTracking(1);
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

  const snapshot = await getDailyStatsSnapshot();
  const reactionTimeout = snapshot.moderation.find((entry) => entry.eventKey === "restricted_reaction_timeout");
  assert.equal(reactionTimeout?.eventCount, 1);
});
