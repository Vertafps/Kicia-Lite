const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client, Events, GatewayIntentBits, Partials } = require("discord.js");
const { DISCORD_TOKEN } = require("./config");
const { isNoResponseMessage } = require("./channel-policy");
const { fetchKb } = require("./kb");
const { handleDm, handleGuildPing, replyWithError } = require("./handlers/ping");
const { maybeHandleLockCommand } = require("./handlers/lockdown");
const { isOwnerCommandMessage, maybeHandleStatusCommand } = require("./handlers/status");
const { safeReact } = require("./utils/respond");

const LOCK_PATH = path.join(os.tmpdir(), "kicialite.lock");

function acquireInstanceLock() {
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    let existingPid;
    try {
      existingPid = Number(fs.readFileSync(LOCK_PATH, "utf8"));
    } catch (readErr) {
      // If we can't read it, it might be corrupted or locked by another process
      // Just try to overwrite if it's old, but for safety we'll just try to rm it
    }
    
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
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

function isBotPing(message) {
  return !!client.user && message.mentions.users.has(client.user.id);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Ready as ${readyClient.user.tag}`);
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
});

client.on(Events.Error, (err) => {
  console.error("Discord client error:", err);
});

client.on(Events.Warn, (warning) => {
  console.warn("Discord client warning:", warning);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author?.bot) return;

  try {
    if (await maybeHandleLockCommand(message)) return;
    if (isNoResponseMessage(message)) {
      if (isBotPing(message)) {
        await safeReact(message, "❌");
        return;
      }

      if (isOwnerCommandMessage(message.content)) {
        await maybeHandleStatusCommand(message);
      }
      return;
    }
    if (await maybeHandleStatusCommand(message)) return;
    if (message.channel.isDMBased()) {
      await handleDm(message);
      return;
    }
    if (!message.inGuild() || message.mentions.everyone || !isBotPing(message)) return;
    await handleGuildPing(message);
  } catch (err) {
    console.error("Message handler failed:", err);
    await replyWithError(message);
  }
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Discord login failed:", err);
  releaseInstanceLock();
  process.exit(1);
});
