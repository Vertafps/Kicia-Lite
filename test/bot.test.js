process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");

const { isNoResponseChannel, isNoResponseMessage } = require("../src/channel-policy");
const { maybeHandleControlCommand } = require("../src/handlers/commands");
const { normalizeKb } = require("../src/kb");
const { classifyTranscript } = require("../src/router");
const { getCooldownReaction, markGuildReply, resetCooldowns } = require("../src/handlers/cooldown");
const { maybeHandleLockCommand, parseLockCommand } = require("../src/handlers/lockdown");
const { isOwnerCommandMessage, maybeHandleStatusCommand, shouldAutoReplyStatus } = require("../src/handlers/status");
const { resetRuntimeStatus, getRuntimeStatus } = require("../src/runtime-status");

const kb = normalizeKb({
  executors: {
    supported: [
      {
        name: "Isaeva",
        aliases: ["isaeva", "isava"],
        type: "paid",
        compatibility: "fully compatible, recommended",
        link: "https://getisaeva.xyz/"
      },
      {
        name: "Potassium",
        aliases: ["potassium", "pot"],
        type: "paid",
        compatibility: "fully compatible",
        link: "https://potassium.pro/"
      },
      {
        name: "Yub X",
        aliases: ["yub x", "yub-x", "yubx", "yub"],
        type: "free",
        compatibility: "fully compatible",
        link: "https://yub-x.com/",
        notes: ["Uses a key system."]
      },
      {
        name: "Madium",
        aliases: ["madium", "mad"],
        type: "free",
        compatibility: "fully compatible",
        link: "https://discord.gg/olemad"
      },
      {
        name: "Synapse Z",
        aliases: ["synapse z", "synz"],
        type: "paid",
        compatibility: "fully compatible",
        link: "https://discord.gg/synz"
      },
      {
        name: "Velocity Pro",
        aliases: ["velocity pro", "vpro"],
        type: "paid",
        compatibility: "fully compatible",
        link: "https://example.com/velocity-pro"
      }
    ],
    temporarily_not_working: [{ name: "Solar", aliases: ["solar"] }],
    not_recommended: [
      {
        name: "Delta",
        aliases: ["delta"],
        link: "https://deltaexploits.gg/",
        reply: "Delta is experimental and can freeze after a few matches."
      },
      {
        name: "Cosmic",
        aliases: ["cosmic"],
        link: "https://discord.gg/getcosmic",
        reply: "Cosmic is experimental and may work, but is not officially supported."
      }
    ],
    unsupported: [
      {
        name: "Wave",
        aliases: ["wave"],
        reply: "Wave is unsupported and does not work with KiciaHook."
      }
    ]
  },
  issues: [
    {
      title: "GUI Not Loading / Security Kick 1 / FPS Drops / Lag / Lobby Issue",
      category: "executor",
      keywords: ["freeze", "freezes", "lobby", "gui not loading"],
      match_phrases: ["gui not loading", "no gui"]
    },
    {
      title: "How to Load a Config",
      category: "config",
      keywords: [
        "load config",
        "import config",
        "config not showing",
        "where do i put config",
        "where to put config",
        "use config",
        "apply config",
        "add config"
      ],
      match_phrases: [
        "load config",
        "import config",
        "where do i put config",
        "how to put config",
        "i have a config",
        "got a config how to"
      ]
    },
    {
      title: "How to Get a Key and Get Whitelisted (Free and Premium)",
      category: "key",
      keywords: [
        "how to get key",
        "how to get free key",
        "get key",
        "free key",
        "premium key",
        "key system"
      ],
      match_phrases: [
        "how to get key",
        "how to get free key",
        "get key",
        "get free key",
        "how do i get a key"
      ]
    },
    {
      title: "Account Transfers / Discord Server Ban",
      category: "support_only",
      keywords: ["account transfer", "discord ban", "server ban"],
      match_phrases: ["account transfer", "server ban"]
    },
    {
      title: "Difference Between Free and Premium",
      category: "product",
      keywords: ["free vs premium", "premium features", "why premium"],
      match_phrases: ["free vs premium"]
    },
    {
      title: "Lost a Fight While Using Premium",
      category: "config",
      keywords: ["premium lost fight", "bad config", "premium weak"],
      match_phrases: ["premium bad"]
    },
    {
      title: "Banned / Detected",
      category: "ban",
      keywords: [
        "banned",
        "detected",
        "anticheat ban",
        "mod ban",
        "banned for no reason",
        "got banned",
        "kicia detected",
        "account banned",
        "i got banned"
      ],
      match_phrases: [
        "got banned",
        "i got banned",
        "random ban",
        "anticheat ban",
        "mod ban",
        "i got banned with only kicia",
        "is kicia detected",
        "will i get banned"
      ]
    },
    {
      title: "Silent Aim, Rage, and Projectile TP Not Working",
      category: "feature",
      keywords: ["silent aim", "rage", "projectile tp", "patched", "anticheat", "not working", "broken"],
      match_phrases: [
        "silent aim not working",
        "rage not working",
        "projectile tp broken",
        "projectile tp not working",
        "features not working"
      ]
    },
    {
      title: "Script Panel Link / Where to Get Script",
      category: "script",
      keywords: ["where is script", "where panel", "panel link", "script link", "where to get script", "get script"],
      match_phrases: ["where is the script", "where do i get script", "panel link", "script panel", "how to get the script"]
    },
    {
      title: "GUI Layout Guide",
      category: "gui",
      keywords: [
        "where is",
        "gui layout",
        "which tab",
        "what tab",
        "where to find",
        "where can i find",
        "which menu"
      ],
      match_phrases: [
        "where is",
        "where do i find",
        "which tab",
        "where is legitbot",
        "where is silent aim",
        "where is anti aim",
        "where is triggerbot",
        "where is esp"
      ],
      reply:
        "Combat: Legitbot, Silent Aim, Triggerbot, Rage. Visuals: ESP. Misc: Fly, Walkspeed, No Spread."
    }
  ]
});

function buildMockLockChannel(id, { sendMessagesState = null, botPermissions = [], failEdit = false } = {}) {
  let state = sendMessagesState;
  let editCalls = 0;

  return {
    id,
    permissionsFor: () => new PermissionsBitField(botPermissions),
    permissionOverwrites: {
      cache: {
        get: () => {
          if (state === null) return null;
          return {
            allow: {
              has: (permission) => state === true && permission === PermissionFlagsBits.SendMessages
            },
            deny: {
              has: (permission) => state === false && permission === PermissionFlagsBits.SendMessages
            }
          };
        }
      },
      edit: async (_roleId, options) => {
        editCalls += 1;
        if (failEdit) throw Object.assign(new Error("missing access"), { code: 50013 });
        state = options.SendMessages ?? null;
        return null;
      }
    },
    getSendMessagesState: () => state,
    getEditCalls: () => editCalls
  };
}

function buildLockCommandMessage(content, {
  authorId = "mod-user",
  roleIds = ["1484221158390890496"],
  displayName = "Kernel",
  channels = []
} = {}) {
  const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
  const reactions = [];
  const replies = [];

  return {
    content,
    author: {
      id: authorId,
      username: displayName.toLowerCase(),
      tag: `${displayName}#0001`
    },
    member: {
      displayName,
      roles: {
        cache: {
          has: (roleId) => roleIds.includes(roleId)
        }
      }
    },
    guild: {
      members: {
        me: { id: "bot-user" }
      },
      channels: {
        cache: {
          get: (id) => channelMap.get(id) || null
        },
        fetch: async (id) => channelMap.get(id) || null
      }
    },
    inGuild: () => true,
    react: async (emoji) => {
      reactions.push(emoji);
    },
    reply: async (payload) => {
      replies.push(payload);
    },
    get reactions() {
      return reactions;
    },
    get replies() {
      return replies;
    }
  };
}

test.afterEach(() => {
  resetCooldowns();
  resetRuntimeStatus();
});

test("routes supported executor by canonical name", () => {
  const route = classifyTranscript("is potassium supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /Potassium is supported/i);
});

test("routes supported executor by alias", () => {
  const route = classifyTranscript("is isava supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /Isaeva is supported and recommended/i);
});

test("routes recommended executor distinctly", () => {
  const route = classifyTranscript("is isaeva supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /recommended/i);
});

test("routes good with kiciahook wording as executor support", () => {
  const route = classifyTranscript("is potassium good with kiciahook", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /Potassium/i);
  assert.match(route.body, /supported/i);
});

test("routes not recommended executor as still working", () => {
  const route = classifyTranscript("is delta supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /can still work/i);
  assert.match(route.body, /not one we recommend/i);
});

test("routes unsupported executor", () => {
  const route = classifyTranscript("is wave supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /isn't supported/i);
});

test("routes unknown executor with clear support intent", () => {
  const route = classifyTranscript("is phantom supported", kb, "UP");
  assert.equal(route.kind, "executor_unknown");
  assert.match(route.body, /not in the documentation/i);
});

test("handles bad executor wording like does cosmic executor works", () => {
  const route = classifyTranscript("does cosmic executor works", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /Cosmic can still work/i);
});

test("shows executor info for get/download style questions", () => {
  const route = classifyTranscript("how can i get yub-x ececutor", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /### Yub X/i);
  assert.match(route.body, /supported/i);
  assert.match(route.body, /\*\*Type:\*\* free/i);
  assert.match(route.tip || "", /Open Yub X/i);
  assert.match(route.tip || "", /yub-x\.com/i);
});

test("slightly rough long executor typos still resolve", () => {
  const route = classifyTranscript("does pottasium work", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /### Potassium/i);
});

test("bare exact executor alias routes to executor info", () => {
  const route = classifyTranscript("yub x", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /### Yub X/i);
});

test("bare executor mention with executor word routes to executor info", () => {
  const route = classifyTranscript("yub-x executor", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /### Yub X/i);
});

test("short ambiguous alias alone does not hijack routing", () => {
  const route = classifyTranscript("mad", kb, "UP");
  assert.equal(route.kind, "ticket");
});

test("handles does kicia support codex as an unknown executor question", () => {
  const route = classifyTranscript("does kicia support codex", kb, "UP");
  assert.equal(route.kind, "executor_unknown");
});

test("shows recommended executor picks when asked", () => {
  const route = classifyTranscript("what executors are recommended", kb, "UP");
  assert.equal(route.kind, "executor_list");
  assert.match(route.body, /point to first/i);
  assert.match(route.body, /Isaeva/i);
  assert.match(route.body, /Potassium/i);
  assert.match(route.body, /Yub X/i);
  assert.match(route.body, /Madium/i);
  assert.match(route.body, /Synapse Z/i);
  assert.match(route.body, /Velocity Pro/i);
  assert.doesNotMatch(route.body, /and \d+ more in docs/i);
});

test("shows free supported executor picks when asked", () => {
  const route = classifyTranscript("best free executor", kb, "UP");
  assert.equal(route.kind, "executor_list");
  assert.match(route.body, /point to first/i);
  assert.match(route.body, /Yub X/i);
});

test("non recommended executor suggestions show multiple supported picks once", () => {
  const route = classifyTranscript("is wave supported", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /Better picks rn/i);
  assert.equal((route.body.match(/Better picks rn/g) || []).length, 1);
  assert.match(route.body, /Isaeva/i);
  assert.match(route.body, /Potassium/i);
  assert.match(route.body, /Yub X/i);
  assert.equal(route.tip, undefined);
});

test("executor names without support intent do not hijack issue matching", () => {
  const route = classifyTranscript("delta gui freezes in lobby", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /GUI Not Loading/i);
});

test("routes status questions for down wording", () => {
  const route = classifyTranscript("is kicia down", kb, "UP");
  assert.equal(route.kind, "status");
  assert.match(route.body, /status says it's up rn/i);
  assert.match(route.body, /1497703492012347412/);
  assert.match(route.body, /\$status/);
});

test("routes status questions for up wording", () => {
  const route = classifyTranscript("kicia up?", kb, "DOWN");
  assert.equal(route.kind, "status");
  assert.match(route.body, /status says it's down rn/i);
});

test("routes does kicia work as status instead of executor", () => {
  const route = classifyTranscript("does kicia work", kb, "UP");
  assert.equal(route.kind, "status");
  assert.match(route.body, /status says it's up rn/i);
});

test("routes does kiciahook work as status instead of executor", () => {
  const route = classifyTranscript("does kiciahook work", kb, "DOWN");
  assert.equal(route.kind, "status");
  assert.match(route.body, /status says it's down rn/i);
});

test("routes bare works as status instead of docs", () => {
  const route = classifyTranscript("works", kb, "UP");
  assert.equal(route.kind, "status");
  assert.match(route.body, /status says it's up rn/i);
});

test("latest bare works line wins over older docs-looking transcript", () => {
  const route = classifyTranscript("gui not loading\nworks", kb, "UP");
  assert.equal(route.kind, "status");
  assert.match(route.body, /status says it's up rn/i);
});

test("executor routing prioritizes the most recent explicit question", () => {
  const route = classifyTranscript("does madium work\n@kicialite does delta work", kb, "UP");
  assert.equal(route.kind, "executor");
  assert.match(route.body, /Delta can still work/i);
});

test("docs titles vary deterministically by match context", () => {
  const routeA = classifyTranscript("gui not loading", kb, "UP");
  const routeB = classifyTranscript("load config", kb, "UP");
  const routeARepeat = classifyTranscript("gui not loading", kb, "UP");

  assert.equal(routeA.kind, "docs");
  assert.equal(routeB.kind, "docs");
  assert.equal(routeA.header, routeARepeat.header);
  assert.notEqual(routeA.header, routeB.header);
});

test("ticket titles vary deterministically by transcript context", () => {
  const routeA = classifyTranscript("premium", kb, "UP");
  const routeB = classifyTranscript("some random weird thing", kb, "UP");
  const routeARepeat = classifyTranscript("premium", kb, "UP");

  assert.equal(routeA.kind, "ticket");
  assert.equal(routeB.kind, "ticket");
  assert.equal(routeA.header, routeARepeat.header);
  assert.notEqual(routeA.header, routeB.header);
});

test("non-status phrases that mention kicia do not trigger status mode", () => {
  const route = classifyTranscript("kicia gui freezes in lobby", kb, "UP");
  assert.equal(route.kind, "docs");
});

test("down note only appends to normal replies while down", () => {
  const docsRoute = classifyTranscript("gui not loading", kb, "DOWN");
  assert.equal(docsRoute.kind, "docs");
  assert.match(docsRoute.extra, /kiciahook is down rn/i);

  const statusRoute = classifyTranscript("status?", kb, "DOWN");
  assert.equal(statusRoute.kind, "status");
  assert.equal(statusRoute.extra, undefined);
});

test("exact issue phrase hits docs", () => {
  const route = classifyTranscript("gui not loading", kb, "UP");
  assert.equal(route.kind, "docs");
});

test("fuzzy natural phrasing can still hit docs", () => {
  const route = classifyTranscript("gui freezes in lobby", kb, "UP");
  assert.equal(route.kind, "docs");
});

test("messy typos can still hit docs", () => {
  const route = classifyTranscript("gui frezes in loby", kb, "UP");
  assert.equal(route.kind, "docs");
});

test("latest clear docs line wins over an older different kb match", () => {
  const route = classifyTranscript("load config\ngui not loading", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /GUI Not Loading/i);
});

test("latest config line wins over an older different kb match", () => {
  const route = classifyTranscript("gui not loading\nload config", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /How to Load a Config/i);
});

test("config questions do not get hijacked by key docs", () => {
  for (const prompt of ["how to get config", "how do i get config", "@Kiciahook how to get config"]) {
    const route = classifyTranscript(prompt, kb, "UP");
    assert.equal(route.kind, "docs");
    assert.match(route.body, /How to Load a Config/i);
  }
});

test("key questions still route to key docs", () => {
  const route = classifyTranscript("how to get key", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /How to Get a Key/i);
});

test("feature work questions do not become unknown executor replies", () => {
  const route = classifyTranscript("does silent aim work", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /Silent Aim, Rage, and Projectile TP Not Working/i);
});

test("exact keyword phrases can route short docs questions", () => {
  const route = classifyTranscript("where panel", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /Script Panel Link/i);
});

test("fresh vague question does not inherit an older docs match from transcript", () => {
  const route = classifyTranscript("load config\nhow to do lootlabs", kb, "UP");
  assert.equal(route.kind, "ticket");
});

test("ban questions with messy wording still hit docs", () => {
  const route = classifyTranscript("do you get banned for using free script", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /Banned \/ Detected/i);
});

test("feature existence questions can route to the gui layout guide", () => {
  const route = classifyTranscript("does kicia have rage", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /GUI Layout Guide/i);
});

test("where is esp routes to the gui layout guide", () => {
  const route = classifyTranscript("where is esp", kb, "UP");
  assert.equal(route.kind, "docs");
  assert.match(route.body, /GUI Layout Guide/i);
});

test("vague one word input falls back to ticket", () => {
  const route = classifyTranscript("premium", kb, "UP");
  assert.equal(route.kind, "ticket");
});

test("support only issue routes to ticket", () => {
  const route = classifyTranscript("account transfer", kb, "UP");
  assert.equal(route.kind, "ticket");
  assert.equal(route.reason, "support_only");
});

test("same user inside 30 seconds gets user cooldown reaction", () => {
  markGuildReply("user-a", 1_000);
  assert.equal(getCooldownReaction("user-a", 10_000), "🧊");
});

test("different user inside 5 seconds gets global cooldown reaction", () => {
  markGuildReply("user-a", 1_000);
  assert.equal(getCooldownReaction("user-b", 4_000), "🚧");
});

test("parses lock command aliases", () => {
  assert.equal(parseLockCommand("$lock"), "lock");
  assert.equal(parseLockCommand("$lockdown"), "lock");
  assert.equal(parseLockCommand("$lock on"), "lock");
  assert.equal(parseLockCommand("$unlock"), "unlock");
  assert.equal(parseLockCommand("$lock off"), "unlock");
  assert.equal(parseLockCommand("$lock status"), "status");
  assert.equal(parseLockCommand("$lock check"), "status");
  assert.equal(parseLockCommand("$lock state"), "status");
});

test("unauthorized users only get a cross reaction for lock commands", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const message = buildLockCommandMessage("$lock", {
    authorId: "random-user",
    roleIds: [],
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.deepEqual(message.reactions, ["❌"]);
  assert.equal(message.replies.length, 0);
});

test("lock command disables send messages for the member role in both channels", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    sendMessagesState: true,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    sendMessagesState: true,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const message = buildLockCommandMessage("$lockdown", {
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.equal(general.getSendMessagesState(), false);
  assert.equal(support.getSendMessagesState(), false);
  assert.match(message.replies[0].embeds[0].data.description, /locked channels/i);
  assert.match(message.replies[0].embeds[0].data.description, /1498745066339045406/);
  assert.match(message.replies[0].embeds[0].data.description, /1489747706980339773/);
});

test("$lock no longer toggles and stays locked when both channels are already locked", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    sendMessagesState: false,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    sendMessagesState: false,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const message = buildLockCommandMessage("$lock", {
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.equal(general.getSendMessagesState(), false);
  assert.equal(support.getSendMessagesState(), false);
  assert.match(message.replies[0].embeds[0].data.description, /already locked/i);
});

test("explicit lock command reports when channels are already locked", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    sendMessagesState: false,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    sendMessagesState: false,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const message = buildLockCommandMessage("$lock on", {
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.match(message.replies[0].embeds[0].data.description, /already locked/i);
});

test("explicit unlock command reports when channels are already unlocked", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    sendMessagesState: true,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    sendMessagesState: true,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const message = buildLockCommandMessage("$unlock", {
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.equal(general.getSendMessagesState(), true);
  assert.equal(support.getSendMessagesState(), true);
  assert.equal(general.getEditCalls(), 0);
  assert.equal(support.getEditCalls(), 0);
  assert.match(message.replies[0].embeds[0].data.description, /already unlocked/i);
});

test("unlock command restores denied channels to explicit allow overwrites", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    sendMessagesState: false,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    sendMessagesState: false,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const message = buildLockCommandMessage("$unlock", {
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.equal(general.getSendMessagesState(), true);
  assert.equal(support.getSendMessagesState(), true);
  assert.match(message.replies[0].embeds[0].data.description, /unlocked channels/i);
  assert.match(message.replies[0].embeds[0].data.description, /\*\*Changed:\*\* 2/i);
});

test("lock status reports per-channel permission state without changing channels", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    sendMessagesState: false,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    sendMessagesState: null,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const message = buildLockCommandMessage("$lock status", {
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.equal(general.getEditCalls(), 0);
  assert.equal(support.getEditCalls(), 0);
  assert.match(message.replies[0].embeds[0].data.description, /channel lock status/i);
  assert.match(message.replies[0].embeds[0].data.description, /general chat.*locked/is);
  assert.match(message.replies[0].embeds[0].data.description, /community support chat.*neutral/is);
});

test("lock command reports missing bot permissions before changing anything", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    sendMessagesState: true,
    botPermissions: [PermissionFlagsBits.ViewChannel]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    sendMessagesState: true,
    botPermissions: [PermissionFlagsBits.ViewChannel]
  });
  const message = buildLockCommandMessage("$lockdown", {
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.equal(general.getSendMessagesState(), true);
  assert.equal(support.getSendMessagesState(), true);
  assert.match(message.replies[0].embeds[0].data.description, /Manage Channels/i);
  assert.match(message.replies[0].embeds[0].data.description, /Manage Roles/i);
});

test("lock command rolls back partial permission overwrite failures", async () => {
  const general = buildMockLockChannel("1498745066339045406", {
    sendMessagesState: true,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
  });
  const support = buildMockLockChannel("1489747706980339773", {
    sendMessagesState: true,
    botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles],
    failEdit: true
  });
  const message = buildLockCommandMessage("$lock", {
    channels: [general, support]
  });

  const handled = await maybeHandleLockCommand(message);

  assert.equal(handled, true);
  assert.equal(general.getSendMessagesState(), true);
  assert.equal(support.getSendMessagesState(), true);
  assert.equal(general.getEditCalls(), 2);
  assert.equal(support.getEditCalls(), 1);
  assert.match(message.replies[0].embeds[0].data.description, /rolled back/i);
});

test("owner status command bypasses cooldown logic", async () => {
  markGuildReply("someone-else", 1_000);

  let replied = false;
  const handled = await maybeHandleStatusCommand({
    content: "$status down",
    author: { id: "847703912932311091" },
    reply: async () => {
      replied = true;
    }
  });

  assert.equal(handled, true);
  assert.equal(replied, true);
  assert.equal(getRuntimeStatus(), "DOWN");
});

test("public status command is available to non-owners", async () => {
  let replyPayload = null;

  const handled = await maybeHandleStatusCommand({
    content: "$status",
    author: { id: "not-owner" },
    inGuild: () => true,
    react: async () => {
      throw new Error("should not react");
    },
    reply: async (payload) => {
      replyPayload = payload;
    }
  });

  assert.equal(handled, true);
  assert.ok(replyPayload);
  assert.match(replyPayload.embeds[0].data.description, /status says it's up rn/i);
  assert.equal(replyPayload.components.length, 1);
});

test("generic no-ping working prompt auto-replies with status", async () => {
  let replyPayload = null;

  const handled = await maybeHandleStatusCommand({
    content: "working?",
    author: { id: "user-working" },
    inGuild: () => true,
    react: async () => {
      throw new Error("should not react");
    },
    reply: async (payload) => {
      replyPayload = payload;
    }
  });

  assert.equal(handled, true);
  assert.ok(replyPayload);
  assert.match(replyPayload.embeds[0].data.description, /status channel/i);
});

test("auto status matcher stays focused on actual status prompts", () => {
  assert.equal(shouldAutoReplyStatus("does it work?"), true);
  assert.equal(shouldAutoReplyStatus("working"), true);
  assert.equal(shouldAutoReplyStatus("works"), true);
  assert.equal(shouldAutoReplyStatus("up"), true);
  assert.equal(shouldAutoReplyStatus("down?"), true);
  assert.equal(shouldAutoReplyStatus("still up"), true);
  assert.equal(shouldAutoReplyStatus("work rn"), true);
  assert.equal(shouldAutoReplyStatus("borken"), true);
  assert.equal(shouldAutoReplyStatus("does delta work"), false);
  assert.equal(shouldAutoReplyStatus("gui not working"), false);
});

test("marks the configured general chat as no-response", () => {
  assert.equal(isNoResponseChannel("1498745066339045406"), true);
  assert.equal(isNoResponseChannel("1489747706980339773"), false);
});

test("detects no-response messages only for guild traffic", () => {
  assert.equal(isNoResponseMessage({
    inGuild: () => true,
    channelId: "1498745066339045406"
  }), true);
  assert.equal(isNoResponseMessage({
    inGuild: () => false,
    channelId: "1498745066339045406"
  }), false);
});

test("owner fetch command refreshes kb immediately", async () => {
  let replied = false;
  let refreshCalls = 0;

  const handled = await maybeHandleStatusCommand(
    {
      content: "$fetch",
      author: { id: "847703912932311091" },
      reply: async () => {
        replied = true;
      }
    },
    {
      refreshKb: async () => {
        refreshCalls += 1;
      }
    }
  );

  assert.equal(handled, true);
  assert.equal(refreshCalls, 1);
  assert.equal(replied, true);
});

test("additional owner user id can use owner commands without owner role", async () => {
  let replied = false;
  let refreshCalls = 0;

  const handled = await maybeHandleStatusCommand(
    {
      content: "$fetch",
      author: { id: "648336016469655564" },
      reply: async () => {
        replied = true;
      }
    },
    {
      refreshKb: async () => {
        refreshCalls += 1;
      }
    }
  );

  assert.equal(handled, true);
  assert.equal(refreshCalls, 1);
  assert.equal(replied, true);
});

test("owner role can refresh kb immediately", async () => {
  let replied = false;
  let refreshCalls = 0;

  const handled = await maybeHandleStatusCommand(
    {
      content: "$fetch",
      author: { id: "owner-role-user" },
      member: {
        roles: {
          cache: {
            has: (roleId) => roleId === "1484221158390890496"
          }
        }
      },
      reply: async () => {
        replied = true;
      }
    },
    {
      refreshKb: async () => {
        refreshCalls += 1;
      }
    }
  );

  assert.equal(handled, true);
  assert.equal(refreshCalls, 1);
  assert.equal(replied, true);
});

test("unauthorized fetch command is ignored silently", async () => {
  let replied = false;
  let refreshCalls = 0;

  const handled = await maybeHandleStatusCommand(
    {
      content: "$fetch",
      author: { id: "not-owner" },
      reply: async () => {
        replied = true;
      }
    },
    {
      refreshKb: async () => {
        refreshCalls += 1;
      }
    }
  );

  assert.equal(handled, true);
  assert.equal(refreshCalls, 0);
  assert.equal(replied, false);
});

test("owner fetch command replies cleanly on kb refresh failure", async () => {
  let replied = false;

  const handled = await maybeHandleStatusCommand(
    {
      content: "$fetch",
      author: { id: "847703912932311091" },
      reply: async () => {
        replied = true;
      }
    },
    {
      refreshKb: async () => {
        throw new Error("nope");
      }
    }
  );

  assert.equal(handled, true);
  assert.equal(replied, true);
});

test("jarvis counts as an owner-only command while public status does not", () => {
  assert.equal(isOwnerCommandMessage("$jarvis"), true);
  assert.equal(isOwnerCommandMessage("$status"), false);
  assert.equal(isOwnerCommandMessage("$status down"), true);
});

test("emoji command is available to owner role", async () => {
  let replyPayload = null;
  const handled = await maybeHandleControlCommand({
    content: "$emoji \u{1F62D}",
    author: { id: "owner-role-user" },
    member: {
      roles: {
        cache: {
          has: (roleId) => roleId === "1484221158390890496"
        }
      }
    },
    reply: async (payload) => {
      replyPayload = payload;
    }
  }, {
    listEmojis: async () => [{ display: "\u{1F62D}" }],
    addEmoji: async () => ({ added: true })
  });

  assert.equal(handled, true);
  assert.ok(replyPayload);
  assert.match(replyPayload.embeds[0].data.description, /added/i);
});

test("emoji command is available to staff roles", async () => {
  let replyPayload = null;
  const handled = await maybeHandleControlCommand({
    content: "$emoji \u{1F62D}",
    author: { id: "staff-user" },
    member: {
      roles: {
        cache: {
          has: (roleId) => roleId === "1298767464678559794"
        }
      }
    },
    reply: async (payload) => {
      replyPayload = payload;
    }
  }, {
    listEmojis: async () => [{ display: "\u{1F62D}" }],
    addEmoji: async () => ({ added: true })
  });

  assert.equal(handled, true);
  assert.ok(replyPayload);
  assert.match(replyPayload.embeds[0].data.description, /added/i);
});

test("staff allowlink command adds and removes trusted links", async () => {
  let replyPayload = null;
  const links = [];
  const message = {
    content: "$allowlink example.com/safe",
    author: { id: "staff-user" },
    member: {
      roles: {
        cache: {
          has: (roleId) => roleId === "1298767464678559794"
        }
      }
    },
    reply: async (payload) => {
      replyPayload = payload;
    }
  };
  const deps = {
    listLinks: async () => [...links],
    addLink: async (link) => {
      links.push(link);
      return { added: true, link };
    },
    removeLink: async (key) => {
      const index = links.findIndex((link) => link.key === key);
      const [removed] = index >= 0 ? links.splice(index, 1) : [null];
      return { removed: Boolean(removed), link: removed };
    }
  };

  let handled = await maybeHandleControlCommand(message, deps);
  assert.equal(handled, true);
  assert.equal(links[0].url, "https://example.com/safe");
  assert.match(replyPayload.embeds[0].data.description, /added trusted link/i);

  message.content = "$allowlink";
  handled = await maybeHandleControlCommand(message, deps);
  assert.equal(handled, true);
  assert.match(replyPayload.embeds[0].data.description, /https:\/\/example\.com\/safe/i);

  message.content = "$removelink https://example.com/safe";
  handled = await maybeHandleControlCommand(message, deps);
  assert.equal(handled, true);
  assert.equal(links.length, 0);
  assert.match(replyPayload.embeds[0].data.description, /removed trusted link/i);
});

test("owner whitelist command adds, lists, and removes users", async () => {
  let replyPayload = null;
  const users = [];
  const message = {
    content: "$whitelist <@123456789012345678>",
    author: { id: "847703912932311091" },
    reply: async (payload) => {
      replyPayload = payload;
    }
  };
  const deps = {
    listWhitelist: async () => [...users],
    addWhitelistUser: async (userId, { createdBy }) => {
      const existing = users.find((user) => user.userId === userId);
      if (existing) return { added: false, user: existing };
      const user = { userId, createdAt: 1, createdBy };
      users.push(user);
      return { added: true, user };
    },
    removeWhitelistUser: async (userId) => {
      const index = users.findIndex((user) => user.userId === userId);
      const [removed] = index >= 0 ? users.splice(index, 1) : [null];
      return { removed: Boolean(removed), user: removed };
    }
  };

  let handled = await maybeHandleControlCommand(message, deps);
  assert.equal(handled, true);
  assert.equal(users[0].userId, "123456789012345678");
  assert.equal(users[0].createdBy, "847703912932311091");
  assert.match(replyPayload.embeds[0].data.description, /added/i);
  assert.match(replyPayload.embeds[0].data.description, /lockdown permissions are unchanged/i);

  message.content = "$whitelist";
  handled = await maybeHandleControlCommand(message, deps);
  assert.equal(handled, true);
  assert.match(replyPayload.embeds[0].data.description, /123456789012345678/);

  message.content = "$whitelist remove 123456789012345678";
  handled = await maybeHandleControlCommand(message, deps);
  assert.equal(handled, true);
  assert.equal(users.length, 0);
  assert.match(replyPayload.embeds[0].data.description, /removed/i);
});

test("whitelist command ignores non-owners", async () => {
  let replyPayload = null;
  let addCalls = 0;

  const handled = await maybeHandleControlCommand({
    content: "$whitelist 123456789012345678",
    author: { id: "regular-user" },
    member: {
      roles: {
        cache: {
          has: () => false
        }
      }
    },
    reply: async (payload) => {
      replyPayload = payload;
    }
  }, {
    addWhitelistUser: async () => {
      addCalls += 1;
    }
  });

  assert.equal(handled, true);
  assert.equal(addCalls, 0);
  assert.equal(replyPayload, null);
});

test("owner scam audit command shows recent classifier decisions", async () => {
  let replyPayload = null;

  const handled = await maybeHandleControlCommand({
    content: "$scamaudit 1",
    author: { id: "847703912932311091" },
    reply: async (payload) => {
      replyPayload = payload;
    }
  }, {
    listAudit: async ({ limit }) => {
      assert.equal(limit, 1);
      return [{
        createdAt: 1_700_000_000_000,
        userId: "123456789012345678",
        channelId: "234567890123456789",
        action: "local_true",
        handled: true,
        local: {
          answer: "TRUE",
          model: "local-kicia-intent-v2"
        },
        ai: {},
        messageContent: "dms to buy kicia"
      }];
    }
  });

  assert.equal(handled, true);
  assert.match(replyPayload.embeds[0].data.description, /Scam Audit/i);
  assert.match(replyPayload.embeds[0].data.description, /local_true/i);
  assert.match(replyPayload.embeds[0].data.description, /local-kicia-intent-v2: TRUE/i);
  assert.match(replyPayload.embeds[0].data.description, /dms to buy kicia/i);
});

test("allowlink command ignores non-staff users", async () => {
  let replyPayload = null;
  let addCalls = 0;

  const handled = await maybeHandleControlCommand({
    content: "$allowlink example.com/safe",
    author: { id: "regular-user" },
    member: {
      roles: {
        cache: {
          has: () => false
        }
      }
    },
    reply: async (payload) => {
      replyPayload = payload;
    }
  }, {
    addLink: async () => {
      addCalls += 1;
    }
  });

  assert.equal(handled, true);
  assert.equal(addCalls, 0);
  assert.equal(replyPayload, null);
});

test("database command is owner-only", async () => {
  let replyPayload = null;

  const handled = await maybeHandleControlCommand({
    content: "$db",
    author: { id: "847703912932311091" },
    reply: async (payload) => {
      replyPayload = payload;
    }
  }, {
    getSnapshot: async () => ({
      path: "D:/Downloads/kicia main direction bot/data/restricted-reactions.sqlite",
      emojiTimeoutMs: 10 * 60 * 1000,
      emojis: [{ display: "\u{1F62D}" }],
      dailyStats: {
        windowStartedAt: 1_700_000_000_000
      },
      tableCounts: {
        appConfig: 1,
        restrictedEmojis: 1,
        trustedLinks: 2,
        dailyUsers: 2,
        dailyChannels: 1,
        dailyHours: 1,
        dailyStaff: 1,
        dailyModeration: 3
      }
    })
  });

  assert.equal(handled, true);
  assert.ok(replyPayload);
  assert.match(replyPayload.embeds[0].data.description, /SQLite Database/i);
  assert.match(replyPayload.embeds[0].data.description, /Restricted Emoji Rows:\*\* 1/i);
  assert.match(replyPayload.embeds[0].data.description, /Trusted Link Rows:\*\* 2/i);
  assert.match(replyPayload.embeds[0].data.description, /Daily User Rows:\*\* 2/i);
  assert.match(replyPayload.embeds[0].data.description, /Daily Moderation Rows:\*\* 3/i);
  assert.match(replyPayload.embeds[0].data.description, /remove reaction \+ DM warning/i);
});
