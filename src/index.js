const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client, Events, GatewayIntentBits, Partials } = require("discord.js");
const { DISCORD_TOKEN, ENABLE_GUILD_MEMBER_EVENTS } = require("./config");
const { isNoResponseMessage } = require("./channel-policy");
const { startDailyStatsScheduler, trackDailyStatsMessage } = require("./daily-stats");
const { buildPanel, DANGER, INFO, WARN } = require("./embed");
const { fetchKb } = require("./kb");
const { refreshScamPulseFeeds } = require("./link-policy");
const { sendLogPanel } = require("./log-channel");
const { applyConfiguredPresenceState } = require("./presence-state");
const { maybeHandleControlCommand } = require("./handlers/commands");
const {
  maybeHandleModerationLogInteraction,
  maybeHandleModerationWatch
} = require("./handlers/moderation");
const { maybeHandleImpersonationCheck } = require("./handlers/impersonation");
const {
  maybeEnforceNicknameMember,
  maybeEnforceNicknameOnMessage,
  maybeHandleNicknameModerationInteraction
} = require("./handlers/nickname-mod");
const { handleDm, handleGuildPing, replyWithError } = require("./handlers/ping");
const { maybeHandleLockCommand } = require("./handlers/lockdown");
const { maybeHandleRoleCommand } = require("./handlers/role-assignment");
const { maybeHandleRestrictedReactionAdd } = require("./handlers/restricted-reactions");
const { maybeHandleStatusCommand } = require("./handlers/status");
const { maybeHandleOutageReviewInteraction } = require("./handlers/outage-review");
const { maybeHandleSweepReviewInteraction } = require("./handlers/sweep-review");
const { maybeHandleGhostPing, recordGhostPingCandidate } = require("./handlers/ghost-ping");
const {
  hydratePendingOutageReviews,
  maybeHandleOutageDetection
} = require("./outage-detector");
const {
  cleanupExpiredModerationActions,
  flushRestrictedEmojiDatabaseNow,
  getBotPresenceState,
  hydrateChannelSettings
} = require("./restricted-emoji-db");
const { recordRuntimeEvent } = require("./runtime-health");
const {
  enableStatusPersistence,
  hydrateRuntimeStatus
} = require("./runtime-status");
const {
  recordStatusTransition,
  getPersistedRuntimeStatus
} = require("./restricted-emoji-db");
const { preloadEmbedder } = require("./embeddings");
const { loadOrBuildKbCache } = require("./kb-embeddings");
const { safeReply } = require("./utils/respond");
const { startStatusWidgetScheduler, refreshStatusWidget } = require("./handlers/status-widget");

enableStatusPersistence({
  recordStatusTransition,
  getPersistedRuntimeStatus,
  onPersistError: (err) => recordRuntimeEvent("warn", "status-transition-persist", err?.message || err)
});

const LOCK_PATH = path.join(os.tmpdir(), "kicialite.lock");

function acquireInstanceLock() {
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    let existingPid;
    try {
      existingPid = Number(fs.readFileSync(LOCK_PATH, "utf8"));
    } catch {}

    if (Number.isInteger(existingPid)) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`Another KiciaLite instance is already running (PID ${existingPid}).`);
      } catch (probeErr) {
        if (probeErr.code !== "ESRCH") throw probeErr;
      }
    }

    try {
      fs.rmSync(LOCK_PATH, { force: true });
      fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
    } catch (rmErr) {
      console.warn("Could not clean up stale lock file:", rmErr.message);
    }
  }
}

function releaseInstanceLock() {
  try {
    flushRestrictedEmojiDatabaseNow();
  } catch (err) {
    console.warn("Could not flush sqlite db on shutdown:", err.message);
  }

  try {
    if (fs.existsSync(LOCK_PATH) && fs.readFileSync(LOCK_PATH, "utf8") === String(process.pid)) {
      fs.rmSync(LOCK_PATH, { force: true });
    }
  } catch {}
}

acquireInstanceLock();
for (const signal of ["SIGINT", "SIGTERM", "exit"]) {
  process.on(signal, () => {
    releaseInstanceLock();
    if (signal !== "exit") process.exit(0);
  });
}

const gatewayIntents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages
];

if (ENABLE_GUILD_MEMBER_EVENTS) {
  gatewayIntents.push(GatewayIntentBits.GuildMembers);
}

const client = new Client({
  intents: gatewayIntents,
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

function isBotPing(message) {
  return !!client.user && message.mentions.users.has(client.user.id);
}

async function sendClientLogPanel(readyClient, panel) {
  const guilds = [...(readyClient.guilds?.cache?.values?.() || [])];
  let sent = false;

  for (const guild of guilds) {
    const didSend = await sendLogPanel(guild, panel).catch(() => false);
    sent = sent || didSend;
  }

  return sent;
}

function buildThreatFeedRefreshPanel({ pulse, initial = false, error = null }) {
  if (error) {
    return {
      header: "Threat Feed Refresh Failed",
      body: [
        "FishFish global URL/domain cache refresh failed; existing cached entries remain in memory until the next successful refresh.",
        `**Error:** ${error}`
      ].join("\n\n"),
      color: WARN
    };
  }

  return {
    header: initial ? "Threat Feed Primed" : "Threat Feed Refreshed",
    body: [
      "FishFish global phishing/malware feed refreshed.",
      `**Domains Cached:** ${pulse.domains}`,
      `**URLs Cached:** ${pulse.urls}`,
      `**Source:** FishFish public phishing/malware lists`,
      `**Next Refresh:** about 1 hour`
    ].join("\n"),
    color: INFO
  };
}

async function refreshAndReportThreatFeed(readyClient, { initial = false } = {}) {
  try {
    const pulse = await refreshScamPulseFeeds();
    console.log(`Threat feed ${initial ? "primed" : "refreshed"}: ${pulse.domains} domains, ${pulse.urls} URLs`);
    await sendClientLogPanel(readyClient, buildThreatFeedRefreshPanel({ pulse, initial }));
    return pulse;
  } catch (err) {
    const message = err?.message || String(err);
    console.warn(`${initial ? "Initial" : "Scheduled"} threat feed refresh failed:`, message);
    recordRuntimeEvent("warn", "threat-feed-refresh", message);
    await sendClientLogPanel(readyClient, buildThreatFeedRefreshPanel({ error: message })).catch(() => false);
    return null;
  }
}

async function cleanupModerationActionReviews() {
  try {
    await cleanupExpiredModerationActions();
  } catch (err) {
    console.warn("Moderation action cleanup failed:", err.message);
    recordRuntimeEvent("warn", "moderation-action-cleanup", err?.message || err);
  }
}

async function applyReadyPresence(readyClient) {
  try {
    const state = await getBotPresenceState();
    await applyConfiguredPresenceState(readyClient.user, state);
    console.log(`Presence state set: ${state}`);
  } catch (err) {
    console.warn("Could not apply bot presence state:", err.message);
    recordRuntimeEvent("warn", "presence-state", err?.message || err);
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ready as ${readyClient.user.tag}`);
  try {
    const channelSettings = await hydrateChannelSettings();
    const customCount = channelSettings.filter((entry) => entry.source === "custom").length;
    console.log(`Channel config loaded: ${customCount} custom override${customCount === 1 ? "" : "s"}`);
  } catch (err) {
    console.warn("Channel config hydrate failed:", err.message);
    recordRuntimeEvent("warn", "channel-config", err?.message || err);
  }
  try {
    const restored = await hydratePendingOutageReviews();
    if (restored > 0) {
      console.log(`Outage reviews restored from disk: ${restored}`);
      recordRuntimeEvent("info", "outage-review-hydrate", `restored ${restored} pending review${restored === 1 ? "" : "s"}`);
    }
  } catch (err) {
    console.warn("Outage review hydrate failed:", err.message);
    recordRuntimeEvent("warn", "outage-review-hydrate", err?.message || err);
  }
  try {
    const restored = await hydrateRuntimeStatus();
    if (restored?.status) {
      console.log(`Runtime status restored: ${restored.status}`);
      recordRuntimeEvent("info", "runtime-status-hydrate", `${restored.status} since ${new Date(restored.sinceAt).toISOString()}`);
    }
  } catch (err) {
    console.warn("Runtime status hydrate failed:", err.message);
    recordRuntimeEvent("warn", "runtime-status-hydrate", err?.message || err);
  }
  await applyReadyPresence(readyClient);
  try {
    const kb = await fetchKb();
    console.log("KB cache primed");
    loadOrBuildKbCache(kb).catch((err) => {
      recordRuntimeEvent("warn", "kb-embed-cache", err?.message || err);
    });
  } catch (err) {
    console.warn("Initial KB fetch failed:", err.message);
  }

  const timer = setInterval(() => {
    fetchKb()
      .then((kb) => loadOrBuildKbCache(kb).catch(() => null))
      .catch((err) => console.warn("Scheduled KB refresh failed:", err.message));
  }, 10 * 60 * 1000);
  timer.unref?.();

  preloadEmbedder().catch(() => null);

  await refreshAndReportThreatFeed(readyClient, { initial: true });

  const pulseTimer = setInterval(() => {
    refreshAndReportThreatFeed(readyClient).catch(() => null);
  }, 60 * 60 * 1000);
  pulseTimer.unref?.();

  try {
    startStatusWidgetScheduler(readyClient);
    await refreshStatusWidget(readyClient).catch(() => null);
  } catch (err) {
    recordRuntimeEvent("warn", "status-widget-start", err?.message || err);
  }

  await cleanupModerationActionReviews();
  const moderationActionCleanupTimer = setInterval(() => {
    cleanupModerationActionReviews().catch(() => null);
  }, 60 * 60 * 1000);
  moderationActionCleanupTimer.unref?.();

  try {
    const statsSchedule = await startDailyStatsScheduler(readyClient);
    console.log(`Daily stats scheduled for ${new Date(statsSchedule.nextBoundary).toISOString()}`);
  } catch (err) {
    console.warn("Daily stats scheduler failed to start:", err.message);
    recordRuntimeEvent("error", "daily-stats-scheduler", err?.message || err);
  }
});

client.on(Events.Error, (err) => {
  console.error("Discord client error:", err);
  recordRuntimeEvent("error", "discord-client", err?.message || err);
});

client.on(Events.Warn, (warning) => {
  console.warn("Discord client warning:", warning);
  recordRuntimeEvent("warn", "discord-client", warning);
});

client.on(Events.ShardError, (err, shardId) => {
  console.error(`Discord shard ${shardId} error:`, err);
  recordRuntimeEvent("error", `discord-shard-${shardId}`, err?.message || err);
});

client.on(Events.Invalidated, () => {
  console.error("Discord session invalidated");
  recordRuntimeEvent("error", "discord-session", "session invalidated");
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  recordRuntimeEvent("error", "unhandled-rejection", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  recordRuntimeEvent("error", "uncaught-exception", err?.message || err);
});

async function replyWithRuntimeFailure(message) {
  if (!message?.reply) return;

  try {
    await safeReply(message, {
      embeds: [
        buildPanel({
          header: "\u26A0\uFE0F Runtime Hiccup",
          body: "that command or moderation check failed rn, try again in a sec",
          color: DANGER
        })
      ],
      allowedMentions: { repliedUser: false }
    }, {
      fallbackToChannel: !isNoResponseMessage(message)
    });
  } catch {}
}

async function runGuarded(scope, task, { message = null, replyWithDocsError = false } = {}) {
  try {
    return await task();
  } catch (err) {
    console.error(`${scope} failed:`, err);
    recordRuntimeEvent("error", scope, err?.message || err);

    if (message) {
      if (replyWithDocsError) {
        await replyWithError(message);
      } else {
        await replyWithRuntimeFailure(message);
      }
    }

    return null;
  }
}

client.on(Events.MessageCreate, async (message) => {
  if (message.author?.bot) return;

  await runGuarded("message-handler", async () => {
    try {
      await trackDailyStatsMessage(message);
    } catch (err) {
      console.warn("Daily stats tracking failed:", err.message);
      recordRuntimeEvent("warn", "daily-stats-track", err?.message || err);
    }
    await maybeEnforceNicknameOnMessage(message).catch(() => null);
    recordGhostPingCandidate(message);

    if (await maybeHandleLockCommand(message)) return;
    if (await maybeHandleControlCommand(message)) return;
    if (await maybeHandleRoleCommand(message)) return;
    if (await maybeHandleModerationWatch(message)) return;
    if (await maybeHandleOutageDetection(message)) return;
    if (await maybeHandleStatusCommand(message)) return;

    if (isNoResponseMessage(message)) {
      return;
    }

    if (message.channel.isDMBased()) {
      await handleDm(message);
      return;
    }
    if (!message.inGuild() || message.mentions.everyone || !isBotPing(message)) return;
    await handleGuildPing(message);
  }, {
    message,
    replyWithDocsError:
      !String(message.content || "").trim().startsWith("$") &&
      message.inGuild?.() &&
      isBotPing(message)
  });
});

async function hydrateUpdatedMessage(message) {
  if (!message) return null;
  if (message.partial && typeof message.fetch === "function") {
    return message.fetch().catch(() => null);
  }
  return message;
}

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  await runGuarded("message-update-handler", async () => {
    const message = await hydrateUpdatedMessage(newMessage);
    if (!message || message.author?.bot || !message.inGuild?.()) return;

    const oldContent = typeof oldMessage?.content === "string" ? oldMessage.content : null;
    const newContent = String(message.content || "");
    if (!newContent.trim()) return;
    if (oldContent !== null && oldContent === newContent) return;

    await maybeEnforceNicknameOnMessage(message).catch(() => null);
    if (await maybeHandleModerationWatch(message)) return;
    await maybeHandleOutageDetection(message);
  }, {
    message: newMessage
  });
});

client.on(Events.GuildMemberAdd, async (member) => {
  await runGuarded("guild-member-add", async () => {
    await maybeEnforceNicknameMember(member).catch(() => null);
    await maybeHandleImpersonationCheck(member);
  });
});

client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => {
  await runGuarded("guild-member-update", async () => {
    await maybeEnforceNicknameMember(newMember);
  });
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user?.bot) return;

  await runGuarded("reaction-handler", async () => {
    await maybeHandleRestrictedReactionAdd(reaction, user);
  });
});

client.on(Events.MessageDelete, async (message) => {
  await runGuarded("message-delete-handler", async () => {
    await maybeHandleGhostPing(message);
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  await runGuarded("interaction-handler", async () => {
    if (await maybeHandleNicknameModerationInteraction(interaction)) return;
    if (await maybeHandleOutageReviewInteraction(interaction)) return;
    if (await maybeHandleModerationLogInteraction(interaction)) return;
    if (await maybeHandleSweepReviewInteraction(interaction)) return;

    // If we got here, no handler claimed this interaction. Acknowledge the
    // click so Discord doesn't show "interaction failed" to the user. We do
    // this only for component interactions (buttons / select menus / modals);
    // commands have their own ack flow.
    if (interaction.isButton?.() || interaction.isAnySelectMenu?.() || interaction.isModalSubmit?.()) {
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({
            content: "this button isn't wired up yet — bug logged.",
            flags: 1 << 6,
            allowedMentions: { parse: [] }
          });
        }
      } catch (err) {
        recordRuntimeEvent("warn", "interaction-fallback", err?.message || err);
      }
      recordRuntimeEvent(
        "warn",
        "interaction-unrouted",
        `customId=${interaction.customId} type=${interaction.type}`
      );
    }
  });
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Discord login failed:", err);
  recordRuntimeEvent("error", "discord-login", err?.message || err);
  releaseInstanceLock();
  process.exit(1);
});
