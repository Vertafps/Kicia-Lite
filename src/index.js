const fs = require("fs");
const os = require("os");
const path = require("path");
const { Client, Events, GatewayIntentBits, Partials } = require("discord.js");
const { DISCORD_TOKEN } = require("./config");
const { fetchKb } = require("./kb");
const { handleDm, handleGuildPing, replyWithError } = require("./handlers/ping");
const { maybeHandleStatusCommand } = require("./handlers/status");

const LOCK_PATH = path.join(os.tmpdir(), "kicialite.lock");

function acquireInstanceLock() {
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const existingPid = Number(fs.readFileSync(LOCK_PATH, "utf8"));
    if (Number.isInteger(existingPid)) {
      try {
        process.kill(existingPid, 0);
        throw new Error(`Another KiciaLite instance is already running (PID ${existingPid}).`);
      } catch (probeErr) {
        if (probeErr.code !== "ESRCH") throw probeErr;
      }
    }
    fs.rmSync(LOCK_PATH, { force: true });
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
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

client.on(Events.MessageCreate, async (message) => {
  if (message.author?.bot) return;

  try {
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

client.login(DISCORD_TOKEN);
