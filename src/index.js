const fs = require("fs");
const os = require("os");
const path = require("path");
const { ActivityType, Client, Events, GatewayIntentBits, Partials } = require("discord.js");
const { BOT_PRESENCE_TEXT, DISCORD_TOKEN } = require("./config");
const { isNoResponseMessage } = require("./channel-policy");
const { startDailyStatsScheduler, trackDailyStatsMessage } = require("./daily-stats");
const { buildPanel, DANGER, INFO, WARN } = require("./embed");
const { fetchKb } = require("./kb");
const { refreshScamPulseFeeds } = require("./link-policy");
const { sendLogPanel } = require("./log-channel");
const { maybeHandleControlCommand } = require("./handlers/commands");
const {
  maybeHandleModerationLogInteraction,
  maybeHandleModerationWatch
} = require("./handlers/moderation");
const { handleDm, handleGuildPing, replyWithError } = require("./handlers/ping");
const { maybeHandleLockCommand } = require("./handlers/lockdown");
const { maybeHandleRestrictedReactionAdd } = require("./handlers/restricted-reactions");
const { maybeHandleStatusCommand } = require("./handlers/status");
const {
  cleanupExpiredModerationActions,
  flushRestrictedEmojiDatabaseNow
} = require("./restricted-emoji-db");
const { recordRuntimeEvent } = require("./runtime-health");
const { safeReply } = require("./utils/respond");

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
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

function buildScamPulseRefreshPanel({ pulse, initial = false, error = null }) {
  if (error) {
    return {
      header: "Scam Pulse Refresh Failed",
      body: [
        "FishFish global URL/domain cache refresh failed; existing cached entries remain in memory until the next successful refresh.",
        `**Error:** ${error}`
      ].join("\n\n"),
      color: WARN
    };
  }

  return {
    header: initial ? "Scam Pulse Primed" : "Scam Pulse Refreshed",
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

async function refreshAndReportScamPulse(readyClient, { initial = false } = {}) {
  try {
    const pulse = await refreshScamPulseFeeds();
    console.log(`Scam Pulse ${initial ? "primed" : "refreshed"}: ${pulse.domains} domains, ${pulse.urls} URLs`);
    await sendClientLogPanel(readyClient, buildScamPulseRefreshPanel({ pulse, initial }));
    return pulse;
  } catch (err) {
    const message = err?.message || String(err);
    console.warn(`${initial ? "Initial" : "Scheduled"} Scam Pulse refresh failed:`, message);
    recordRuntimeEvent("warn", "scam-pulse-refresh", message);
    await sendClientLogPanel(readyClient, buildScamPulseRefreshPanel({ error: message })).catch(() => false);
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

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ready as ${readyClient.user.tag}`);
  readyClient.user.setActivity(BOT_PRESENCE_TEXT, {
    type: ActivityType.Custom
  });
  try {
    await fetchKb();
    console.log("KB cache primed");
  } catch (err) {
    console.warn("Initial KB fetch failed:", err.message);
  }

  const timer = setInterval(() => {
    fetchKb().catch((err) => console.warn("Scheduled KB refresh failed:", err.message));
  }, 10 * 60 * 1000);
  timer.unref?.();

  await refreshAndReportScamPulse(readyClient, { initial: true });

  const pulseTimer = setInterval(() => {
    refreshAndReportScamPulse(readyClient).catch(() => null);
  }, 60 * 60 * 1000);
  pulseTimer.unref?.();

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

    if (await maybeHandleLockCommand(message)) return;
    if (await maybeHandleControlCommand(message)) return;
    if (await maybeHandleModerationWatch(message)) return;

    if (isNoResponseMessage(message)) {
      return;
    }

    if (await maybeHandleStatusCommand(message)) return;
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

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user?.bot) return;

  await runGuarded("reaction-handler", async () => {
    await maybeHandleRestrictedReactionAdd(reaction, user);
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  await runGuarded("interaction-handler", async () => {
    if (await maybeHandleModerationLogInteraction(interaction)) return;
  });
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Discord login failed:", err);
  recordRuntimeEvent("error", "discord-login", err?.message || err);
  releaseInstanceLock();
  process.exit(1);
});
