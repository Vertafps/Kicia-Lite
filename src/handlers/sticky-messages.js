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

  // Scan recent history for any prior bot stickies and clean them up.
  // Heuristic: a sticky is a bot-authored message with at least one embed
  // and NO attachments. Real submission posts in the config channel always
  // have attachments (config + video files), so this won't match those.
  // The clips channel has no other bot posts that fit this shape.
  // - If we find one whose title matches the CURRENT builder's title → adopt.
  // - Any other bot stickies in scope (stale formats from earlier deploys)
  //   → delete so we never end up with multiple stickies stacked.
  try {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) {
      const me = channel.guild?.members?.me?.id || channel.client?.user?.id;
      const wantTitle = String(entry.buildPanel().data?.title || "").trim();
      let adopted = null;
      const stale = [];
      for (const m of recent.values()) {
        if (m.author?.id !== me) continue;
        if (m.attachments?.size > 0) continue;
        if (!m.embeds?.length) continue;
        const t = String(m.embeds[0]?.title || "").trim();
        if (!adopted && t === wantTitle) {
          adopted = m;
        } else {
          stale.push(m);
        }
      }
      for (const m of stale) {
        await m.delete().catch(() => null);
      }
      if (adopted) {
        entry.currentMessageId = adopted.id;
        return adopted;
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
