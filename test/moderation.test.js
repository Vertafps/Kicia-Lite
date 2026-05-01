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
  addModerationWhitelistedUser,
  addTrustedLink,
  clearScamDecisionAuditForTests,
  clearDailyStatsTracking,
  getDailyStatsSnapshot,
  getRestrictedEmojiDatabaseSnapshot,
  isModerationWhitelistedUser,
  listScamDecisionAudit,
  listModerationWhitelistedUsers,
  listTrustedLinks,
  parseEmojiInput,
  removeModerationWhitelistedUser,
  removeRestrictedEmojiByKey,
  removeTrustedLinkByKey,
  resetRestrictedEmojiDatabaseForTests
} = require("../src/restricted-emoji-db");
const {
  detectBlockedLinkSignal,
  detectSellingSignal,
  detectContextualSellingSignal,
  detectScamTradeCandidateContext,
  detectSuspiciousSignal,
  detectRoastingSignal,
  detectFakeInfoSignal,
  hasBypassPermission,
  maybeHandleModerationWatch,
  observeRaidMessage,
  resetModerationState
} = require("../src/handlers/moderation");
const { maybeHandleRestrictedReactionAdd } = require("../src/handlers/restricted-reactions");
const {
  classifyScamContextLocally,
  getExplanationResponseIntent,
  isKiciaLegitPurchaseIntent,
  isSafeSecurityDisableSupport
} = require("../src/scam-local-classifier");

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
  channelId = "channel-1",
  createdTimestamp = 0,
  joinedTimestamp = 0,
  referencedContent = null
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
    joinedTimestamp,
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
    createdTimestamp,
    send: async (payload) => {
      dms.push(payload);
    }
  };
  const referencedMessage = referencedContent
    ? {
        content: referencedContent,
        author: {
          id: "other-user",
          username: "otheruser"
        },
        member: {
          displayName: "Other User"
        }
      }
    : null;

  const message = {
    id: "message-1",
    content,
    guildId: "guild-1",
    channelId,
    url: `https://discord.com/channels/guild-1/${channelId}/message-1`,
    guild,
    author,
    member,
    reference: referencedMessage ? { messageId: "referenced-message" } : null,
    inGuild: () => true,
    fetchReference: referencedMessage ? async () => referencedMessage : undefined,
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
  assert.ok(detectSellingSignal("buying lvl 888 account for 2 usd"));
  assert.ok(detectSellingSignal("trading kicia config for robux"));
  assert.ok(detectSellingSignal("selling ue for 1 bucks"));
  assert.ok(detectSellingSignal("selling ue for 2 dollars"));
  assert.ok(detectSellingSignal("selling ue for 1 usd"));
  assert.ok(detectSellingSignal("s e l l i n g lvl 888 a c c"));
  assert.ok(detectSellingSignal("s3ll1ng lvl 888 acc"));
  assert.ok(detectSellingSignal("wts lvl 888 acc"));
  assert.equal(detectSellingSignal("selling"), null);
  assert.equal(detectSellingSignal("trading"), null);
  assert.equal(detectSellingSignal("buying"), null);
  assert.equal(detectSellingSignal("selling ue"), null);
  assert.equal(detectSellingSignal("anyone selling ue?"), null);
  assert.equal(detectSellingSignal("who sell ue"), null);
  assert.equal(detectSellingSignal("can i sell ue here"), null);
  assert.equal(detectSellingSignal("anyone selling kicia config?"), null);
  assert.equal(detectSellingSignal("buying kicia"), null);
  assert.equal(detectSellingSignal("how to buy kicia"), null);
  assert.equal(detectSellingSignal("where do i buy kicia premium"), null);
  assert.equal(detectSellingSignal("trusted reseller"), null);
  assert.equal(detectSellingSignal("official reseller only"), null);
  assert.equal(detectSellingSignal("stop selling lvl 888 account"), null);
  assert.equal(detectSellingSignal("dont sell ue here"), null);
  assert.equal(detectSellingSignal("selling is against rules"), null);
});

test("local scam classifier protects official Kicia purchase questions", () => {
  assert.equal(isKiciaLegitPurchaseIntent(["buying kicia"]), true);
  assert.equal(isKiciaLegitPurchaseIntent(["where can i buy kicia premium"]), true);
  assert.equal(isKiciaLegitPurchaseIntent(["buy kicia from me cheaper"]), false);
  assert.equal(detectScamTradeCandidateContext(["where can i buy kicia premium"]), null);

  const legitVerdict = classifyScamContextLocally({
    userMessages: ["where can i buy kicia premium"]
  });
  assert.equal(legitVerdict.verdict, false);
  assert.ok(legitVerdict.confidence >= 90);

  const resellerVerdict = classifyScamContextLocally({
    userMessages: ["buy kicia from me cheaper dm"]
  }, {
    strongestSignal: { confidence: 86 }
  });
  assert.equal(resellerVerdict.verdict, true);
});

test("local scam classifier follows KiciaHook safe and unsafe standards", () => {
  assert.equal(isSafeSecurityDisableSupport(["disable windows defender for executor"]), true);
  assert.equal(detectScamTradeCandidateContext(["disable antivirus for executor"]), null);

  assert.equal(classifyScamContextLocally({
    userMessages: ["disable antivirus for executor"]
  }).verdict, false);

  assert.equal(classifyScamContextLocally({
    userMessages: ["dms to buy kicia"]
  }).verdict, true);

  assert.equal(classifyScamContextLocally({
    userMessages: ["dms to buy this"]
  }).verdict, true);

  const ambiguousBarter = classifyScamContextLocally({
    userMessages: ["trading this for that"]
  });
  assert.equal(ambiguousBarter.verdict, null);
  assert.match(ambiguousBarter.reason, /remote AI/i);

  assert.equal(classifyScamContextLocally({
    userMessages: ["someone said dms to buy kicia is that allowed"]
  }).verdict, false);
});

test("local scam classifier separates explanations from private purchase handoffs", () => {
  const purchaseQuestion = { content: "how to buy?" };
  const kiciaPurchaseQuestion = { content: "where can i buy kicia premium?" };

  const routeAnswer = getExplanationResponseIntent(["oh buy in the resellers"], purchaseQuestion);
  assert.equal(routeAnswer.verdict, false);
  assert.match(routeAnswer.reason, /official purchase/i);
  assert.equal(detectScamTradeCandidateContext(["oh buy in the resellers"], purchaseQuestion), null);

  assert.equal(classifyScamContextLocally({
    userMessages: ["open a ticket"],
    repliedToMessage: kiciaPurchaseQuestion
  }).verdict, false);

  const privateAnswer = getExplanationResponseIntent(["dms"], kiciaPurchaseQuestion);
  assert.equal(privateAnswer.verdict, true);

  assert.equal(classifyScamContextLocally({
    userMessages: ["dm me"],
    repliedToMessage: kiciaPurchaseQuestion
  }).verdict, true);
});

test("contextual selling detection catches split sell and price messages", () => {
  const signal = detectContextualSellingSignal([
    "selling ue",
    "1 buck"
  ]);

  assert.ok(signal);
  assert.match(signal.reason, /recent messages/i);
  assert.ok(detectScamTradeCandidateContext(["selling", "configs"]));
  assert.ok(detectScamTradeCandidateContext(["trading this u want??"]));
  assert.ok(detectScamTradeCandidateContext(["dms"], {
    content: "where is executor link"
  }));
  assert.equal(detectScamTradeCandidateContext(["selling"]), null);
  assert.equal(detectScamTradeCandidateContext(["selling", "trading", "buying"]), null);
  assert.equal(detectContextualSellingSignal(["selling is against rules", "1 buck"]), null);
  assert.ok(detectContextualSellingSignal(["anyone selling ue?", "1 buck"]));
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
  assert.ok(signal.confidence > 90);

  const vagueSignal = detectSuspiciousSignal("OK MORE STUFF IS THERE, EXPLAIN: dm me");
  assert.ok(vagueSignal);
  assert.match(vagueSignal.reason, /private messages/i);
  assert.ok(vagueSignal.confidence < 90);

  assert.equal(detectSuspiciousSignal("dm me"), null);
  assert.equal(detectSuspiciousSignal("dont dm me"), null);
  assert.match(detectSuspiciousSignal("I accidentally reported your account, contact me to appeal").reason, /account scam/i);
  assert.equal(detectSuspiciousSignal("disable windows defender before opening it"), null);
  assert.equal(detectSuspiciousSignal("avoid the accidental report scam"), null);
});

test("link detection allows docs/common links while escalating risky links", () => {
  assert.equal(detectBlockedLinkSignal("example.com", { kb }), null);
  assert.equal(detectBlockedLinkSignal("some random word like thing.gg but not a link", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://potassium.pro/download", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://google.com/search?q=kicia", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://docs.google.com/document/d/abc123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://youtube.com/watch?v=abc123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://www.youtube.com/shorts/abc123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://m.youtube.com/watch?v=abc123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://music.youtube.com/watch?v=abc123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://youtu.be/abc123", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://www.youtube-nocookie.com/embed/abc123", { kb }), null);
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
  assert.equal(detectBlockedLinkSignal("https://rivalscheats.shop", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://rivalscheats.shop/safe/path?x=1", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://www.rivalscheats.shop/another/path", { kb }), null);
  assert.equal(detectBlockedLinkSignal("https://dynamic.example/file", {
    kb,
    trustedLinks: [{ url: "https://dynamic.example/" }]
  }), null);
  assert.equal(detectBlockedLinkSignal("https://path-only.example/safe", {
    kb,
    trustedLinks: [{ url: "https://path-only.example/safe" }]
  }), null);
  assert.equal(detectBlockedLinkSignal("https://path-only.example/other", {
    kb,
    trustedLinks: [{ url: "https://path-only.example/safe" }]
  }), null);
  assert.equal(detectBlockedLinkSignal("check https://bing.com/search?q=kicia", { kb }), null);

  const gofileSignal = detectBlockedLinkSignal("gofile.io/d/abc123", { kb });
  assert.ok(gofileSignal);
  assert.equal(gofileSignal.action, "timeout");
  assert.match(gofileSignal.reason, /file-sharing/i);

  const megaSignal = detectBlockedLinkSignal("mega dot nz slash file/abc123", { kb });
  assert.ok(megaSignal);
  assert.equal(megaSignal.action, "timeout");

  const homoglyphSignal = detectBlockedLinkSignal("https://d\u0456scord.com/gift/free", { kb });
  assert.ok(homoglyphSignal);
  assert.equal(homoglyphSignal.action, "timeout");
  assert.match(homoglyphSignal.reason, /discord\.com/i);

  const embeddedBrandSignal = detectBlockedLinkSignal("https://discord.com.evil.example/login", { kb });
  assert.ok(embeddedBrandSignal);
  assert.equal(embeddedBrandSignal.action, "timeout");
  assert.match(embeddedBrandSignal.reason, /embeds discord\.com/i);

  const maskedSignal = detectBlockedLinkSignal("[https://discord.com](https://evil.example/login)", { kb });
  assert.ok(maskedSignal);
  assert.equal(maskedSignal.action, "timeout");
  assert.match(maskedSignal.reason, /masked link/i);

  const shortenerSignal = detectBlockedLinkSignal("https://bit.ly/abc123", { kb });
  assert.ok(shortenerSignal);
  assert.equal(shortenerSignal.action, "warn");

  const exeSignal = detectBlockedLinkSignal("https://cdn.discordapp.com/attachments/1/2/update.exe", { kb });
  assert.ok(exeSignal);
  assert.equal(exeSignal.action, "timeout");
});

test("fake info guard catches wrong status claims", () => {
  const signal = detectFakeInfoSignal("kicia is down", {
    kb,
    runtimeStatus: "UP"
  });

  assert.ok(signal);
  assert.match(signal.reason, /runtime status is up/i);
});

test("fake info guard replies publicly without moderation action", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("kicia is down");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.equal(fixture.logs.length, 1);
  assert.equal(fixture.replies.length, 1);
  assert.match(fixture.replies[0].content, /## False info bro!/);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.dms.length, 0);
  assert.equal(fixture.deleted.length, 0);
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
  const fixture = buildModerationMessage("check this https://mega.nz/file/abc123 now");

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
  assert.match(fixture.logs[0].body, /file-sharing host is blocked/i);

  const snapshot = await getDailyStatsSnapshot();
  const blockedLinkTimeout = snapshot.moderation.find((entry) => entry.eventKey === "blocked_link_timeout");
  assert.equal(blockedLinkTimeout?.eventCount, 1);
});

test("new account link scrutiny warns without escalating to timeout by itself", async () => {
  await clearDailyStatsTracking(1);
  const now = 2_000_000_000_000;
  const safeFixture = buildModerationMessage("check https://github.com/user/repo", {
    createdTimestamp: now - 24 * 60 * 60 * 1000,
    joinedTimestamp: now - 60 * 60 * 1000
  });

  const safeHandled = await maybeHandleModerationWatch(safeFixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: safeFixture.sendLog,
    now
  });
  assert.equal(safeHandled, false);
  assert.equal(safeFixture.deleted.length, 0);
  assert.equal(safeFixture.logs.length, 0);

  const suspiciousFixture = buildModerationMessage("verify your account here https://unknown-verify.example/login", {
    createdTimestamp: now - 24 * 60 * 60 * 1000,
    joinedTimestamp: now - 60 * 60 * 1000
  });

  const suspiciousHandled = await maybeHandleModerationWatch(suspiciousFixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: suspiciousFixture.sendLog,
    now
  });

  assert.equal(suspiciousHandled, true);
  assert.equal(suspiciousFixture.deleted.length, 1);
  assert.equal(suspiciousFixture.timeouts.length, 0);
  assert.equal(suspiciousFixture.dms.length, 1);
  assert.match(suspiciousFixture.logs[0].header, /Blocked Link Warning/i);
  assert.match(suspiciousFixture.logs[0].body, /new account|recent server join/i);
});

test("single scam-market words do not trigger without context", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling");
  let aiCalls = 0;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test" };
    }
  });

  assert.equal(handled, false);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.replies.length, 0);
  assert.equal(fixture.logs.length, 0);
  assert.equal(fixture.timeouts.length, 0);
});

test("official Kicia purchase questions do not call scam AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("where can i buy kicia premium?");
  let aiCalls = 0;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    }
  });

  assert.equal(handled, false);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 0);
  assert.equal(fixture.replies.length, 0);
  assert.equal(fixture.timeouts.length, 0);
});

test("antivirus support wording does not call scam AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("disable windows defender for executor");
  let aiCalls = 0;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    }
  });

  assert.equal(handled, false);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 0);
  assert.equal(fixture.replies.length, 0);
  assert.equal(fixture.timeouts.length, 0);
});

test("purchase-route explanation replies do not create scam alerts", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("oh buy in the resellers", {
    referencedContent: "how to buy?"
  });
  let aiCalls = 0;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    }
  });

  assert.equal(handled, false);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 0);
  assert.equal(fixture.replies.length, 0);
  assert.equal(fixture.timeouts.length, 0);
});

test("private DM answer to purchase question is caught locally", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("dms", {
    referencedContent: "where can i buy kicia premium?"
  });
  let aiCalls = 0;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" };
    }
  });

  assert.equal(handled, true);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].body, /Private handoff answer to a purchase question/i);
  assert.equal(fixture.replies.length, 1);
});

test("private Kicia buying handoff is caught without remote AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("dms to buy kicia");
  let aiCalls = 0;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" };
    }
  });

  assert.equal(handled, true);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].body, /local-kicia-intent-v2: TRUE/i);
  assert.equal(fixture.replies.length, 1);
});

test("scam classifier decisions are written to the audit table", async () => {
  await clearDailyStatsTracking(1);
  await clearScamDecisionAuditForTests();
  const fixture = buildModerationMessage("dms to buy kicia");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      throw new Error("remote AI should not be called");
    },
    now: 1_700_000_000_000
  });

  assert.equal(handled, true);
  const audit = await listScamDecisionAudit({ limit: 5 });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "local_true");
  assert.equal(audit[0].handled, true);
  assert.equal(audit[0].userId, fixture.message.author.id);
  assert.equal(audit[0].local.verdict, true);
  assert.equal(audit[0].local.model, "local-kicia-intent-v2");
  assert.match(audit[0].candidate.reason, /sale context|private buy\/sell handoff/i);
  assert.equal(audit[0].messageContent, "dms to buy kicia");

  const snapshot = await getRestrictedEmojiDatabaseSnapshot();
  assert.equal(snapshot.tableCounts.scamDecisionAudit, 1);
});

test("generic barter wording becomes AI-borderline instead of automatic action", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("trading this for that");
  let capturedContext = null;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async (context) => {
      capturedContext = context;
      return { attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" };
    }
  });

  assert.equal(handled, false);
  assert.deepEqual(capturedContext.userMessages, ["trading this for that"]);
  assert.equal(fixture.replies.length, 0);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Scam AI Cleared/i);
});

test("concrete barter with protected items is caught locally", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("giving kicia key for account");
  let aiCalls = 0;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" };
    }
  });

  assert.equal(handled, true);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].body, /Concrete protected-item barter/i);
  assert.equal(fixture.replies.length, 1);
});

test("local classifier confirms obvious split selling context before remote AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling");
  let aiCalls = 0;
  const classifyScam = async () => {
    aiCalls += 1;
    return { attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" };
  };

  const firstHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam,
    now: 1_000
  });
  assert.equal(firstHandled, false);

  fixture.message.id = "message-2";
  fixture.message.content = "configs";
  const secondHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam,
    now: 2_000
  });

  assert.equal(secondHandled, true);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.replies.length, 1);
  assert.match(fixture.logs[0].body, /AI Scam Verdict/i);
  assert.match(fixture.logs[0].body, /local-kicia-intent-v2: TRUE/i);
});

test("AI scam classifier uses replied-to message context", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("dms", {
    referencedContent: "where is executor link"
  });
  let capturedContext = null;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async (context) => {
      capturedContext = context;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    }
  });

  assert.equal(handled, true);
  assert.equal(capturedContext.repliedToMessage.content, "where is executor link");
  assert.match(fixture.logs[0].body, /private DM handoff/i);
  assert.match(fixture.logs[0].body, /test-gemini: TRUE/i);
});

test("AI scam classifier can clear ambiguous market questions", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("anyone selling kicia config?");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => ({ attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" })
  });

  assert.equal(handled, false);
  assert.equal(fixture.replies.length, 0);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Scam AI Cleared/i);
  assert.match(fixture.logs[0].body, /AI Answer:\*\* FALSE/i);
});

test("high-confidence scam/trade mutes and shows confidence in logs", async () => {
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
  assert.match(fixture.replies[0].content, /(scam|trade|trading|deal|risk|checkout|pitch|slick|unsafe|private|floor)/i);
  assert.doesNotMatch(fixture.replies[0].content, /staff|ping|log/i);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Scam\/Trade Timeout/i);
  assert.match(fixture.logs[0].body, /Confidence:\*\* \d+%/i);
  assert.match(fixture.logs[0].body, /confidence \d+% > 70%/i);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 15 * 60 * 1000);
  assert.equal(fixture.dms.length, 1);
  assert.match(fixture.dms[0].embeds[0].data.description, /scam\/trade behavior/i);

  const snapshot = await getDailyStatsSnapshot();
  const sellingTimeout = snapshot.moderation.find((entry) => entry.eventKey === "selling_timeout");
  assert.equal(sellingTimeout?.eventCount, 1);
});

test("repeated bare scam-market words stay quiet without context", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling");
  const baseNow = 1_000;
  let aiCalls = 0;

  const firstHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    },
    now: baseNow
  });

  assert.equal(firstHandled, false);

  fixture.message.id = "message-2";
  fixture.message.content = "trading";
  const secondHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    },
    now: baseNow + 10 * 60 * 1000
  });

  fixture.message.id = "message-3";
  fixture.message.content = "buying";
  const thirdHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    },
    now: baseNow + 20 * 60 * 1000
  });

  assert.equal(secondHandled, false);
  assert.equal(thirdHandled, false);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 0);
  assert.equal(fixture.replies.length, 0);
  assert.equal(fixture.timeouts.length, 0);
});

test("AI-cleared repeated scam/trade questions do not punish users", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("anyone selling kicia config?");
  const baseNow = 1_000;
  let aiCalls = 0;
  const classifyScam = async () => {
    aiCalls += 1;
    return { attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" };
  };

  const firstHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam,
    now: baseNow
  });

  fixture.message.id = "message-2";
  fixture.message.content = "where can i buy configs?";
  const secondHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam,
    now: baseNow + 10 * 60 * 1000
  });

  fixture.message.id = "message-3";
  fixture.message.content = "can i trade kicia config here?";
  const thirdHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam,
    now: baseNow + 20 * 60 * 1000
  });

  assert.equal(firstHandled, false);
  assert.equal(secondHandled, false);
  assert.equal(thirdHandled, false);
  assert.equal(aiCalls, 3);
  assert.equal(fixture.logs.length, 3);
  assert.ok(fixture.logs.every((entry) => /Scam AI Cleared/i.test(entry.header)));
  assert.equal(fixture.replies.length, 0);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.dms.length, 0);
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
  fixture.message.content = "extra files dm me";
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

test("high-confidence suspicious messages timeout for one hour immediately", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("dm me for the script");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.equal(fixture.replies.length, 1);
  assert.match(fixture.replies[0].content, /\(2\/2\)$/);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Suspicious Message Timeout/i);
  assert.match(fixture.logs[0].body, /Confidence:\*\* 93%/i);
  assert.match(fixture.logs[0].body, /confidence 93% > 90%/i);
  assert.equal(fixture.dms.length, 1);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 60 * 60 * 1000);
  assert.match(fixture.timeouts[0].reason, /high-confidence suspicious/i);
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

test("manual moderation whitelist persists and skips message guards", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);

  const added = await addModerationWhitelistedUser("123456789012345678", {
    createdBy: "847703912932311091"
  });
  assert.equal(added.added, true);
  assert.equal(await isModerationWhitelistedUser("123456789012345678"), true);

  const usersAfterAdd = await listModerationWhitelistedUsers();
  assert.equal(usersAfterAdd.length, 1);
  assert.equal(usersAfterAdd[0].createdBy, "847703912932311091");

  const fixture = buildModerationMessage("dm me for the script https://mega.nz/file/abc123", {
    userId: "123456789012345678"
  });
  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog
  });

  assert.equal(handled, false);
  assert.equal(fixture.deleted.length, 0);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.logs.length, 0);

  const removed = await removeModerationWhitelistedUser("123456789012345678");
  assert.equal(removed.removed, true);
  assert.equal(await isModerationWhitelistedUser("123456789012345678"), false);
});

test("restricted reactions on staff messages remove the reaction and DM warn the user", async () => {
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
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.deepEqual(fixture.removedUsers, ["regular-user"]);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.dms.length, 1);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Restricted Reaction Warning/i);

  const snapshot = await getDailyStatsSnapshot();
  const reactionAlert = snapshot.moderation.find((entry) => entry.eventKey === "restricted_reaction_alert");
  assert.equal(reactionAlert?.eventCount, 1);
});
