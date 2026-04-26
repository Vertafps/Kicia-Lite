process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits, PermissionsBitField } = require("discord.js");

const { isNoResponseChannel, isNoResponseMessage } = require("../src/channel-policy");
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
      keywords: ["load config", "import config", "config not showing"],
      match_phrases: ["load config", "import config"]
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

function buildMockLockChannel(id, { sendMessagesState = true, botPermissions = [] } = {}) {
  let state = sendMessagesState;

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
        state = options.SendMessages ?? null;
        return null;
      }
    },
    getSendMessagesState: () => state
  };
}

function buildLockCommandMessage(content, {
  authorId = "mod-user",
  roleIds = ["1484218511797784576"],
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
});

test("unauthorized users only get a cross reaction for lock commands", async () => {
  const general = buildMockLockChannel("1484218577589637233", {
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
  const general = buildMockLockChannel("1484218577589637233", {
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
  assert.match(message.replies[0].embeds[0].data.description, /1484218577589637233/);
  assert.match(message.replies[0].embeds[0].data.description, /1489747706980339773/);
});

test("$lock no longer toggles and stays locked when both channels are already locked", async () => {
  const general = buildMockLockChannel("1484218577589637233", {
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
  const general = buildMockLockChannel("1484218577589637233", {
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
  const general = buildMockLockChannel("1484218577589637233", {
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
  assert.match(message.replies[0].embeds[0].data.description, /already unlocked/i);
});

test("lock command reports missing bot permissions before changing anything", async () => {
  const general = buildMockLockChannel("1484218577589637233", {
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

test("public status command replies for non-owners", async () => {
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
  assert.match(replyPayload.embeds[0].data.description, /status says it'?s up rn/i);
  assert.match(replyPayload.embeds[0].data.description, /1497703492012347412/);
  assert.match(replyPayload.embeds[0].data.description, /\$status/);
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
  assert.equal(isNoResponseChannel("1484218577589637233"), true);
  assert.equal(isNoResponseChannel("1489747706980339773"), false);
});

test("detects no-response messages only for guild traffic", () => {
  assert.equal(isNoResponseMessage({
    inGuild: () => true,
    channelId: "1484218577589637233"
  }), true);
  assert.equal(isNoResponseMessage({
    inGuild: () => false,
    channelId: "1484218577589637233"
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

test("jarvis counts as an owner-only command", () => {
  assert.equal(isOwnerCommandMessage("$jarvis"), true);
});
