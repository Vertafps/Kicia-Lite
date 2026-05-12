"use strict";

/**
 * Anti-ghost-ping detector.
 *
 * On every guild MessageCreate: if the message has user mentions and the
 * author is a human (non-bot), record a short-lived cache entry with the
 * mention list + content snippet. On MessageDelete: if a cached entry exists
 * for that message id, post a ghost-ping alert to the log channel and evict
 * the entry. Entries expire naturally after GHOST_PING_RETENTION_MS.
 *
 * The alert ONLY routes to the configured log channel — never to the channel
 * where the ghost ping happened.
 */

const { GHOST_PING_RETENTION_MS } = require("../config");
const { buildRichPanel, WARN, resolveAvatarURL } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const { hasModerationBypassMessage } = require("../permissions");
const { recordRuntimeEvent } = require("../runtime-health");

const GHOST_RETENTION = Math.max(5_000, Number(GHOST_PING_RETENTION_MS) || 60_000);
const MAX_TRACKED = 5_000;
const CONTENT_SNIPPET_MAX = 400;

const candidates = new Map();

function pruneExpired(now = Date.now()) {
  if (candidates.size === 0) return;
  for (const [key, entry] of candidates) {
    if (now - entry.createdAt > GHOST_RETENTION) candidates.delete(key);
  }
}

function trackedKey(message) {
  if (!message?.id) return null;
  const guildId = message.guildId || message.guild?.id || "";
  return `${guildId}:${message.id}`;
}

function collectUserMentionIds(message) {
  const ids = new Set();
  const mentionedUsers = message?.mentions?.users;
  if (mentionedUsers?.forEach) {
    mentionedUsers.forEach((user) => {
      if (user?.id && user.id !== message.author?.id) ids.add(user.id);
    });
  }
  return [...ids];
}

function snippet(content) {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  if (!text) return "(no message content)";
  if (text.length <= CONTENT_SNIPPET_MAX) return text;
  return `${text.slice(0, CONTENT_SNIPPET_MAX - 1)}…`;
}

function recordGhostPingCandidate(message) {
  if (!message || message.author?.bot) return;
  if (!message.inGuild?.()) return;
  if (message.mentions?.everyone) return;
  if (hasModerationBypassMessage(message)) return;

  const mentions = collectUserMentionIds(message);
  if (mentions.length === 0) return;

  const key = trackedKey(message);
  if (!key) return;

  if (candidates.size >= MAX_TRACKED) {
    pruneExpired();
  }

  candidates.set(key, {
    guildId: message.guildId || message.guild?.id || "",
    channelId: message.channelId || message.channel?.id || "",
    messageId: message.id,
    authorId: message.author?.id || "",
    authorTag: message.author?.tag || message.author?.username || "",
    authorAvatar: resolveAvatarURL(message.author),
    mentions,
    content: snippet(message.content),
    createdAt: Date.now()
  });
}

function buildGhostPingPanel(entry, guild) {
  const mentionsText = entry.mentions.length
    ? entry.mentions.map((id) => `<@${id}>`).join(" ")
    : "(no resolved mentions)";

  return buildRichPanel({
    title: "Ghost Ping Detected",
    color: WARN,
    description: "a user pinged someone and deleted the message before the ping target saw it",
    thumbnail: entry.authorAvatar,
    fields: [
      {
        name: "Author",
        value: entry.authorId ? `<@${entry.authorId}>${entry.authorTag ? ` · ${entry.authorTag}` : ""}` : (entry.authorTag || "unknown"),
        inline: true
      },
      {
        name: "Channel",
        value: entry.channelId ? `<#${entry.channelId}>` : "unknown",
        inline: true
      },
      {
        name: "Pinged",
        value: mentionsText,
        inline: false
      },
      {
        name: "Message Content",
        value: entry.content || "(no message content)",
        inline: false
      },
      {
        name: "Time Alive",
        value: `${Math.round((Date.now() - entry.createdAt) / 1000)}s before deletion`,
        inline: true
      }
    ]
  });
}

async function maybeHandleGhostPing(message) {
  if (!message) return false;
  const key = trackedKey(message);
  if (!key) return false;

  const entry = candidates.get(key);
  if (!entry) return false;
  candidates.delete(key);

  const now = Date.now();
  if (now - entry.createdAt > GHOST_RETENTION) return false;

  const guild = message.guild || (message.client?.guilds?.cache?.get?.(entry.guildId) || null);
  if (!guild) return false;

  try {
    await sendLogPanel(guild, buildGhostPingPanel(entry, guild));
  } catch (err) {
    recordRuntimeEvent("warn", "ghost-ping-log", err?.message || err);
  }
  return true;
}

function __resetForTests() {
  candidates.clear();
}

function __snapshotForTests() {
  return [...candidates.entries()];
}

module.exports = {
  recordGhostPingCandidate,
  maybeHandleGhostPing,
  __resetForTests,
  __snapshotForTests
};
