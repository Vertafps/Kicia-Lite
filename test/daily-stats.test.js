process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");

const {
  buildDailyStatsEmbeds,
  clearDailyStatsTimer,
  getDailyStatsBoundaryAtOrBefore,
  getNextDailyStatsBoundary,
  getDailyStatsLocalHour,
  startDailyStatsScheduler
} = require("../src/daily-stats");
const {
  addRestrictedEmoji,
  clearDailyStatsTracking,
  ensureDailyStatsWindowStartedAt,
  getDailyStatsSnapshot,
  getRestrictedEmojiDatabaseSnapshot,
  parseEmojiInput,
  recordDailyModerationEvent,
  recordDailyTrackedMessage,
  resetRestrictedEmojiDatabaseForTests
} = require("../src/restricted-emoji-db");

const testDbPath = path.join(os.tmpdir(), `kicialite-daily-stats-${process.pid}.sqlite`);

function buildGuildForDailyStats() {
  const staffMember = {
    id: "staff-1",
    displayName: "Staff Alpha",
    roles: {
      cache: {
        has: (roleId) => roleId === "1298767464678559794"
      }
    },
    user: {
      username: "staffalpha"
    }
  };
  const silentStaffMember = {
    id: "staff-2",
    displayName: "Staff Silent",
    roles: {
      cache: {
        has: (roleId) => roleId === "1298767464678559794"
      }
    },
    user: {
      username: "staffsilent"
    }
  };
  const modWithStaffRole = {
    id: "mod-1",
    displayName: "Mod Beta",
    roles: {
      cache: {
        has: (roleId) => roleId === "1298767464678559794" || roleId === "1484221162647978016"
      }
    },
    user: {
      username: "modbeta"
    }
  };

  const members = [staffMember, silentStaffMember, modWithStaffRole];

  return {
    id: "guild-1",
    members: {
      fetch: async () => new Map(members.map((member) => [member.id, member])),
      cache: new Map(members.map((member) => [member.id, member]))
    }
  };
}

test.before(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
});

test.after(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
});

test("daily stats boundary calculations follow the 9 PM UTC+5:30 window", () => {
  const beforeBoundary = Date.parse("2026-04-26T14:00:00.000Z");
  const afterBoundary = Date.parse("2026-04-26T16:00:00.000Z");

  assert.equal(
    getDailyStatsBoundaryAtOrBefore(beforeBoundary),
    Date.parse("2026-04-25T15:30:00.000Z")
  );
  assert.equal(
    getDailyStatsBoundaryAtOrBefore(afterBoundary),
    Date.parse("2026-04-26T15:30:00.000Z")
  );
  assert.equal(
    getNextDailyStatsBoundary(afterBoundary),
    Date.parse("2026-04-27T15:30:00.000Z")
  );
  assert.equal(getDailyStatsLocalHour(Date.parse("2026-04-26T17:45:00.000Z")), 23);
});

test("clearing daily stats tracking preserves restricted emojis", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
  const startAt = Date.parse("2026-04-26T15:30:00.000Z");
  await ensureDailyStatsWindowStartedAt(startAt);
  await addRestrictedEmoji(parseEmojiInput("\u{1F62D}"));
  await recordDailyTrackedMessage({
    userId: "user-1",
    username: "alpha",
    displayName: "Alpha",
    channelId: "channel-1",
    channelName: "general",
    at: startAt + 10_000,
    localHour: 21,
    trackStaffOnly: false
  });
  await recordDailyModerationEvent("blocked_link_timeout", { at: startAt + 20_000 });

  await clearDailyStatsTracking(startAt + 100_000);

  const snapshot = await getRestrictedEmojiDatabaseSnapshot();
  assert.equal(snapshot.tableCounts.restrictedEmojis, 1);
  assert.equal(snapshot.tableCounts.dailyUsers, 0);
  assert.equal(snapshot.tableCounts.dailyChannels, 0);
  assert.equal(snapshot.tableCounts.dailyStaff, 0);
  assert.equal(snapshot.tableCounts.dailyModeration, 0);
});

test("daily stats embeds show top users and silent staff without counting mods", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
  const windowStartedAt = Date.parse("2026-04-26T15:30:00.000Z");
  const reportTime = Date.parse("2026-04-27T15:30:00.000Z");
  await ensureDailyStatsWindowStartedAt(windowStartedAt);

  await recordDailyTrackedMessage({
    userId: "user-1",
    username: "alpha",
    displayName: "Alpha",
    channelId: "channel-1",
    channelName: "general",
    at: windowStartedAt + 60_000,
    localHour: 21,
    trackStaffOnly: false
  });
  await recordDailyTrackedMessage({
    userId: "user-1",
    username: "alpha",
    displayName: "Alpha",
    channelId: "channel-1",
    channelName: "general",
    at: windowStartedAt + 120_000,
    localHour: 21,
    trackStaffOnly: false
  });
  await recordDailyTrackedMessage({
    userId: "staff-1",
    username: "staffalpha",
    displayName: "Staff Alpha",
    channelId: "channel-2",
    channelName: "staff-chat",
    at: windowStartedAt + 3 * 60_000,
    localHour: 21,
    trackStaffOnly: true
  });
  await recordDailyModerationEvent("blocked_link_timeout", { at: windowStartedAt + 4 * 60_000 });
  await recordDailyModerationEvent("suspicious_warning", { at: windowStartedAt + 5 * 60_000 });
  await recordDailyModerationEvent("fake_info_alert", { at: windowStartedAt + 6 * 60_000 });
  await recordDailyModerationEvent("selling_timeout", { at: windowStartedAt + 7 * 60_000 });

  const guild = buildGuildForDailyStats();
  const report = await buildDailyStatsEmbeds(guild, { now: reportTime });

  assert.equal(report.embeds.length, 3);
  const serverDescription = report.embeds[0].data.description;
  const staffDescription = report.embeds[1].data.description;
  const moderationDescription = report.embeds[2].data.description;

  assert.match(serverDescription, /Top Users/i);
  assert.match(serverDescription, /Peak Hours/i);
  assert.match(serverDescription, /Messages \/ Hour/i);
  assert.match(serverDescription, /Top Channel Share/i);
  assert.match(serverDescription, /Most Recent Message/i);
  assert.match(serverDescription, /Alpha/i);
  assert.match(staffDescription, /Staff Silent/i);
  assert.match(staffDescription, /Staff Share of Server Messages/i);
  assert.match(staffDescription, /no staff messages this window/i);
  assert.doesNotMatch(staffDescription, /Mod Beta/i);
  assert.match(moderationDescription, /Daily Moderation/i);
  assert.match(moderationDescription, /Link Guard:\*\* 1 total/i);
  assert.match(moderationDescription, /Suspicious Alerts:\*\* 1 total/i);
  assert.match(moderationDescription, /False Info Alerts:\*\* 1/i);
  assert.match(moderationDescription, /Scam\/Trade Guard:\*\* 1 total \| 1 timeouts/i);

  const snapshot = await getDailyStatsSnapshot();
  assert.equal(snapshot.staff.length, 1);
  assert.equal(snapshot.staff[0].userId, "staff-1");
  assert.equal(snapshot.moderation.length, 4);
});

test("daily stats scheduler catches up a missed report on startup", async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
  const oldWindowStartedAt = Date.parse("2026-04-25T15:30:00.000Z");
  const currentBoundary = Date.parse("2026-04-26T15:30:00.000Z");
  const now = Date.parse("2026-04-26T18:00:00.000Z");
  const sentPayloads = [];

  await ensureDailyStatsWindowStartedAt(oldWindowStartedAt);
  await recordDailyTrackedMessage({
    userId: "user-1",
    username: "alpha",
    displayName: "Alpha",
    channelId: "channel-1",
    channelName: "general",
    at: oldWindowStartedAt + 60_000,
    localHour: 21,
    trackStaffOnly: false
  });

  const guild = buildGuildForDailyStats();
  guild.channels = {
    cache: new Map([[
      "1484218637060407418",
      {
        id: "1484218637060407418",
        send: async (payload) => {
          sentPayloads.push(payload);
        }
      }
    ]]),
    fetch: async (channelId) => guild.channels.cache.get(channelId) || null
  };

  const client = {
    guilds: {
      cache: new Map([[guild.id, guild]])
    }
  };

  const originalDateNow = Date.now;
  Date.now = () => now;

  try {
    await startDailyStatsScheduler(client);
  } finally {
    clearDailyStatsTimer();
    Date.now = originalDateNow;
  }

  assert.equal(sentPayloads.length, 1);

  const snapshot = await getDailyStatsSnapshot();
  assert.equal(snapshot.windowStartedAt, currentBoundary);
  assert.equal(snapshot.users.length, 0);
  assert.equal(snapshot.channels.length, 0);
  assert.equal(snapshot.staff.length, 0);
});
