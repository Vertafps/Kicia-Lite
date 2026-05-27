"use strict";
const { buildRichPanel, INFO, resolveAvatarURL } = require("./embed");
const { getClipsChannelId, getClipOfTheDayChannelId } = require("./channel-config");
const { recordRuntimeEvent } = require("./runtime-health");
const { getSetting } = require("./settings");

// 9pm UTC+5:30 = 15:30 UTC
const DEFAULT_UTC_HOUR = 15;
const DEFAULT_UTC_MINUTE = 30;

function msUntilNext(utcHour, utcMinute) {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    utcHour,
    utcMinute,
    0,
    0
  ));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function pickClipOfTheDay(guild, { since, until }) {
  const clipsId = getClipsChannelId();
  if (!clipsId) return null;
  const channel = guild.channels.cache.get(clipsId)
    || await guild.channels.fetch(clipsId).catch(() => null);
  if (!channel?.messages) return null;

  // fetch up to 100 messages from the day
  let best = null;
  let bestCount = -1;
  try {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return null;
    for (const m of messages.values()) {
      if (m.createdTimestamp < since || m.createdTimestamp >= until) continue;
      if (m.author?.bot) continue;
      // sum reaction counts across all emojis on this message
      let total = 0;
      for (const reaction of m.reactions?.cache?.values() || []) {
        total += reaction.count || 0;
      }
      if (total > bestCount) {
        bestCount = total;
        best = { message: m, reactionCount: total };
      }
    }
  } catch (err) {
    recordRuntimeEvent("warn", "cotd-fetch", err?.message || err);
    return null;
  }
  if (!best || bestCount < 1) return null;
  return best;
}

async function runClipOfTheDay(client) {
  if (getSetting("clipoftheday.enabled") === false) return;
  const cotdChannelId = getClipOfTheDayChannelId();
  if (!cotdChannelId) return;

  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;
  const until = now;

  for (const guild of client.guilds.cache.values()) {
    try {
      const winner = await pickClipOfTheDay(guild, { since, until });
      if (!winner) continue;
      const cotdChannel = guild.channels.cache.get(cotdChannelId)
        || await guild.channels.fetch(cotdChannelId).catch(() => null);
      if (!cotdChannel?.send) continue;

      const author = winner.message.author;
      const member = winner.message.member;
      const displayName = member?.displayName || author?.globalName || author?.username || "user";
      const avatar = resolveAvatarURL(author);
      const panel = buildRichPanel({
        title: "🏆 Clip of the Day",
        author: { name: displayName, iconURL: avatar || undefined },
        description: `Most-reacted clip in the last 24 hours.\n\n[Jump to clip](${winner.message.url})`,
        fields: [
          { name: "Submitted by", value: `<@${author.id}>`, inline: true },
          { name: "Reactions", value: String(winner.reactionCount), inline: true }
        ],
        color: INFO
      });
      await cotdChannel.send({ embeds: [panel], allowedMentions: { parse: [] } });
    } catch (err) {
      recordRuntimeEvent("warn", "cotd-run", err?.message || err);
    }
  }
}

function startClipOfTheDayScheduler(client) {
  function scheduleNext() {
    const hour = Number(getSetting("clipoftheday.utc_hour"));
    const minute = Number(getSetting("clipoftheday.utc_minute"));
    const h = Number.isFinite(hour) && hour >= 0 && hour < 24 ? hour : DEFAULT_UTC_HOUR;
    const m = Number.isFinite(minute) && minute >= 0 && minute < 60 ? minute : DEFAULT_UTC_MINUTE;
    const delay = msUntilNext(h, m);
    setTimeout(async () => {
      try { await runClipOfTheDay(client); }
      catch (err) { recordRuntimeEvent("warn", "cotd-schedule", err?.message || err); }
      scheduleNext();
    }, delay).unref?.();
  }
  scheduleNext();
}

module.exports = { startClipOfTheDayScheduler, runClipOfTheDay, pickClipOfTheDay };
