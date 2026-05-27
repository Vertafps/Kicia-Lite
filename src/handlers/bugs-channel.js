"use strict";
const { buildRichPanel, INFO } = require("../embed");
const { getBugsChannelId } = require("../channel-config");
const { recordRuntimeEvent } = require("../runtime-health");
const { registerSticky, ensureSticky } = require("./sticky-messages");

function buildBugsStickyPanel() {
  return buildRichPanel({
    description: "### Ensure you're only talking/reporting about bugs and errors <3",
    color: INFO
  });
}

async function ensureBugsChannelSticky(guild) {
  const channelId = getBugsChannelId();
  if (!channelId || !guild) return false;
  const channel = guild.channels.cache.get(channelId)
    || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.send) return false;

  // Bump once every 5 non-bot messages so the reminder stays visible without
  // crowding the channel after every single post.
  registerSticky(channelId, buildBugsStickyPanel, { everyN: 5 });
  try {
    await ensureSticky(channel);
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "bugs-sticky", err?.message || err);
    return false;
  }
}

module.exports = { ensureBugsChannelSticky };
