const {
  DAILY_STATS_CHANNEL_ID,
  DAILY_STATS_UTC_OFFSET_MINUTES,
  DAILY_STATS_REPORT_HOUR_LOCAL,
  DAILY_STATS_REPORT_MINUTE_LOCAL,
  STAFF_ROLE_IDS
} = require("./config");
const { formatDuration } = require("./duration");
const { buildPanel, INFO, SUCCESS, WARN } = require("./embed");
const { isStaffOnlyTrackedMember } = require("./permissions");
const {
  cleanupRestrictedEmojiDatabaseTempFiles,
  cleanupExpiredModerationActions,
  clearScamDecisionAudit,
  clearDailyStatsTracking,
  ensureDailyStatsWindowStartedAt,
  getDailyStatsWindowStartedAt,
  getDailyStatsSnapshot,
  recordDailyTrackedMessage
} = require("./restricted-emoji-db");
const { recordRuntimeEvent } = require("./runtime-health");

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_OFFSET_MS = DAILY_STATS_UTC_OFFSET_MINUTES * 60 * 1000;

let dailyStatsTimer = null;

function clearDailyStatsTimer() {
  if (!dailyStatsTimer) return;
  clearTimeout(dailyStatsTimer);
  dailyStatsTimer = null;
}

function toShiftedDate(timestamp) {
  return new Date(timestamp + DAILY_OFFSET_MS);
}

function getDailyStatsBoundaryAtOrBefore(timestamp = Date.now()) {
  const shiftedDate = toShiftedDate(timestamp);
  let boundaryShiftedAt = Date.UTC(
    shiftedDate.getUTCFullYear(),
    shiftedDate.getUTCMonth(),
    shiftedDate.getUTCDate(),
    DAILY_STATS_REPORT_HOUR_LOCAL,
    DAILY_STATS_REPORT_MINUTE_LOCAL,
    0,
    0
  );

  if (timestamp + DAILY_OFFSET_MS < boundaryShiftedAt) {
    boundaryShiftedAt -= DAY_MS;
  }

  return boundaryShiftedAt - DAILY_OFFSET_MS;
}

function getNextDailyStatsBoundary(timestamp = Date.now()) {
  return getDailyStatsBoundaryAtOrBefore(timestamp) + DAY_MS;
}

function getDailyStatsLocalHour(timestamp = Date.now()) {
  return toShiftedDate(timestamp).getUTCHours();
}

function formatLocalHourLabel(localHour) {
  const safeHour = Math.max(0, Math.min(23, Number(localHour) || 0));
  const endHour = (safeHour + 1) % 24;
  return `${String(safeHour).padStart(2, "0")}:00-${String(endHour).padStart(2, "0")}:00`;
}

function formatDiscordTimestamp(timestamp, style = "f") {
  return `<t:${Math.floor(Number(timestamp || 0) / 1000)}:${style}>`;
}

function formatUserLabel(entry) {
  return entry?.displayName || entry?.username || entry?.userId || "unknown";
}

function formatMemberLabel(member) {
  return member?.displayName || member?.user?.globalName || member?.user?.username || member?.id || "unknown";
}

function sumMessageCounts(entries) {
  return (entries || []).reduce((sum, entry) => sum + Number(entry.messageCount || 0), 0);
}

function sumModerationCounts(entries) {
  return (entries || []).reduce((sum, entry) => sum + Number(entry.eventCount || 0), 0);
}

function formatPercent(part, total) {
  return total ? `${((Number(part || 0) / total) * 100).toFixed(1)}%` : "0.0%";
}

function topList(entries, limit = 5) {
  return Array.isArray(entries) ? entries.slice(0, limit) : [];
}

function getModerationCount(snapshot, eventKey) {
  const entry = (snapshot.moderation || []).find((item) => item.eventKey === eventKey);
  return entry ? Number(entry.eventCount || 0) : 0;
}

function getModerationCounts(snapshot) {
  return {
    blockedLinkReviews: getModerationCount(snapshot, "blocked_link_review"),
    blockedLinkWarnings: getModerationCount(snapshot, "blocked_link_warning"),
    blockedLinkAlerts: getModerationCount(snapshot, "blocked_link_alert"),
    blockedLinkTimeouts: getModerationCount(snapshot, "blocked_link_timeout"),
    sellingAlerts: getModerationCount(snapshot, "selling_alert"),
    sellingTimeouts: getModerationCount(snapshot, "selling_timeout"),
    fakeInfoAlerts: getModerationCount(snapshot, "fake_info_alert"),
    suspiciousAlerts: getModerationCount(snapshot, "suspicious_alert"),
    suspiciousWarnings: getModerationCount(snapshot, "suspicious_warning"),
    suspiciousTimeouts: getModerationCount(snapshot, "suspicious_timeout"),
    raidAlerts: getModerationCount(snapshot, "raid_alert"),
    restrictedReactionAlerts: getModerationCount(snapshot, "restricted_reaction_alert"),
    restrictedReactionTimeouts: getModerationCount(snapshot, "restricted_reaction_timeout")
  };
}

async function resolveDailyStatsChannel(guild) {
  if (!guild?.channels) return null;

  const cached = guild.channels.cache?.get(DAILY_STATS_CHANNEL_ID);
  if (cached?.send) return cached;

  if (typeof guild.channels.fetch === "function") {
    const fetched = await guild.channels.fetch(DAILY_STATS_CHANNEL_ID).catch(() => null);
    if (fetched?.send) return fetched;
  }

  return null;
}

async function resolveTrackedStaffOnlyRoster(guild) {
  let members = [];
  let partial = true;

  if (typeof guild?.members?.fetch === "function") {
    try {
      const fetched = await guild.members.fetch();
      if (fetched?.size) {
        members = [...fetched.values()];
        partial = false;
      }
    } catch (err) {
      recordRuntimeEvent("warn", "daily-stats-staff-roster", err?.message || err);
    }
  }

  if (!members.length && guild?.members?.cache) {
    members = [...guild.members.cache.values()];
  }

  const deduped = new Map();
  for (const member of members) {
    if (!isStaffOnlyTrackedMember(member)) continue;
    deduped.set(member.id, member);
  }

  return {
    members: [...deduped.values()],
    partial
  };
}

function buildDailyServerStatsBody(snapshot, windowStartedAt, now) {
  const totalMessages = sumMessageCounts(snapshot.users);
  const activeUsers = snapshot.users.length;
  const activeChannels = snapshot.channels.length;
  const averageMessagesPerUser = activeUsers ? (totalMessages / activeUsers).toFixed(1) : "0.0";
  const averageMessagesPerChannel = activeChannels ? (totalMessages / activeChannels).toFixed(1) : "0.0";
  const windowHours = Math.max(1 / 60, (now - windowStartedAt) / (60 * 60 * 1000));
  const messagesPerHour = (totalMessages / windowHours).toFixed(1);
  const busiestHour = snapshot.hours[0] || null;
  const topUser = snapshot.users[0] || null;
  const topChannel = snapshot.channels[0] || null;
  const latestUser = [...snapshot.users].sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0] || null;

  const topUsersText = topList(snapshot.users)
    .map((entry) => `- **${formatUserLabel(entry)}** - ${entry.messageCount}`)
    .join("\n") || "none";
  const topChannelsText = topList(snapshot.channels)
    .map((entry) => `- <#${entry.channelId}> - ${entry.messageCount}`)
    .join("\n") || "none";
  const topHoursText = topList(snapshot.hours, 3)
    .map((entry) => `- ${formatLocalHourLabel(entry.localHour)} - ${entry.messageCount}`)
    .join("\n") || "none";

  return [
    `**Window:** ${formatDiscordTimestamp(windowStartedAt)} -> ${formatDiscordTimestamp(now)} (${formatDuration(now - windowStartedAt)})`,
    `**Tracked Staff Role:** <@&${STAFF_ROLE_IDS[0]}>`,
    `**Total Messages:** ${totalMessages}`,
    `**Active Users:** ${activeUsers}`,
    `**Active Channels:** ${activeChannels}`,
    `**Avg Per Active User:** ${averageMessagesPerUser}`,
    `**Avg Per Active Channel:** ${averageMessagesPerChannel}`,
    `**Messages / Hour:** ${messagesPerHour}`,
    topUser
      ? `**Top User Share:** ${formatUserLabel(topUser)} - ${formatPercent(topUser.messageCount, totalMessages)}`
      : "**Top User Share:** none",
    topChannel
      ? `**Top Channel Share:** <#${topChannel.channelId}> - ${formatPercent(topChannel.messageCount, totalMessages)}`
      : "**Top Channel Share:** none",
    busiestHour
      ? `**Busiest Hour (UTC+5:30):** ${formatLocalHourLabel(busiestHour.localHour)} - ${busiestHour.messageCount} messages`
      : "**Busiest Hour (UTC+5:30):** none",
    latestUser
      ? `**Most Recent Message:** ${formatUserLabel(latestUser)} in <#${latestUser.lastChannelId}> ${formatDuration(Math.max(0, now - latestUser.lastMessageAt))} ago`
      : "**Most Recent Message:** none",
    "",
    "## Peak Hours",
    topHoursText,
    "",
    "## Top Users",
    topUsersText,
    "",
    "## Top Channels",
    topChannelsText
  ].join("\n");
}

function buildDailyStaffStatsBody(snapshot, staffRoster, windowStartedAt, now) {
  const staffById = new Map(snapshot.staff.map((entry) => [entry.userId, entry]));
  const rosterMembers = staffRoster.members || [];
  const staffMessages = sumMessageCounts(snapshot.staff);
  const totalMessages = sumMessageCounts(snapshot.users);
  const activeStaffCount = rosterMembers.filter((member) => {
    const entry = staffById.get(member.id);
    return entry && entry.messageCount > 0;
  }).length;
  const mostRecentStaffEntry = [...snapshot.staff].sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0] || null;
  const staffShare = totalMessages ? ((staffMessages / totalMessages) * 100).toFixed(1) : "0.0";

  const silentMembers = rosterMembers
    .filter((member) => {
      const entry = staffById.get(member.id);
      return !entry || entry.messageCount <= 0;
    })
    .map((member) => ({
      label: formatMemberLabel(member),
      inactiveForMs: now - windowStartedAt
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const quietActiveMembers = rosterMembers
    .map((member) => {
      const entry = staffById.get(member.id);
      if (!entry || entry.messageCount <= 0) return null;
      return {
        label: formatMemberLabel(member),
        inactiveForMs: Math.max(0, now - entry.lastMessageAt),
        messageCount: entry.messageCount
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.inactiveForMs - a.inactiveForMs)
    .slice(0, 5);

  const topStaffText = topList(snapshot.staff)
    .map((entry) => `- **${formatUserLabel(entry)}** - ${entry.messageCount}`)
    .join("\n") || "none";
  const silentText = topList(silentMembers, 10)
    .map((entry) => `- **${entry.label}** - no staff messages this window (${formatDuration(entry.inactiveForMs)})`)
    .join("\n") || "none";
  const quietActiveText = quietActiveMembers
    .map((entry) => `- **${entry.label}** - last staff message ${formatDuration(entry.inactiveForMs)} ago (${entry.messageCount} msgs)`)
    .join("\n") || "none";

  return [
    `**Staff-Only Roster:** ${rosterMembers.length}${staffRoster.partial ? " (cache only / partial)" : ""}`,
    `**Staff-Only Messages:** ${staffMessages}`,
    `**Staff Active Today:** ${activeStaffCount}`,
    `**Staff Silent Whole Window:** ${silentMembers.length}`,
    `**Staff Share of Server Messages:** ${staffShare}%`,
    mostRecentStaffEntry
      ? `**Most Recent Staff Message:** ${formatUserLabel(mostRecentStaffEntry)} in <#${mostRecentStaffEntry.lastChannelId}> ${formatDuration(Math.max(0, now - mostRecentStaffEntry.lastMessageAt))} ago`
      : "**Most Recent Staff Message:** none",
    "",
    "## Top Staff Talkers",
    topStaffText,
    "",
    "## Silent Staff",
    silentText,
    "",
    "## Longest Since Staff Message",
    quietActiveText,
    staffRoster.partial
      ? "\n**Note:** full silent-staff coverage is partial rn because the roster came from cache only."
      : null
  ].filter(Boolean).join("\n");
}

function buildDailyModerationStatsBody(snapshot, windowStartedAt, now) {
  const counts = getModerationCounts(snapshot);
  const linkGuardTotal =
    counts.blockedLinkReviews +
    counts.blockedLinkWarnings +
    counts.blockedLinkAlerts +
    counts.blockedLinkTimeouts;
  const suspiciousTotal = counts.suspiciousAlerts + counts.suspiciousWarnings + counts.suspiciousTimeouts;
  const restrictedReactionTotal = counts.restrictedReactionAlerts + counts.restrictedReactionTimeouts;
  const totalEvents = sumModerationCounts(snapshot.moderation);
  const latestEvent = [...(snapshot.moderation || [])]
    .filter((entry) => entry.lastEventAt > 0)
    .sort((a, b) => b.lastEventAt - a.lastEventAt)[0] || null;

  return [
    `**Window:** ${formatDiscordTimestamp(windowStartedAt, "t")} -> ${formatDiscordTimestamp(now, "t")}`,
    `**Total Moderation Events:** ${totalEvents}`,
    `**Link Guard:** ${linkGuardTotal} total | ${counts.blockedLinkTimeouts} timeouts | ${counts.blockedLinkWarnings} warnings | ${counts.blockedLinkReviews + counts.blockedLinkAlerts} reviews`,
    `**Suspicious Alerts:** ${suspiciousTotal} total | ${counts.suspiciousWarnings} warnings | ${counts.suspiciousTimeouts} timeouts`,
    `**False Info Alerts:** ${counts.fakeInfoAlerts}`,
    `**Scam/Trade Guard:** ${counts.sellingAlerts + counts.sellingTimeouts} total | ${counts.sellingTimeouts} timeouts | ${counts.sellingAlerts} alerts`,
    `**Raid Alerts:** ${counts.raidAlerts}`,
    `**Restricted Reactions:** ${restrictedReactionTotal} total | ${counts.restrictedReactionAlerts} warnings | ${counts.restrictedReactionTimeouts} legacy timeouts`,
    latestEvent
      ? `**Last Moderation Event:** ${latestEvent.eventKey.replace(/_/g, " ")} ${formatDuration(Math.max(0, now - latestEvent.lastEventAt))} ago`
      : "**Last Moderation Event:** none",
    "",
    totalEvents
      ? "mod guard had activity today; review the log channel for exact messages"
      : "clean window: no moderation guard events recorded"
  ].join("\n");
}

async function buildDailyStatsEmbeds(guild, { now = Date.now() } = {}) {
  const windowStartedAt = await ensureDailyStatsWindowStartedAt(getDailyStatsBoundaryAtOrBefore(now));
  const snapshot = await getDailyStatsSnapshot();
  const staffRoster = await resolveTrackedStaffOnlyRoster(guild);
  const totalMessages = sumMessageCounts(snapshot.users);

  const serverPanel = buildPanel({
    header: "Daily Server Stats",
    body: buildDailyServerStatsBody(snapshot, windowStartedAt, now),
    color: totalMessages ? SUCCESS : INFO
  });
  const staffPanel = buildPanel({
    header: "Daily Staff Activity",
    body: buildDailyStaffStatsBody(snapshot, staffRoster, windowStartedAt, now),
    color: staffRoster.partial ? WARN : INFO
  });
  const moderationPanel = buildPanel({
    header: "Daily Moderation Summary",
    body: buildDailyModerationStatsBody(snapshot, windowStartedAt, now),
    color: sumModerationCounts(snapshot.moderation) ? WARN : SUCCESS
  });

  return {
    embeds: [serverPanel, staffPanel, moderationPanel],
    windowStartedAt,
    snapshot,
    staffRoster
  };
}

async function trackDailyStatsMessage(message, { now = Date.now() } = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return false;

  await ensureDailyStatsWindowStartedAt(getDailyStatsBoundaryAtOrBefore(now));
  await recordDailyTrackedMessage({
    userId: message.author?.id,
    username: message.author?.username || null,
    displayName: message.member?.displayName || message.author?.globalName || message.author?.username || null,
    channelId: message.channelId,
    channelName: message.channel?.name || null,
    at: now,
    localHour: getDailyStatsLocalHour(now),
    trackStaffOnly: isStaffOnlyTrackedMember(message.member)
  });
  return true;
}

async function runPostDailyReportCleanup() {
  const result = {
    scamAuditCleared: false,
    moderationActionsCleaned: false,
    tempFiles: null
  };

  try {
    await clearScamDecisionAudit();
    result.scamAuditCleared = true;
  } catch (err) {
    recordRuntimeEvent("warn", "daily-scam-audit-clear", err?.message || err);
  }

  try {
    await cleanupExpiredModerationActions();
    result.moderationActionsCleaned = true;
  } catch (err) {
    recordRuntimeEvent("warn", "daily-moderation-action-cleanup", err?.message || err);
  }

  try {
    result.tempFiles = await cleanupRestrictedEmojiDatabaseTempFiles();
  } catch (err) {
    recordRuntimeEvent("warn", "daily-temp-cleanup", err?.message || err);
  }

  return result;
}

async function runDailyStatsReport(client, { now = Date.now() } = {}) {
  const guilds = [...(client?.guilds?.cache?.values?.() || [])];
  if (!guilds.length) return false;

  const nextWindowStartedAt = getDailyStatsBoundaryAtOrBefore(now);

  for (const guild of guilds) {
    const channel = await resolveDailyStatsChannel(guild);
    if (!channel) continue;

    const report = await buildDailyStatsEmbeds(guild, { now });
    await channel.send({
      embeds: report.embeds,
      allowedMentions: { parse: [] }
    });

    await clearDailyStatsTracking(nextWindowStartedAt);
    await runPostDailyReportCleanup();
    return true;
  }

  recordRuntimeEvent("warn", "daily-stats-channel", `missing channel ${DAILY_STATS_CHANNEL_ID}`);
  return false;
}

function scheduleNextDailyStatsReport(client) {
  clearDailyStatsTimer();

  const now = Date.now();
  const nextBoundary = getNextDailyStatsBoundary(now);
  const delayMs = Math.max(1_000, nextBoundary - now);

  dailyStatsTimer = setTimeout(async () => {
    try {
      await runDailyStatsReport(client, { now: Date.now() });
    } catch (err) {
      recordRuntimeEvent("error", "daily-stats-report", err?.message || err);
      console.error("Daily stats report failed:", err);
    } finally {
      scheduleNextDailyStatsReport(client);
    }
  }, delayMs);
  dailyStatsTimer.unref?.();

  return {
    nextBoundary,
    delayMs
  };
}

async function startDailyStatsScheduler(client) {
  const now = Date.now();
  const currentBoundary = getDailyStatsBoundaryAtOrBefore(now);
  const windowStartedAt =
    await getDailyStatsWindowStartedAt() ||
    await ensureDailyStatsWindowStartedAt(currentBoundary);

  if (windowStartedAt < currentBoundary) {
    await runDailyStatsReport(client, { now: currentBoundary });
  }

  return scheduleNextDailyStatsReport(client);
}

module.exports = {
  DAILY_OFFSET_MS,
  getDailyStatsBoundaryAtOrBefore,
  getNextDailyStatsBoundary,
  getDailyStatsLocalHour,
  buildDailyModerationStatsBody,
  buildDailyStatsEmbeds,
  trackDailyStatsMessage,
  runPostDailyReportCleanup,
  runDailyStatsReport,
  scheduleNextDailyStatsReport,
  startDailyStatsScheduler,
  clearDailyStatsTimer
};
