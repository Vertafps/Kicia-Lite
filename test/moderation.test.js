process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");
const os = require("os");
const path = require("path");

const { MODLOG_REVERT_PREFIX, MODLOG_VIEW_PREFIX } = require("../src/components");
const { normalizeKb } = require("../src/kb");
const {
  addNicknamePattern,
  addRestrictedEmoji,
  addModerationWhitelistedUser,
  addTrustedLink,
  clearScamDecisionAuditForTests,
  clearDailyStatsTracking,
  getBotPresenceState,
  getDailyStatsSnapshot,
  getModerationAction,
  getRestrictedEmojiDatabaseSnapshot,
  isModerationWhitelistedUser,
  listScamDecisionAudit,
  listModerationWhitelistedUsers,
  listTrustedLinks,
  listNicknamePatterns,
  listChannelSettings,
  parseEmojiInput,
  removeNicknamePatternById,
  removeModerationWhitelistedUser,
  removeRestrictedEmojiByKey,
  removeTrustedLinkByKey,
  listContentFilterRules,
  addContentFilterRule,
  removeContentFilterRuleById,
  cleanupExpiredModerationActions,
  resetBotPresenceState,
  resetChannelSetting,
  setBotPresenceState,
  setChannelSetting,
  hydrateChannelSettings,
  resetRestrictedEmojiDatabaseForTests
} = require("../src/restricted-emoji-db");
const { getConfiguredChannelId, resetChannelConfigCache } = require("../src/channel-config");
const {
  detectBlockedLinkSignalAsync,
  extractUrlsFromText,
  refreshScamPulseFeeds,
  resetScamPulseFeedsForTests
} = require("../src/link-policy");
const {
  detectBlockedLinkSignal,
  detectSellingSignal,
  detectContextualSellingSignal,
  detectProhibitedCommerceSignal,
  detectScamTradeCandidateContext,
  detectSuspiciousSignal,
  detectRoastingSignal,
  detectFakeInfoSignal,
  getSellingConfidenceTimeoutMs,
  getSellingConfidenceTimeoutTier,
  hasBypassPermission,
  maybeHandleModerationLogInteraction,
  maybeHandleModerationWatch,
  observeRaidMessage,
  resetModerationState
} = require("../src/handlers/moderation");
const {
  findNicknameMatch,
  maybeEnforceNicknameMember
} = require("../src/handlers/nickname-mod");
const {
  findImpersonationMatch,
  normalizeHomoglyphs
} = require("../src/handlers/impersonation");
const { maybeHandleRestrictedReactionAdd } = require("../src/handlers/restricted-reactions");
const {
  classifyScamContextLocally,
  getExplanationResponseIntent,
  isKiciaLegitPurchaseIntent,
  isSafePurchaseMethodQuestion,
  isSafeSecurityDisableSupport
} = require("../src/scam-local-classifier");
const {
  DEFAULT_NICKNAME_RENAME_SENTINEL,
  buildDefaultBadName
} = require("../src/nickname-policy");
const {
  detectContentFilterSignal
} = require("../src/content-filter");
const {
  buildNormalizedTextForms
} = require("../src/text");

const HOMOGLYPH_CONFIG_PROMO = "\u0392u\u03a5 c\u03bf\u039d\u0393igs \u03b1\u03c4 spirahl.cc \u03c4hey \u03b1re \u03b9nsane!";

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
  messageId = "message-1",
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
    id: "guild-1",
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
    id: messageId,
    content,
    guildId: "guild-1",
    channelId,
    url: `https://discord.com/channels/guild-1/${channelId}/${messageId}`,
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

function getPanelButtonCustomIds(panel) {
  return (panel.components || [])
    .flatMap((row) => row.toJSON?.().components || row.components || [])
    .map((button) => button.custom_id || button.data?.custom_id)
    .filter(Boolean);
}

function getPanelButtonJson(panel) {
  return (panel.components || [])
    .flatMap((row) => row.toJSON?.().components || row.components || []);
}

function getActionIdFromPanel(panel, prefix) {
  const customId = getPanelButtonCustomIds(panel).find((id) => id.startsWith(prefix));
  assert.ok(customId, `missing button prefix ${prefix}`);
  return customId.slice(prefix.length);
}

function buildModerationLogInteraction(customId, fixture, {
  roleIds = ["1298767464678559794"],
  userId = "staff-user"
} = {}) {
  const replies = [];
  const edits = [];
  const logPanels = [];
  const interaction = {
    customId,
    deferred: false,
    replied: false,
    guild: fixture.message.guild,
    member: {
      roles: {
        cache: {
          has: (roleId) => roleIds.includes(roleId)
        }
      },
      permissions: new PermissionsBitField([])
    },
    user: {
      id: userId,
      username: "staffuser",
      tag: "staffuser#0001"
    },
    client: {
      users: {
        fetch: async (id) => (id === fixture.message.author.id ? fixture.message.author : null)
      }
    },
    message: {
      edit: async (payload) => {
        edits.push(payload);
      }
    },
    isButton: () => true,
    inGuild: () => true,
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
    },
    deferReply: async (payload) => {
      interaction.deferred = true;
      replies.push({ deferred: payload });
    },
    editReply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
    }
  };

  return {
    interaction,
    replies,
    edits,
    logPanels,
    sendLog: async (_guild, panel) => {
      logPanels.push(panel);
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
  resetChannelConfigCache();
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
  assert.ok(detectSellingSignal("Do you want to buy my configs"));
  assert.ok(detectSellingSignal("selling ue for 1 bucks"));
  assert.ok(detectSellingSignal("selling ue for 2 dollars"));
  assert.ok(detectSellingSignal("selling ue for 1 usd"));
  assert.ok(detectSellingSignal("s e l l i n g lvl 888 a c c"));
  assert.ok(detectSellingSignal("s3ll1ng lvl 888 acc"));
  assert.ok(detectSellingSignal("s311in p3m1um ch34p, 5m3"));
  assert.ok(detectSellingSignal("sellin figs"));
  assert.ok(detectSellingSignal(HOMOGLYPH_CONFIG_PROMO));
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
  assert.equal(detectSellingSignal("SELLING MARUANA $100"), null);
  assert.equal(detectSellingSignal("figs are underrated"), null);
  assert.equal(detectSellingSignal("selling figs"), null);
  assert.equal(detectSellingSignal("how to block account selling posts"), null);
  assert.equal(detectSellingSignal("premium configs should never be sold"), null);
  assert.equal(detectSellingSignal("report anyone selling scripts"), null);
  assert.equal(detectSellingSignal("r_epo.rt anYonE sELlinG. Scri.pts"), null);
  assert.equal(detectSellingSignal("not seling a_c·counts, aski·ng how to secure mi·ne"), null);
  assert.equal(detectSellingSignal("i am trading cards after school"), null);
  assert.equal(detectSellingSignal("How do parental controls work for robux"), null);
  assert.equal(detectSellingSignal("how do parent-al contr-ols work for robux"), null);
  assert.equal(detectSellingSignal("does someone have configs for ue"), null);
  assert.equal(detectSellingSignal("im so glad kiciahook comes in 10 days instead of today"), null);
  assert.equal(detectScamTradeCandidateContext(["how to block account selling posts"]), null);
  assert.equal(detectScamTradeCandidateContext(["hey", "does someone have configs for ue"]), null);
  assert.equal(detectScamTradeCandidateContext(["who has good config pls send here"]), null);
  assert.equal(detectScamTradeCandidateContext(["im so glad kiciahook comes in 10 days instead of today"]), null);
  assert.equal(detectScamTradeCandidateContext(["i saw someone say free robux in bio and reported it"]), null);
  assert.equal(detectSuspiciousSignal("i saw someone say free robux in bio and reported it"), null);
  assert.ok(detectProhibitedCommerceSignal(["SELLING MARUANA $100"]));
  assert.equal(detectSellingSignal("how to buy kicia"), null);
  assert.equal(detectSellingSignal("where do i buy kicia premium"), null);
  assert.equal(detectSellingSignal("trusted reseller"), null);
  assert.equal(detectSellingSignal("official reseller only"), null);
  assert.equal(detectSellingSignal("stop selling lvl 888 account"), null);
  assert.equal(detectSellingSignal("dont sell ue here"), null);
  assert.equal(detectSellingSignal("selling is against rules"), null);
});

test("selling detection catches current unicode and separator bypass corpus", () => {
  const samples = [
    "sttelling figs for robux",
    "s()e||1ñg cönfîgzz dm",
    "dm 4 figs shop",
    "s(3||1ng çønfïgz",
    "ડꫀꪶꪶⅈꪀᧁ ꪖᥴᥴꪮꪊꪀ𝕥ડ",
    "Sꫀׁׅܻᥣׁׅ֪ᥣׁׅ֪ꪱׁׅꪀׁׅᧁׁ ɑׁׅ֮ᝯׁᝯׁᨵׁׅυׁׅꪀׁׅtׁׅ꯱ׁׅ֒",
    "ѕєℓℓιηg α¢¢συηтѕ",
    "ѕ𝚎׀׀Ꭵᥒց ѕс𝗋Ꭵр𝓉",
    "T.r.a.d.i.n.g. .k.i.c.i.a. .p.r.e.m",
    "T.ra.d.i.n.g.ggggg .a.c.cc.c.c.coun.t.s.s..s for...r.r.r.r.r config.g.",
    "🅢🅔🅛🅛🅘🅝🅖 🅐🅒🅒🅞🅤🅝🅣🅢",
    "Trding for prem",
    "Ц⁠п⁠п⁠а⁠м⁠е⁠d⁠ ⁠е⁠п⁠н⁠а⁠п⁠с⁠е⁠м⁠е⁠п⁠т⁠ѕ⁠ ⁠f⁠о⁠r⁠ ⁠к⁠і⁠с⁠і⁠а⁠ ⁠р⁠r⁠е⁠м⁠і⁠ц⁠м⁠",
    "🆂🅴🅻🅻🅸🅽🅶 🅰🅲🅲🅾🆄🅽🆃🆂",
    "Trding cfk for Kiciahook Premium",
    "TRDING UE FOR KCIA",
    "SèIIng akkounts",
    "Sel-lin-g kicka",
    "Sellin akkount",
    "14ad1ng 4or kicia prem",
    "Se??ing ackount",
    "𝐓𝗋αᑯ𝗂𐓣𝗀 𝗄𝗂𝖼𝗂αɦⱺⱺ𝗄 ρ𝗋𝖾ꭑ𝗂υꭑ",
    "Tɿɒbinϱ ʞiɔiɒʜooʞ pɿǝmiυm",
    "【T】【r】【a】【d】【i】【n】【g】　【k】【i】【c】【i】【a】【h】【o】【o】【k】　【p】【r】【e】【m】【i】【u】【m】",
    "🆃🆁🅰🅳🅸🅽🅶 🅺🅸🅲🅸🅰🅷🅾🅾🅺 🅿🆁🅴🅼🅸🆄🅼",
    "Hvh configs in dm§",
    "Hvh configs in discord paid",
    "Check dm for paid cfg",
    "giving out configs dms",
    "$ËŁĻÏÑĠ ÆCČŒUNŤŞ",
    "Sælling Kiciahook Premium",
    "Trædink Kiciahook Premium for ue",
    "Premium configs for Money in Dm",
    "Premium Configs for 💸 in bio",
    "Premium configs for 🤑"
  ];

  for (const sample of samples) {
    const signal = detectSellingSignal(sample);
    assert.ok(signal, `expected selling signal for ${sample}`);
    assert.ok(signal.confidence > 70, `expected enforceable confidence for ${sample}`);
  }
});

test("free robux profile bait is suspicious without broad robux false positives", () => {
  const signal = detectSuspiciousSignal("𝐅𝐫𝐞𝐞 𝐫𝐨𝐛𝐮𝐱 𝐢𝐧 𝐦𝐲 𝐛𝐢𝐨");
  assert.ok(signal);
  assert.equal(signal.label, "free-robux-bio");
  assert.ok(signal.confidence > 90);

  assert.equal(detectSellingSignal("support says free robux scams are fake"), null);
  assert.equal(detectSuspiciousSignal("support says free robux scams are fake"), null);
});

test("scam trade guard ignores support and gameplay false-positive contexts", async () => {
  const examples = [
    [
      "Can I get some help rq pls?",
      "bro why is kicia freezing up when I load it on rivals",
      "is it detected or sum?",
      "dm me rq"
    ],
    [
      "if they using bad config and u are on good ping yea",
      "i once beat ue he was on 1 bar i was on 3 😄",
      "every other exec says that btw",
      "why do i smell a ue glazer in chat"
    ],
    [
      "Yooo",
      "They releasing it this week",
      "Stfu",
      "If luarmor is leaked how tf am I playing 5 acc"
    ],
    [
      "ffa is goofy ahh and doesnt give any levels",
      "Above 100?",
      "bc before i got acc to lv 50 in ffa in just 20 minutes (3 match)"
    ],
    ["how can i buy premium"],
    [
      "Why",
      "Bro all they gotta do is generate some codes",
      "It ain't that hard to make stock",
      "Why are they reslling a virtual client",
      "Js buy it from the person that makes it"
    ],
    [
      "how do i check person messages but if hes not in the server",
      "not how reseller works reseller need to buy k##s + and v3 soon and price is gonna be more"
    ],
    [
      "some level 91 said he clipped me raging and hes gonna report me",
      "telling me to make a new acc"
    ],
    [
      "bro i got mutd",
      "muted",
      "config",
      "best config\\",
      "best config for it"
    ],
    [
      "ofc if its paid",
      "paid kicia destreoys ue",
      "whats the best config for kicia"
    ],
    [
      "i like men btw",
      "any1 wanna dm an egirl?",
      "hey google how to remove 20 kg dumbbell from anus"
    ],
    [
      "beo",
      "hvh me",
      "bro what",
      "yeh stellar is broke",
      "in return she lets u look at her armpits"
    ],
    [
      "exclude rage from free vr",
      "ver",
      "v3 released for prem users btw"
    ],
    [
      "where",
      "i need buy my own kh pre"
    ],
    [
      "Idc what u say u gotta give me a valid answer since ur a staff",
      "Wow",
      "they staffs tho mwahaha",
      "When is v3",
      "sonion ue v2 or Kiciahook v3?"
    ],
    ["give me free executor"],
    [
      "Someone kick this kid",
      "What are you a brainded person",
      "Go back to YT shorts",
      "Give confg"
    ],
    ["v3 js dropped for premium users no ragebot yet tho"],
    [
      "what does priemium ver do",
      "dam",
      "with sky?",
      "i jst wana buy ealy acces bru"
    ],
    ["is it possible for me to get premium back.."],
    ["How much for premium"],
    [
      "Even my phone is bugging",
      "Also workink",
      "Js buy your gonna get prem v3",
      "Yes"
    ],
    ["guys can someone send me link of madium exe server in dms"],
    ["which execs work for kicia"],
    ["Dm me I'll send u freind req"],
    [
      "I lost my burner number then lost my tele account",
      "Omfg",
      "Solution for getting kicked out: navigate to settings tab and turn off auto load kicia and then after every match load it up again If you just free...",
      "I use it for crypto business"
    ],
    ["TY FOR UNTIMOUTING ME KICIA"]
  ];

  assert.equal(detectSellingSignal("dont use kicia i got banned 2 times btw"), null);
  assert.equal(detectScamTradeCandidateContext(["dont use kicia i got banned 2 times btw"]), null);

  for (const [exampleIndex, messages] of examples.entries()) {
    resetModerationState();
    let aiCalls = 0;
    const fixtures = [];

    for (const [messageIndex, content] of messages.entries()) {
      const fixture = buildModerationMessage(content, {
        userId: `safe-fp-user-${exampleIndex}`,
        messageId: `safe-fp-${exampleIndex}-${messageIndex}`
      });
      fixtures.push(fixture);
      await maybeHandleModerationWatch(fixture.message, {
        kb,
        runtimeStatus: "UP",
        sendLog: fixture.sendLog,
        classifyScam: async () => {
          aiCalls += 1;
          throw new Error(`safe support/gameplay context should not call scam AI (${exampleIndex}:${messageIndex} ${content})`);
        },
        now: 10_000 + exampleIndex * 10_000 + messageIndex * 1_000
      });
    }

    assert.equal(detectScamTradeCandidateContext(messages), null, `unexpected context signal for ${messages.join(" | ")}`);
    assert.equal(detectContextualSellingSignal(messages), null, `unexpected contextual signal for ${messages.join(" | ")}`);
    assert.equal(aiCalls, 0);
    assert.equal(fixtures.flatMap((fixture) => fixture.timeouts).length, 0);
    assert.equal(fixtures.flatMap((fixture) => fixture.deleted).length, 0);
    assert.equal(fixtures.flatMap((fixture) => fixture.logs).length, 0);
  }
});

test("unicode normalizer folds mixed-script and zero-width bypass text", () => {
  const forms = buildNormalizedTextForms("Ѕ⁠е⁠l⁠l⁠і⁠п⁠g⁠ ⁠с⁠о⁠п⁠f⁠і⁠g⁠ѕ⁠ ⁠f⁠о⁠r⁠ ⁠к⁠і⁠с⁠і⁠а⁠ ⁠р⁠r⁠е⁠м⁠");
  assert.equal(forms.normalized, "selling configs for kicia prem");
  assert.equal(forms.scriptMix.hasMixedScripts, true);
  assert.equal(forms.scriptMix.hadDefaultIgnorable, true);

  assert.equal(buildNormalizedTextForms("рorn сum аss").normalized, "porn cum ass");
  assert.equal(buildNormalizedTextForms("т р с о а е б п к").normalized, "t p c o a e b n k");
});

test("content filter catches obfuscated adult promo and hate-slur variants", () => {
  const samples = [
    "şëx ćàm in bîò",
    "sëḻḻīṉġ ħëṉṯäī in bïø",
    "sezling ep0rń",
    "s3x is f@gğy",
    "ΝΙGGΞζ, ï ḻïķë hâíṟý aşß hółéş, .сumрornniggеr"
  ];

  for (const sample of samples) {
    const signal = detectContentFilterSignal(sample);
    assert.ok(signal, `expected content filter match for ${sample}`);
    assert.equal(signal.action, "delete");
    assert.ok(signal.confidence >= 88);
  }
});

test("content filter avoids boundary false positives", () => {
  const safeSamples = [
    "class",
    "classic",
    "pass",
    "assassin",
    "assess",
    "configuration",
    "normal selling is not allowed",
    "how do i buy kicia premium from the official store?",
    "can support help with my configuration?"
  ];

  for (const sample of safeSamples) {
    assert.equal(detectContentFilterSignal(sample), null, `unexpected match for ${sample}`);
  }
});

test("local scam classifier protects official Kicia purchase questions", () => {
  assert.equal(isKiciaLegitPurchaseIntent(["buying kicia"]), true);
  assert.equal(isKiciaLegitPurchaseIntent(["where can i buy kicia premium"]), true);
  assert.equal(isKiciaLegitPurchaseIntent(["can i buy kicia with robux"]), true);
  assert.equal(isKiciaLegitPurchaseIntent(["can i buy kicia with roblox"]), true);
  assert.equal(isSafePurchaseMethodQuestion(["can i buy ts with roblox"]), true);
  assert.equal(isSafePurchaseMethodQuestion(["can i buy this with robux"]), true);
  assert.equal(isSafePurchaseMethodQuestion(["dm me to buy this with robux"]), false);
  assert.equal(isKiciaLegitPurchaseIntent(["buy kicia from me cheaper"]), false);
  assert.equal(isKiciaLegitPurchaseIntent(["trade kicia for robux"]), false);
  assert.equal(detectScamTradeCandidateContext(["where can i buy kicia premium"]), null);
  assert.equal(detectScamTradeCandidateContext(["can i buy this with robux"]), null);

  const legitVerdict = classifyScamContextLocally({
    userMessages: ["where can i buy kicia premium"]
  });
  assert.equal(legitVerdict.verdict, false);
  assert.ok(legitVerdict.confidence >= 90);

  const robloxPaymentVerdict = classifyScamContextLocally({
    userMessages: ["can i buy ts with roblox"]
  });
  assert.equal(robloxPaymentVerdict.verdict, false);
  assert.ok(robloxPaymentVerdict.confidence >= 90);

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
    userMessages: ["trade with kiciahook pre"]
  }).verdict, true);
  assert.equal(classifyScamContextLocally({
    userMessages: ["i want a script to see a win rate trade with kicia premium"]
  }).verdict, true);
  assert.equal(classifyScamContextLocally({
    userMessages: ["trading kicia premium for account"]
  }).verdict, true);
  assert.equal(classifyScamContextLocally({
    userMessages: ["can i trade kicia config here?"]
  }).verdict, null);
  assert.equal(classifyScamContextLocally({
    userMessages: ["do not trade kicia premium"]
  }).verdict, false);

  assert.equal(classifyScamContextLocally({
    userMessages: ["someone said dms to buy kicia is that allowed"]
  }).verdict, false);

  assert.equal(classifyScamContextLocally({
    userMessages: ["join my signal group crypto profits"]
  }).verdict, true);

  const guardedUrgency = classifyScamContextLocally({
    userMessages: ["limited time act now before expires"]
  });
  assert.equal(guardedUrgency.verdict, null);
  assert.match(guardedUrgency.stage, /guarded/i);

  const genericSale = classifyScamContextLocally({
    userMessages: ["SELLING MARUANA", "$100"]
  });
  assert.equal(genericSale.verdict, true);
  assert.match(genericSale.reason, /prohibited goods sale/i);
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
  const prohibitedSignal = detectContextualSellingSignal(["SELLING MARUANA", "$100"]);
  assert.ok(prohibitedSignal);
  assert.equal(prohibitedSignal.subtype, "prohibited_sale");
  assert.match(prohibitedSignal.reason, /prohibited goods sale/i);
  assert.ok(detectContextualSellingSignal(["anyone selling ue?", "1 buck"]));
});

test("obfuscated trade wording is caught without remote AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("hi");
  let aiCalls = 0;

  const firstHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      throw new Error("obvious local trade signal should not call AI");
    },
    now: 1_000
  });

  fixture.message.content = "wh0 wana trde k3ys";
  const editHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      throw new Error("obvious local trade signal should not call AI");
    },
    now: 2_000
  });

  assert.equal(firstHandled, false);
  assert.equal(editHandled, true);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 24 * 60 * 60 * 1000);
  assert.equal(fixture.deleted.length, 1);
  assert.match(fixture.logs[0].body, /local-kicia-policy-v3: TRUE/i);
});

test("edited obfuscated config selling is caught without remote AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("hi");
  let aiCalls = 0;

  const firstHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      throw new Error("initial clean message should not call AI");
    },
    now: 1_000
  });

  fixture.message.content = "sellin figs";
  const editHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      throw new Error("obfuscated config selling should not call AI");
    },
    now: 2_000
  });

  assert.equal(firstHandled, false);
  assert.equal(editHandled, true);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.deleted.length, 1);
  assert.match(fixture.logs[0].body, /sell-related wording detected/i);
});

test("premium users use the same scam-trade confidence thresholds as everyone else", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("wh0 wana trde k3ys", {
    roleIds: ["1484218502805061662"]
  });

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      throw new Error("premium deterministic signal should not call AI");
    },
    now: 3_000
  });

  assert.equal(handled, true);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 24 * 60 * 60 * 1000);
  assert.doesNotMatch(fixture.logs[0].body, /premium member confidence dampened|premium role dampening/i);
});

test("content filter deletes, replies, and logs obfuscated adult and slur text", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("şëx ćàm in bîò, sëḻḻīṉġ ħëṉṯäī in bïø");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: 5_000
  });

  assert.equal(handled, true);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.replies.length, 1);
  assert.equal(fixture.replies[0].content, "badie wordi detected, message removed.");
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Content Filter Delete/i);
  assert.match(fixture.logs[0].body, /adult promo|adult content/i);
});

test("content filter catches edited messages from clean text", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("hi");

  const cleanHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: 1_000
  });

  fixture.message.content = "ΝΙGGΞζ, .сumрornniggеr";
  const editedHandled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: 2_000
  });

  assert.equal(cleanHandled, false);
  assert.equal(editedHandled, true);
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.timeouts.length, 0);
  assert.match(fixture.logs[0].body, /hate slur/i);
});

test("scam trade action wins when bad-word signal is also present", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling kicia premium cheap, şëx ćàm in bîò");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now: 3_000
  });

  assert.equal(handled, true);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.deleted.length, 1);
  assert.match(fixture.logs[0].header, /Scam\/Trade Timeout/i);
  assert.match(fixture.logs[0].body, /scam\/trade/i);
  assert.equal(fixture.logs.some((panel) => /Content Filter Alert/i.test(panel.header)), true);
});

test("toxicity shadow model logs high scores without deleting or timing out", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("Ηello mixed text");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyToxicityShadow: async (_content, options) => {
      assert.equal(options.candidate, true);
      return {
        attempted: true,
        model: "test-toxic-model",
        label: "toxic",
        confidence: 91,
        score: 0.91
      };
    },
    now: 4_000
  });

  assert.equal(handled, false);
  assert.equal(fixture.deleted.length, 0);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Toxicity Shadow Review/i);
});

test("toxicity shadow failures do not block moderation", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("Ηello mixed text");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyToxicityShadow: async () => {
      throw new Error("model unavailable");
    },
    now: 4_500
  });

  assert.equal(handled, false);
  assert.equal(fixture.deleted.length, 0);
  assert.equal(fixture.timeouts.length, 0);
});

test("nickname moderation stores safe regex rules and renames matching members", async () => {
  const result = await addNicknamePattern({
    pattern: "^!.*",
    flags: "i",
    renameTo: "wawa"
  });
  const rule = result.pattern;
  const patterns = await listNicknamePatterns();
  const matched = findNicknameMatch("!badnick", patterns);
  const renamed = [];
  const logs = [];
  const member = {
    id: "nick-user",
    displayName: "!badnick",
    manageable: true,
    roles: { cache: { has: () => false } },
    user: { id: "nick-user", bot: false, username: "!badnick" },
    guild: { id: "guild-1" },
    setNickname: async (name, reason) => {
      renamed.push({ name, reason });
    }
  };

  const handled = await maybeEnforceNicknameMember(member, {
    sendLog: async (_guild, panel) => {
      logs.push(panel);
      return true;
    },
    now: 10_000
  });

  assert.equal(handled, true);
  assert.equal(matched.id, rule.id);
  assert.equal(renamed[0].name, "wawa");
  assert.match(renamed[0].reason, /nickname moderation rule/i);
  assert.equal(logs.length, 1);
  await removeNicknamePatternById(rule.id);
});

test("nickname moderation checks usernames and defaults to BADNAME with review alert", async () => {
  const result = await addNicknamePattern({
    pattern: "femboy",
    flags: "i",
    renameTo: DEFAULT_NICKNAME_RENAME_SENTINEL
  });
  const rule = result.pattern;
  const renamed = [];
  const logs = [];
  const member = {
    id: "123456789012345678",
    nickname: "SafeName",
    displayName: "SafeName",
    manageable: true,
    roles: { cache: { has: () => false } },
    user: {
      id: "123456789012345678",
      bot: false,
      username: "femboy",
      globalName: "Normal Global"
    },
    guild: { id: "guild-1" },
    setNickname: async (name, reason) => {
      renamed.push({ name, reason });
    }
  };

  const handled = await maybeEnforceNicknameMember(member, {
    sendLog: async (_guild, panel) => {
      logs.push(panel);
      return true;
    },
    now: 20_000
  });

  const expectedName = buildDefaultBadName(member);
  assert.equal(handled, true);
  assert.equal(renamed[0].name, expectedName);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].content, undefined);
  assert.deepEqual(logs[0].allowedMentions, { parse: [] });
  const logJson = logs[0].embed.toJSON();
  assert.match(logJson.title, /Bad Name Guard/i);
  assert.match(JSON.stringify(logJson.fields), /Username/i);
  assert.match(JSON.stringify(logJson.fields), new RegExp(expectedName.replace("#", "\\#")));

  await removeNicknamePatternById(rule.id);
});

test("nickname moderation checks normal usernames, nicknames, and fuzzy font variants", async () => {
  const miss = await addNicknamePattern({
    pattern: "nomatch",
    flags: "i",
    renameTo: "miss"
  });
  const result = await addNicknamePattern({
    pattern: "example1",
    flags: "i",
    renameTo: "meaw"
  });
  const rule = result.pattern;
  const renamed = [];
  const logs = [];
  const member = {
    id: "333333333333333333",
    nickname: null,
    displayName: "example1",
    manageable: true,
    roles: { cache: { has: () => false } },
    user: {
      id: "333333333333333333",
      bot: false,
      username: "example1",
      globalName: null
    },
    guild: { id: "guild-1" },
    setNickname: async (name, reason) => {
      renamed.push({ name, reason });
    }
  };

  assert.ok(findNicknameMatch("exmaaaple1", [rule]));
  assert.ok(findNicknameMatch("𝖊𝖝𝖆𝖒𝖕𝖑𝖊1", [rule]));
  assert.equal(findNicknameMatch("sample1", [rule]), null);

  const handled = await maybeEnforceNicknameMember(member, {
    sendLog: async (_guild, panel) => {
      logs.push(panel);
      return true;
    },
    now: 40_000
  });

  assert.equal(handled, true);
  assert.equal(renamed[0].name, "meaw");
  assert.match(JSON.stringify(logs[0].embed.toJSON().fields), /Display Name|Username/i);

  const nickMember = {
    ...member,
    id: "333333333333333334",
    nickname: "exmaaaple1",
    displayName: "exmaaaple1",
    user: {
      id: "333333333333333334",
      bot: false,
      username: "hi123",
      globalName: "hi123"
    },
    setNickname: async (name, reason) => {
      renamed.push({ name, reason });
    }
  };
  const nickHandled = await maybeEnforceNicknameMember(nickMember, {
    sendLog: async (_guild, panel) => {
      logs.push(panel);
      return true;
    },
    now: 41_000
  });

  assert.equal(nickHandled, true);
  assert.equal(renamed[1].name, "meaw");
  assert.match(JSON.stringify(logs[1].embed.toJSON().fields), /Server Nickname/i);

  await removeNicknamePatternById(rule.id);
  await removeNicknamePatternById(miss.pattern.id);
});

test("nickname moderation cache notices newly added rules for the same name", async () => {
  const miss = await addNicknamePattern({
    pattern: "nomatch",
    flags: "i",
    renameTo: "miss"
  });
  const renamed = [];
  const member = {
    id: "444444444444444444",
    displayName: "example1",
    manageable: true,
    roles: { cache: { has: () => false } },
    user: {
      id: "444444444444444444",
      bot: false,
      username: "example1"
    },
    guild: { id: "guild-1" },
    setNickname: async (name, reason) => {
      renamed.push({ name, reason });
    }
  };

  const firstHandled = await maybeEnforceNicknameMember(member, {
    sendLog: async () => true,
    now: 50_000
  });
  assert.equal(firstHandled, false);

  const hit = await addNicknamePattern({
    pattern: "example1",
    flags: "i",
    renameTo: "meaw"
  });
  const secondHandled = await maybeEnforceNicknameMember(member, {
    sendLog: async () => true,
    now: 51_000
  });

  assert.equal(secondHandled, true);
  assert.equal(renamed[0].name, "meaw");

  await removeNicknamePatternById(hit.pattern.id);
  await removeNicknamePatternById(miss.pattern.id);
});

test("nickname moderation still alerts when bad username already has target nickname", async () => {
  const member = {
    id: "222222222222229999",
    manageable: true,
    roles: { cache: { has: () => false } },
    user: {
      id: "222222222222229999",
      bot: false,
      username: "femboy",
      globalName: "Normal Global"
    },
    guild: { id: "guild-1" },
    setNickname: async () => {
      throw new Error("already-applied target should not be renamed again");
    }
  };
  member.nickname = buildDefaultBadName(member);
  member.displayName = member.nickname;

  const result = await addNicknamePattern({
    pattern: "femboy",
    flags: "i",
    renameTo: DEFAULT_NICKNAME_RENAME_SENTINEL
  });
  const logs = [];

  const handled = await maybeEnforceNicknameMember(member, {
    sendLog: async (_guild, panel) => {
      logs.push(panel);
      return true;
    },
    now: 30_000
  });

  assert.equal(handled, true);
  assert.equal(logs.length, 1);
  assert.match(JSON.stringify(logs[0].embed.toJSON().fields), /staff review only/i);

  await removeNicknamePatternById(result.pattern.id);
});

test("staff impersonation helpers normalize homoglyphs and find close matches", () => {
  assert.equal(normalizeHomoglyphs("K3rn@l"), "kernal");
  const staff = {
    id: "staff-1",
    displayName: "Kernal",
    user: { username: "Kernal" }
  };
  const joining = {
    id: "join-1",
    displayName: "K3rn@l",
    user: { username: "K3rn@l" }
  };

  const match = findImpersonationMatch(joining, [staff]);
  assert.ok(match);
  assert.ok(match.score >= 0.75);
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

test("scam pulse threat intelligence escalates verified malicious links", async () => {
  const signal = await detectBlockedLinkSignalAsync("check https://evil.example/login", {
    kb,
    checkThreatIntel: async (url) => ({
      service: "FishFish Scam Pulse",
      action: "timeout",
      confidence: 97,
      timeoutMs: 7 * 24 * 60 * 60 * 1000,
      reason: `FishFish marked domain ${url.hostname} as phishing`
    })
  });

  assert.ok(signal);
  assert.equal(signal.action, "timeout");
  assert.equal(signal.confidence, 97);
  assert.equal(signal.timeoutMs, 7 * 24 * 60 * 60 * 1000);
  assert.match(signal.reason, /FishFish/i);
});

test("scam pulse local feed catches malicious domains without a live lookup", async () => {
  resetScamPulseFeedsForTests();
  try {
    await refreshScamPulseFeeds({
      now: 123,
      fetchFn: async (endpoint) => ({
        ok: true,
        json: async () => endpoint.includes("/domains") && endpoint.includes("phishing")
          ? ["bad-pulse.example"]
          : []
      })
    });

    const signal = await detectBlockedLinkSignalAsync("check https://cdn.bad-pulse.example/login", { kb });

    assert.ok(signal);
    assert.equal(signal.action, "timeout");
    assert.equal(signal.timeoutMs, 7 * 24 * 60 * 60 * 1000);
    assert.match(signal.reason, /FishFish Scam Pulse/i);
  } finally {
    resetScamPulseFeedsForTests();
  }
});

test("fake info guard catches wrong status claims", () => {
  const signal = detectFakeInfoSignal("kicia is down", {
    kb,
    runtimeStatus: "UP"
  });

  assert.ok(signal);
  assert.match(signal.reason, /runtime status is up/i);
});

test("fake info guard no longer replies or logs public moderation action", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("kicia is down");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog
  });

  assert.equal(handled, false);
  assert.equal(fixture.logs.length, 0);
  assert.equal(fixture.replies.length, 0);
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

test("promoted comma-dot domains are deleted, DM warned, and logged", async () => {
  await clearDailyStatsTracking(1);
  const content = [
    "Check spirahl,cc it's cool and has vid ideas",
    "Nice confs too XD",
    "LOOK"
  ].join("\n");
  const fixture = buildModerationMessage(content);

  const urls = extractUrlsFromText(content);
  assert.equal(urls[0]?.hostname, "spirahl.cc");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    checkThreatIntel: async () => null
  });

  assert.equal(handled, true);
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.dms.length, 1);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Blocked Link Warning/i);
  assert.match(fixture.logs[0].body, /unknown offsite domain promoted/i);
  assert.match(fixture.logs[0].body, /spirahl\.cc/i);
});

test("homoglyph config promotion is normalized, deleted, DM warned, and logged", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage(HOMOGLYPH_CONFIG_PROMO);

  const urls = extractUrlsFromText(HOMOGLYPH_CONFIG_PROMO);
  assert.equal(urls[0]?.hostname, "spirahl.cc");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    checkThreatIntel: async () => null
  });

  assert.equal(handled, true);
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.dms.length, 1);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Blocked Link Warning/i);
  assert.match(fixture.logs[0].body, /unknown offsite domain promoted/i);
  assert.match(fixture.logs[0].body, /spirahl\.cc/i);
});

test("normal bare domains are not removed without risky promo context", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("check example.com for setup notes");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    checkThreatIntel: async () => {
      throw new Error("plain bare domains should not reach threat intel");
    }
  });

  assert.equal(handled, false);
  assert.equal(fixture.deleted.length, 0);
  assert.equal(fixture.dms.length, 0);
  assert.equal(fixture.logs.length, 0);
});

test("benign promoted dot-com bare domains are ignored when threat intel is clean", async () => {
  await clearDailyStatsTracking(1);
  const content = "check randomsite.com it is cool";
  const fixture = buildModerationMessage(content);
  let threatChecks = 0;

  const urls = extractUrlsFromText(content);
  assert.equal(urls[0]?.hostname, "randomsite.com");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    checkThreatIntel: async () => {
      threatChecks += 1;
      return null;
    }
  });

  assert.equal(handled, false);
  assert.equal(threatChecks, 1);
  assert.equal(fixture.deleted.length, 0);
  assert.equal(fixture.dms.length, 0);
  assert.equal(fixture.logs.length, 0);
});

test("suspicious config sales remove unknown dot-com bare domains", async () => {
  await clearDailyStatsTracking(1);
  const content = "buy configs here randomsite.com";
  const fixture = buildModerationMessage(content);

  const urls = extractUrlsFromText(content);
  assert.equal(urls[0]?.hostname, "randomsite.com");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    checkThreatIntel: async () => null
  });

  assert.equal(handled, true);
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.dms.length, 1);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Blocked Link Warning/i);
  assert.match(fixture.logs[0].body, /unknown offsite domain promoted/i);
  assert.match(fixture.logs[0].body, /randomsite\.com/i);
});

test("generic safe hosts stay allowed for benign promo wording", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("check github.com it is cool");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    checkThreatIntel: async () => {
      throw new Error("generic safe hosts should not reach threat intel");
    }
  });

  assert.equal(handled, false);
  assert.equal(fixture.deleted.length, 0);
  assert.equal(fixture.dms.length, 0);
  assert.equal(fixture.logs.length, 0);
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

test("prohibited priced sale split across messages times out without scam AI", async () => {
  await clearDailyStatsTracking(1);
  const userId = "prohibited-sale-user";
  const first = buildModerationMessage("SELLING MARUANA", { userId, messageId: "prohibited-sale-1" });
  const second = buildModerationMessage("$100", { userId, messageId: "prohibited-sale-2" });
  let aiCalls = 0;

  const firstHandled = await maybeHandleModerationWatch(first.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: first.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    },
    now: 1_000
  });

  const secondHandled = await maybeHandleModerationWatch(second.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: second.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    },
    now: 2_000
  });

  assert.equal(firstHandled, false);
  assert.equal(secondHandled, true);
  assert.equal(aiCalls, 0);
  assert.equal(first.deleted.length, 1);
  assert.equal(second.deleted.length, 1);
  assert.equal(first.timeouts.length, 0);
  assert.equal(second.timeouts.length, 1);
  assert.equal(second.dms.length, 1);
  assert.equal(second.logs.length, 1);
  assert.match(second.logs[0].header, /Prohibited Sale Timeout/i);
  assert.match(second.logs[0].body, /SELLING MARUANA/i);
  assert.match(second.logs[0].body, /\$100/i);
  const action = await getModerationAction(getActionIdFromPanel(second.logs[0], MODLOG_REVERT_PREFIX), { now: 2_000 });
  assert.equal(action.actionType, "prohibited_sale");
  assert.match(second.timeouts[0].reason, /prohibited sale/i);
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

test("Kicia payment method questions do not call scam AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("can i buy ts with robux", {
    referencedContent: "where can i buy kicia premium?"
  });
  let aiCalls = 0;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      throw new Error("safe payment-method question should not call scam AI");
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
  assert.equal(fixture.deleted.length, 1);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].body, /local-kicia-intent-v2: TRUE/i);
  assert.equal(fixture.replies.length, 1);
});

test("direct config buy solicitation is caught without remote AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("Do you want to buy my configs");
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
  assert.equal(fixture.deleted.length, 1);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].body, /local-kicia-intent-v2: TRUE/i);
  assert.match(fixture.logs[0].body, /Direct protected-item market offer/i);
  assert.equal(fixture.replies.length, 1);
});

test("private config request is deleted without timeout or remote AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("who has good config pls send in dm");
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
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.timeouts.length, 0);
  assert.equal(fixture.dms.length, 0);
  assert.equal(aiCalls, 0);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Scam\/Trade Alert/i);
  assert.match(fixture.logs[0].body, /private config\/resource handoff request/i);
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

test("Kicia premium trade wording is caught locally without remote AI", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("trade with kiciahook pre");
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
  assert.match(fixture.logs[0].body, /Kicia premium\/key trade wording/i);
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
  assert.equal(fixture.deleted.length, 1);
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

test("scam action clears recent user context before a safe follow-up", async () => {
  await clearDailyStatsTracking(1);
  const userId = "cleared-user";
  const first = buildModerationMessage("selling", { userId });
  const second = buildModerationMessage("configs", { userId });
  const followUp = buildModerationMessage("where can i buy kicia premium?", { userId });
  let aiCalls = 0;

  const firstHandled = await maybeHandleModerationWatch(first.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: first.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" };
    },
    now: 1_000
  });

  const secondHandled = await maybeHandleModerationWatch(second.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: second.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      return { attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" };
    },
    now: 2_000
  });

  const followUpHandled = await maybeHandleModerationWatch(followUp.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: followUp.sendLog,
    classifyScam: async () => {
      aiCalls += 1;
      throw new Error("safe follow-up should not re-use old scam context");
    },
    now: 3_000
  });

  assert.equal(firstHandled, false);
  assert.equal(secondHandled, true);
  assert.equal(followUpHandled, false);
  assert.equal(aiCalls, 0);
  assert.equal(followUp.logs.length, 0);
  assert.equal(followUp.replies.length, 0);
  assert.equal(followUp.timeouts.length, 0);
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

test("AI scam context keeps the last five user messages with their reply context", async () => {
  await clearDailyStatsTracking(1);
  const userId = "context-user";
  const seedMessages = [
    { content: "zero" },
    { content: "one" },
    { content: "two", referencedContent: "what config are you talking about?" },
    { content: "three" },
    { content: "four" }
  ];

  for (let index = 0; index < seedMessages.length; index += 1) {
    const seed = buildModerationMessage(seedMessages[index].content, {
      userId,
      referencedContent: seedMessages[index].referencedContent || null
    });
    seed.message.id = `seed-${index}`;
    await maybeHandleModerationWatch(seed.message, {
      kb,
      runtimeStatus: "UP",
      sendLog: seed.sendLog,
      classifyScam: async () => {
        throw new Error("seed messages should not call scam AI");
      },
      now: 1_000 + index
    });
  }

  const fixture = buildModerationMessage("trading this for that", { userId });
  let capturedContext = null;
  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async (context) => {
      capturedContext = context;
      return { attempted: true, verdict: false, answer: "FALSE", model: "test-gemini" };
    },
    now: 2_000
  });

  assert.equal(handled, false);
  assert.deepEqual(capturedContext.userMessages, ["one", "two", "three", "four", "trading this for that"]);
  assert.equal(capturedContext.messageContexts.length, 5);
  assert.equal(capturedContext.messageContexts[1].repliedToMessage.content, "what config are you talking about?");
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

test("scam confidence ladder maps confirmed intent to timeout durations", () => {
  assert.equal(getSellingConfidenceTimeoutMs(91), 24 * 60 * 60 * 1000);
  assert.equal(getSellingConfidenceTimeoutMs(86), 6 * 60 * 60 * 1000);
  assert.equal(getSellingConfidenceTimeoutMs(76), 60 * 60 * 1000);
  assert.equal(getSellingConfidenceTimeoutMs(71), 30 * 60 * 1000);
  assert.equal(getSellingConfidenceTimeoutMs(70), 0);
  assert.equal(getSellingConfidenceTimeoutMs(69), 0);
  assert.equal(getSellingConfidenceTimeoutTier(88)?.threshold, 85);
});

test("AI-confirmed moderate-confidence scam/trade gets the 30 minute tier", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("dms", {
    referencedContent: "where is executor link"
  });

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => ({ attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" })
  });

  assert.equal(handled, true);
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 30 * 60 * 1000);
  assert.match(fixture.logs[0].body, /confidence 72% > 70% => timeout 30m/i);
});

test("AI-confirmed low-confidence scam/trade keeps repeat fallback instead of instant mute", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("trading this for that");

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    classifyScam: async () => ({ attempted: true, verdict: true, answer: "TRUE", model: "test-gemini" })
  });

  assert.equal(handled, true);
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.timeouts.length, 0);
  assert.match(fixture.logs[0].header, /Scam\/Trade Alert/i);
  assert.match(fixture.logs[0].body, /below immediate-timeout confidence/i);
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
  assert.equal(fixture.deleted.length, 1);
  assert.equal(fixture.replies.length, 1);
  assert.equal(typeof fixture.replies[0].content, "string");
  assert.ok(fixture.replies[0].content.trim().length > 0);
  assert.doesNotMatch(fixture.replies[0].content, /\b(?:staff|ping|log|logs)\b/i);
  assert.equal(fixture.logs.length, 1);
  assert.match(fixture.logs[0].header, /Scam\/Trade Timeout/i);
  assert.match(fixture.logs[0].body, /Confidence:\*\* \d+%/i);
  assert.doesNotMatch(fixture.logs[0].body, /Confidence:\*\* 88%/i);
  assert.match(fixture.logs[0].body, /delete queued 1 msg/i);
  assert.match(fixture.logs[0].body, /confidence \d+% > 90% => timeout 1d/i);
  assert.doesNotMatch(fixture.logs[0].body, /Staff Tools/i);
  assert.match(fixture.logs[0].extra, /Context \+ undo controls expire/i);
  const buttons = getPanelButtonJson(fixture.logs[0]);
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].label, "View Context");
  assert.equal(buttons[1].label, "Undo Timeout");
  assert.equal(buttons[1].disabled, false);
  const actionId = getActionIdFromPanel(fixture.logs[0], MODLOG_REVERT_PREFIX);
  const action = await getModerationAction(actionId);
  assert.equal(action.actionType, "scam_trade");
  assert.equal(action.timeoutApplied, true);
  assert.equal(action.deleteApplied, true);
  assert.match(action.messageContent, /selling ue/i);
  assert.equal(action.recentMessages.length, 1);
  assert.equal(action.recentMessages[0].messageId, "message-1");
  assert.equal(fixture.timeouts.length, 1);
  assert.equal(fixture.timeouts[0].durationMs, 24 * 60 * 60 * 1000);
  assert.equal(fixture.dms.length, 1);
  assert.match(fixture.dms[0].embeds[0].data.description, /scam\/trade behavior/i);

  const snapshot = await getDailyStatsSnapshot();
  const sellingTimeout = snapshot.moderation.find((entry) => entry.eventKey === "selling_timeout");
  assert.equal(sellingTimeout?.eventCount, 1);
});

test("moderation action logs evidence before deleting the user's last three messages", async () => {
  await clearDailyStatsTracking(1);
  const userId = "cleanup-user";
  const channelId = "cleanup-channel";
  const events = [];
  const first = buildModerationMessage("normal chat one", { userId, channelId, messageId: "msg-1" });
  const second = buildModerationMessage("normal chat two", { userId, channelId, messageId: "msg-2" });
  const third = buildModerationMessage("selling ue for 1 bucks", { userId, channelId, messageId: "msg-3" });

  first.message.delete = async () => {
    events.push("delete-1");
    first.deleted.push(true);
  };
  second.message.delete = async () => {
    events.push("delete-2");
    second.deleted.push(true);
  };
  third.message.delete = async () => {
    events.push("delete-3");
    third.deleted.push(true);
  };

  await maybeHandleModerationWatch(first.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: first.sendLog,
    now: 1000
  });
  await maybeHandleModerationWatch(second.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: second.sendLog,
    now: 2000
  });

  const handled = await maybeHandleModerationWatch(third.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: async (_guild, panel) => {
      events.push("log");
      assert.equal(first.deleted.length, 0);
      assert.equal(second.deleted.length, 0);
      assert.equal(third.deleted.length, 0);
      third.logs.push(panel);
      return true;
    },
    now: 3000
  });

  assert.equal(handled, true);
  assert.deepEqual(events, ["log", "delete-1", "delete-2", "delete-3"]);
  assert.equal(first.deleted.length, 1);
  assert.equal(second.deleted.length, 1);
  assert.equal(third.deleted.length, 1);
  assert.match(third.logs[0].body, /delete queued 3 msgs/i);
  const action = await getModerationAction(getActionIdFromPanel(third.logs[0], MODLOG_REVERT_PREFIX), { now: 3000 });
  assert.deepEqual(action.recentMessages.map((entry) => entry.messageId), ["msg-1", "msg-2", "msg-3"]);
});

test("moderation log view button shows captured and visible user context", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling ue for 1 bucks", {
    channelId: "channel-context"
  });
  const now = 10_000_000;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now
  });
  assert.equal(handled, true);

  fixture.message.guild.channels.cache.set("channel-context", {
    messages: {
      fetch: async () => new Map([
        ["visible-1", {
          id: "visible-1",
          content: "visible still here",
          author: fixture.message.author,
          createdTimestamp: now + 1000,
          url: "https://discord.com/channels/guild-1/channel-context/visible-1"
        }],
        ["other-user", {
          id: "other-user",
          content: "not this user",
          author: { id: "someone-else" },
          createdTimestamp: now + 2000
        }]
      ])
    }
  });

  const viewId = getPanelButtonCustomIds(fixture.logs[0]).find((id) => id.startsWith(MODLOG_VIEW_PREFIX));
  const ui = buildModerationLogInteraction(viewId, fixture);
  const consumed = await maybeHandleModerationLogInteraction(ui.interaction, { now });

  assert.equal(consumed, true);
  assert.equal(ui.replies.length, 1);
  const description = ui.replies[0].embeds[0].data.description;
  assert.match(ui.replies[0].embeds[0].data.title, /User Message Context/i);
  assert.match(description, /selling ue for 1 bucks/i);
  assert.match(description, /visible still here/i);
  assert.doesNotMatch(description, /Original Jump/i);
  assert.match(description, /Saved Evidence/i);
});

test("staff can revert a moderation timeout from the log button", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling ue for 1 bucks");
  const now = 20_000_000;

  const handled = await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now
  });
  assert.equal(handled, true);

  const actionId = getActionIdFromPanel(fixture.logs[0], MODLOG_REVERT_PREFIX);
  const revertCustomId = `${MODLOG_REVERT_PREFIX}${actionId}`;
  const ui = buildModerationLogInteraction(revertCustomId, fixture);
  const consumed = await maybeHandleModerationLogInteraction(ui.interaction, {
    sendLog: ui.sendLog,
    now
  });

  assert.equal(consumed, true);
  assert.equal(fixture.timeouts.length, 2);
  assert.equal(fixture.timeouts[1].durationMs, null);
  assert.equal(await getModerationAction(actionId, { now }), null);
  assert.equal(ui.edits.length, 1);
  const disabledButtons = ui.edits[0].components[0].toJSON().components;
  assert.equal(disabledButtons[0].disabled, true);
  assert.equal(disabledButtons[1].disabled, true);
  assert.equal(ui.logPanels.length, 1);
  assert.match(ui.logPanels[0].header, /Moderation Action Reverted/i);
  assert.equal(fixture.dms.length, 2);
  assert.match(fixture.dms[1].embeds[0].data.description, /Your action was reverted by: <@staff-user>/i);
  assert.match(fixture.dms[1].embeds[0].data.description, /Sorry for the mistake on my end/i);
});

test("non-staff cannot use moderation log controls", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling ue for 1 bucks");
  const now = 25_000_000;

  await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now
  });

  const actionId = getActionIdFromPanel(fixture.logs[0], MODLOG_REVERT_PREFIX);
  const ui = buildModerationLogInteraction(`${MODLOG_REVERT_PREFIX}${actionId}`, fixture, {
    roleIds: [],
    userId: "regular-clicker"
  });
  const consumed = await maybeHandleModerationLogInteraction(ui.interaction, { now });

  assert.equal(consumed, true);
  assert.equal(fixture.timeouts.length, 1);
  assert.ok(await getModerationAction(actionId, { now }));
  assert.match(ui.replies[0].embeds[0].data.description, /only staff/i);
  assert.equal(ui.logPanels.length, 0);
});

test("expired moderation action reviews are cleaned and buttons retire", async () => {
  await clearDailyStatsTracking(1);
  const fixture = buildModerationMessage("selling ue for 1 bucks");
  const now = 30_000_000;

  await maybeHandleModerationWatch(fixture.message, {
    kb,
    runtimeStatus: "UP",
    sendLog: fixture.sendLog,
    now
  });

  const actionId = getActionIdFromPanel(fixture.logs[0], MODLOG_REVERT_PREFIX);
  assert.ok(await getModerationAction(actionId, { now }));

  await cleanupExpiredModerationActions({ now: now + 12 * 60 * 60 * 1000 + 1 });
  assert.equal(await getModerationAction(actionId, { now }), null);

  const ui = buildModerationLogInteraction(`${MODLOG_VIEW_PREFIX}${actionId}`, fixture);
  const consumed = await maybeHandleModerationLogInteraction(ui.interaction, {
    now: now + 12 * 60 * 60 * 1000 + 1
  });
  assert.equal(consumed, true);
  assert.equal(ui.edits.length, 1);
  assert.match(ui.replies[0].embeds[0].data.description, /expired|resolved/i);
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

test("content filter rule database adds, lists, disables, and snapshots custom rules", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);

  const added = await addContentFilterRule({
    term: "custom bad term",
    category: "custom",
    normalizedKey: "custombadterm",
    createdBy: "staff-user"
  });
  assert.equal(added.added, true);
  assert.equal(added.rule.createdBy, "staff-user");

  const rulesAfterAdd = await listContentFilterRules();
  assert.equal(rulesAfterAdd.length, 1);
  assert.equal(rulesAfterAdd[0].term, "custom bad term");

  const snapshotAfterAdd = await getRestrictedEmojiDatabaseSnapshot();
  assert.equal(snapshotAfterAdd.tableCounts.contentFilterRules, 1);

  const removed = await removeContentFilterRuleById(added.rule.id);
  assert.equal(removed.removed, true);
  assert.equal((await listContentFilterRules()).length, 0);

  const withDisabled = await listContentFilterRules({ includeDisabled: true });
  assert.equal(withDisabled.length, 1);
  assert.equal(withDisabled[0].enabled, false);
});

test("bot presence state persists in app config and resets to default", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);

  assert.equal(await getBotPresenceState(), "Monitoring ;)");

  const stored = await setBotPresenceState(" V3\nGuard online ");
  assert.equal(stored, "V3 Guard online");
  assert.equal(await getBotPresenceState(), "V3 Guard online");

  const snapshot = await getRestrictedEmojiDatabaseSnapshot();
  assert.equal(snapshot.tableCounts.appConfig >= 2, true);

  const reset = await resetBotPresenceState();
  assert.equal(reset, "Monitoring ;)");
  assert.equal(await getBotPresenceState(), "Monitoring ;)");
});

test("channel settings persist in app config and hydrate runtime cache", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);

  const defaultGeneral = getConfiguredChannelId("general");
  assert.equal(defaultGeneral, "1498745066339045406");

  const updated = await setChannelSetting("general", "222222222222222222");
  assert.equal(updated.key, "general");
  assert.equal(updated.id, "222222222222222222");
  assert.equal(updated.source, "custom");
  assert.equal(getConfiguredChannelId("general"), "222222222222222222");

  resetChannelConfigCache();
  assert.equal(getConfiguredChannelId("general"), defaultGeneral);

  await hydrateChannelSettings();
  assert.equal(getConfiguredChannelId("general"), "222222222222222222");

  const settings = await listChannelSettings();
  assert.equal(settings.find((entry) => entry.key === "general")?.source, "custom");

  const reset = await resetChannelSetting("general");
  assert.equal(reset.id, defaultGeneral);
  assert.equal(reset.source, "default");
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
  assert.match(fixture.logs[0].toJSON().title, /Restricted Reaction Warning/i);

  const snapshot = await getDailyStatsSnapshot();
  const reactionAlert = snapshot.moderation.find((entry) => entry.eventKey === "restricted_reaction_alert");
  assert.equal(reactionAlert?.eventCount, 1);
});
