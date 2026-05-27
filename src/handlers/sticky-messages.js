"use strict";
const { recordRuntimeEvent } = require("../runtime-health");

// channelId -> { buildPanel: () => EmbedBuilder, currentMessageId, lastRepostAt, pendingTimer }
const REGISTRY = new Map();
const REPOST_DEBOUNCE_MS = 5000;

function registerSticky(channelId, buildPanelFn) {
  if (!channelId || typeof buildPanelFn !== "function") return;
  const existing = REGISTRY.get(channelId) || {};
  REGISTRY.set(channelId, {
    ...existing,
    buildPanel: buildPanelFn,
    currentMessageId: existing.currentMessageId || null,
    lastRepostAt: existing.lastRepostAt || 0,
    pendingTimer: existing.pendingTimer || null
  });
}

function unregisterSticky(channelId) {
  const entry = REGISTRY.get(channelId);
  if (entry?.pendingTimer) {
    clearTimeout(entry.pendingTimer);
  }
  REGISTRY.delete(channelId);
}

async function postFreshSticky(channel) {
  const entry = REGISTRY.get(channel.id);
  if (!entry?.buildPanel) return null;
  const panel = entry.buildPanel();
  try {
    const msg = await channel.send({ embeds: [panel], allowedMentions: { parse: [] } });
    entry.currentMessageId = msg.id;
    entry.lastRepostAt = Date.now();
    return msg;
  } catch (err) {
    recordRuntimeEvent("warn", "sticky-post", err?.message || err);
    return null;
  }
}

async function deleteOldSticky(channel) {
  const entry = REGISTRY.get(channel.id);
  if (!entry?.currentMessageId) return;
  try {
    const old = await channel.messages.fetch(entry.currentMessageId).catch(() => null);
    if (old) await old.delete().catch(() => null);
  } catch {}
  entry.currentMessageId = null;
}

// Called on boot / after channel-set — posts the sticky if none exists.
// Best-effort; also unpins any pre-existing pinned sticky from the older pin
// approach.
async function ensureSticky(channel) {
  const entry = REGISTRY.get(channel.id);
  if (!entry?.buildPanel) return;

  // If we already have a current sticky tracked, verify it still exists
  if (entry.currentMessageId) {
    const existing = await channel.messages.fetch(entry.currentMessageId).catch(() => null);
    if (existing) return existing;
    entry.currentMessageId = null;
  }

  // Try to recover an existing bot-authored sticky from recent history
  // (matches by embed title prefix) so we don't double-post on bot restarts.
  try {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) {
      const me = channel.guild?.members?.me?.id || channel.client?.user?.id;
      const candidate = entry.buildPanel().data?.title || "";
      const titleNeedle = candidate.split(" ")[0] || ""; // emoji or first word
      for (const m of recent.values()) {
        if (m.author?.id !== me) continue;
        const t = m.embeds?.[0]?.title || "";
        if (titleNeedle && t.startsWith(titleNeedle)) {
          entry.currentMessageId = m.id;
          return m;
        }
      }
    }
  } catch {}

  // Post fresh
  return await postFreshSticky(channel);
}

// Called after every non-bot message. Debounces to at most one repost per
// REPOST_DEBOUNCE_MS. Deletes the old sticky and posts a fresh one so it
// stays at the bottom of the channel.
function bumpSticky(channel) {
  const entry = REGISTRY.get(channel.id);
  if (!entry?.buildPanel) return;

  const now = Date.now();
  const elapsed = now - entry.lastRepostAt;

  if (elapsed < REPOST_DEBOUNCE_MS) {
    // Schedule a trailing repost so the last message in a burst still gets a
    // sticky underneath it
    if (entry.pendingTimer) return; // already scheduled
    const delay = REPOST_DEBOUNCE_MS - elapsed + 100;
    entry.pendingTimer = setTimeout(async () => {
      entry.pendingTimer = null;
      try {
        await deleteOldSticky(channel);
        await postFreshSticky(channel);
      } catch (err) {
        recordRuntimeEvent("warn", "sticky-bump", err?.message || err);
      }
    }, delay);
    entry.pendingTimer.unref?.();
    return;
  }

  // Immediate repost
  (async () => {
    try {
      await deleteOldSticky(channel);
      await postFreshSticky(channel);
    } catch (err) {
      recordRuntimeEvent("warn", "sticky-bump", err?.message || err);
    }
  })();
}

async function maybeBumpForChannel(message) {
  if (!message?.channel?.id) return;
  if (message.author?.bot) return;
  if (REGISTRY.has(message.channel.id)) {
    bumpSticky(message.channel);
  }
}

module.exports = { registerSticky, unregisterSticky, ensureSticky, bumpSticky, maybeBumpForChannel };
