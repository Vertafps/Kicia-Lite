"use strict";
const { getClipsChannelId } = require("./channel-config");
const { recordRuntimeEvent } = require("./runtime-health");
const { getSetting } = require("./settings");
const { trySendDM } = require("./utils/respond");

// 9pm UTC+5:30 = 15:30 UTC
const DEFAULT_UTC_HOUR = 15;
const DEFAULT_UTC_MINUTE = 30;

// Direct-DM recipients for the daily clip-of-the-day result. Each entry maps
// a Discord user ID to the salutation name used in the DM body. Hardcoded
// per owner spec; add more here if the audience grows.
const COTD_DM_RECIPIENTS = [
  { userId: "847703912932311091", name: "kernal" },
  { userId: "919357737257795645", name: "dcad" }
];

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

  const now = Date.now();
  const since = now - 24 * 60 * 60 * 1000;
  const until = now;

  for (const guild of client.guilds.cache.values()) {
    try {
      const winner = await pickClipOfTheDay(guild, { since, until });
      if (!winner) continue;

      // DM-only delivery — no channel post. Send each recipient the one-line
      // result. Failures (DMs disabled, circuit open, etc.) are recorded to
      // runtime-health but don't block other recipients.
      const dmBodyFor = (name) => `hiii ${name}, the clip of the day tdy was this: ${winner.message.url} with ${winner.reactionCount} reaction${winner.reactionCount === 1 ? "" : "s"}`;
      for (const recipient of COTD_DM_RECIPIENTS) {
        try {
          const user = await client.users.fetch(recipient.userId).catch(() => null);
          if (!user) {
            recordRuntimeEvent("warn", "cotd-dm", `${recipient.name} (${recipient.userId}): user fetch failed`);
            continue;
          }
          const dmResult = await trySendDM(user, { content: dmBodyFor(recipient.name) });
          if (!dmResult.sent) {
            recordRuntimeEvent("warn", "cotd-dm", `${recipient.name} (${recipient.userId}): ${dmResult.reason || "send failed"}`);
          }
        } catch (err) {
          recordRuntimeEvent("warn", "cotd-dm", `${recipient.name}: ${err?.message || err}`);
        }
      }
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
