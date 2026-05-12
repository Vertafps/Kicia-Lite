"use strict";

/**
 * Moderation watcher.
 *
 * Thin pipeline:
 *   bypass → link policy → prohibited commerce → done
 *
 * Scam/trade pattern detection, toxicity shadow, suspicious heuristics, raid
 * detection, and roasting reply have been removed. Wick handles raid. Scam
 * detection was false-positive prone and is gone. The link policy continues
 * to do FishFish + threat intel + KB blocklist work; prohibited commerce
 * still catches drug/weapon sales. The owner-only `$policy` toggle narrows
 * link policy to FishFish-only and disables prohibited commerce.
 *
 * Every detection log is sent to the configured log channel via sendLogPanel.
 * No detection output ever lands in the channel that triggered it.
 */

const {
  LINK_MODERATION_TIMEOUT_MS,
  NEW_ACCOUNT_LINK_SCRUTINY_MS,
  NEW_MEMBER_LINK_SCRUTINY_MS,
  BRAND
} = require("../config");
const {
  MODLOG_REVERT_PREFIX,
  MODLOG_VIEW_PREFIX,
  buildModerationLogButtonRows
} = require("../components");
const { cleanText } = require("../text");
const { formatDuration } = require("../duration");
const {
  buildPanel,
  buildRichPanel,
  DANGER,
  INFO,
  SUCCESS,
  WARN,
  resolveAvatarURL
} = require("../embed");
const { fetchKb } = require("../kb");
const {
  detectBlockedLinkSignalAsync,
  detectFishFishOnlyLinkSignal,
  extractUrlsFromText
} = require("../link-policy");
const { sendLogPanel } = require("../log-channel");
const { canUseEmojiCommands, hasModerationBypassMessage } = require("../permissions");
const { detectProhibitedCommerce } = require("../prohibited-commerce");
const {
  cleanupExpiredModerationActions,
  deleteModerationAction,
  getModerationAction,
  getPolicyEnforcementEnabled,
  isModerationWhitelistedUser,
  listTrustedLinks,
  recordDailyModerationEvent,
  recordModerationAction
} = require("../restricted-emoji-db");
const { recordRuntimeEvent } = require("../runtime-health");
const { safeReply, safeSend } = require("../utils/respond");

const MODERATION_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
const MODERATION_CONTEXT_VIEW_LIMIT = 10;
const MAX_EVIDENCE_LENGTH = 220;

// ─── helpers ─────────────────────────────────────────────────────────────────

function trimExcerpt(text, max = MAX_EVIDENCE_LENGTH) {
  const cleaned = cleanText(text);
  if (!cleaned || cleaned.length <= max) return cleaned || "(no text)";
  return `${cleaned.slice(0, max - 3)}...`;
}

function buildMessageUrl(message) {
  if (message?.url) return message.url;
  if (!message?.guildId || !message?.channelId || !message?.id) return null;
  return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

async function tryTimeoutMessageMember(member, durationMs, reason) {
  if (!member?.timeout || member.moderatable === false) {
    return { applied: false, reason: "bot cannot moderate that member" };
  }
  try {
    await member.timeout(durationMs, reason);
    return { applied: true, reason: `timed out for ${Math.round(durationMs / 1000)}s` };
  } catch (err) {
    return { applied: false, reason: err?.message || "timeout failed" };
  }
}

async function tryDeleteMessage(message) {
  if (!message?.delete) return { deleted: false, reason: "delete unavailable" };
  try {
    await message.delete();
    return { deleted: true };
  } catch (err) {
    return { deleted: false, reason: err?.message || "delete failed" };
  }
}

function hasBypassPermission(message) {
  return hasModerationBypassMessage(message);
}

async function hasManualWhitelistBypass(message) {
  const userId = message?.author?.id;
  if (!userId) return false;
  try {
    return await isModerationWhitelistedUser(userId);
  } catch (err) {
    recordRuntimeEvent("warn", "moderation-whitelist-check", err?.message || err);
    return false;
  }
}

function getPosterLinkContext(message, now = Date.now()) {
  const userCreatedAt = Number(message?.author?.createdTimestamp || 0);
  const memberJoinedAt = Number(message?.member?.joinedTimestamp || 0);
  const accountAgeMs = userCreatedAt > 0 ? now - userCreatedAt : null;
  const memberAgeMs = memberJoinedAt > 0 ? now - memberJoinedAt : null;
  return {
    accountAgeMs,
    memberAgeMs,
    isNewAccount: Number.isFinite(accountAgeMs) && accountAgeMs >= 0 && accountAgeMs < NEW_ACCOUNT_LINK_SCRUTINY_MS,
    isNewMember: Number.isFinite(memberAgeMs) && memberAgeMs >= 0 && memberAgeMs < NEW_MEMBER_LINK_SCRUTINY_MS
  };
}

async function recordModerationStat(eventKey, now = Date.now()) {
  try {
    await recordDailyModerationEvent(eventKey, { at: now });
  } catch (err) {
    recordRuntimeEvent("warn", "daily-moderation-track", err?.message || err);
  }
}

function mightContainLink(content) {
  return extractUrlsFromText(content).length > 0;
}

function formatBlockedLinkReasons(signal) {
  const reasons = signal.reasons?.length ? signal.reasons : [signal.reason || "risky link detected"];
  return reasons.map((reason) => `- ${reason}`).join("\n");
}

function formatDiscordTimestamp(timestamp, style = "R") {
  const seconds = Math.floor(Number(timestamp || 0) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  return `<t:${seconds}:${style}>`;
}

function formatModerationActionReviewWindow(expiresAt) {
  return `${formatDiscordTimestamp(expiresAt, "R")} (${formatDiscordTimestamp(expiresAt, "f")})`;
}

function getModerationReviewExpiresAt(now, timeoutMs) {
  const base = Math.max(MODERATION_REVIEW_WINDOW_MS, Number(timeoutMs || 0));
  return now + base;
}

// ─── DMs to user when action taken ───────────────────────────────────────────

function buildBlockedLinkUserPayload({ message, signal, durationMs }) {
  const shownLinks = (signal.blockedLinks || [])
    .slice(0, 3)
    .map((entry) => `- ${entry.raw}`)
    .join("\n");
  const isTimeout = signal.action === "timeout";

  return {
    embeds: [
      buildPanel({
        header: isTimeout ? "Link Timeout" : "Link Warning",
        body: isTimeout
          ? `Timed out for ${formatDuration(durationMs)} — that link looked high-risk.`
          : "That link was removed — it looked risky.",
        fields: [
          { name: "Threat Level", value: String(signal.threatLevel || "elevated"), inline: true },
          { name: "Channel", value: `<#${message.channelId}>`, inline: true },
          { name: "Why", value: formatBlockedLinkReasons(signal) },
          { name: "Blocked Link(s)", value: shownLinks || "—" },
          { name: "Note", value: "docs links, staff-added trusted links, safe domains, and gif links are always allowed." }
        ],
        color: WARN
      })
    ]
  };
}

function buildCommerceUserPayload({ message, result, durationMs }) {
  return {
    embeds: [
      buildPanel({
        header: "Message Removed — Prohibited Commerce",
        body: `Timed out for ${formatDuration(durationMs)} — your message looked like a sale/trade of a prohibited item (drugs, weapons, illegal services).`,
        fields: [
          { name: "Channel", value: `<#${message.channelId}>`, inline: true },
          { name: "Why", value: result.reason || "prohibited commerce pattern", inline: false },
          { name: "Next Step", value: "If this was a mistake, talk to staff in the server." }
        ],
        color: DANGER
      })
    ]
  };
}

// ─── log panels (always routed to log channel) ───────────────────────────────

function buildBlockedLinkLogPanel({ message, signal, timeoutResult, deleteResult, dmSent, durationMs }) {
  const link = deleteResult?.deleted ? null : buildMessageUrl(message);
  const avatar = resolveAvatarURL(message.author);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";
  const shownLinks = (signal.blockedLinks || []).slice(0, 5).map((e) => `- ${e.raw}`).join("\n");
  const action = signal.action || "timeout";
  const actionText = `${action} · timeout ${timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason} · delete ${deleteResult.deleted ? "ok" : deleteResult.reason || "skipped"} · dm ${dmSent ? "✓" : "✗"}`;

  return buildRichPanel({
    title: action === "timeout"
      ? (timeoutResult.applied ? "Blocked Link Timeout" : "Blocked Link Alert")
      : action === "warn"
        ? "Blocked Link Warning"
        : "Link Review",
    author: { name: displayName, iconURL: avatar || undefined },
    fields: [
      { name: "User", value: `<@${message.author?.id}>`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Threat", value: `${signal.threatLevel || "elevated"} (${signal.confidence || 0}%)`, inline: true },
      { name: "Action", value: actionText, inline: false },
      { name: "Blocked Count", value: String(signal.blockedCount || (signal.blockedLinks || []).length || 1), inline: true },
      link ? { name: "Jump", value: `[→ Open](${link})`, inline: true } : null,
      { name: "Why", value: formatBlockedLinkReasons(signal) },
      { name: "Blocked Links", value: shownLinks || "—" },
      { name: "Evidence", value: trimExcerpt(message.content) }
    ].filter(Boolean),
    color: timeoutResult.applied ? DANGER : WARN
  });
}

function buildCommerceLogPanel({ message, result, timeoutResult, deleteResult, dmSent, durationMs }) {
  const avatar = resolveAvatarURL(message.author);
  const displayName = message.member?.displayName || message.author?.globalName || message.author?.username || "user";

  return buildRichPanel({
    title: timeoutResult.applied ? "Prohibited Commerce Timeout" : "Prohibited Commerce Alert",
    author: { name: displayName, iconURL: avatar || undefined },
    fields: [
      { name: "User", value: `<@${message.author?.id}>`, inline: true },
      { name: "Channel", value: `<#${message.channelId}>`, inline: true },
      { name: "Confidence", value: `${result.confidence || 0}%`, inline: true },
      { name: "Category", value: String(result.category || "unknown"), inline: true },
      { name: "Term", value: `\`${String(result.term || "—")}\``, inline: true },
      { name: "Timeout", value: timeoutResult.applied ? formatDuration(durationMs) : timeoutResult.reason, inline: true },
      { name: "Delete", value: deleteResult.deleted ? "ok" : deleteResult.reason || "skipped", inline: true },
      { name: "DM", value: dmSent ? "sent" : "failed", inline: true },
      { name: "Reason", value: result.reason || "prohibited pattern", inline: false },
      { name: "Evidence", value: trimExcerpt(message.content) }
    ],
    color: timeoutResult.applied ? DANGER : WARN
  });
}

// ─── action record (for log buttons: view / revert) ──────────────────────────

async function createReviewRecord(message, {
  actionType,
  actionLabel,
  timeoutMs = 0,
  timeoutApplied = false,
  deleteApplied = false,
  dmSent = false,
  reasons = [],
  now = Date.now()
} = {}) {
  try {
    await cleanupExpiredModerationActions({ now });
  } catch (err) {
    recordRuntimeEvent("warn", "moderation-action-cleanup", err?.message || err);
  }
  const expiresAt = getModerationReviewExpiresAt(now, timeoutApplied ? timeoutMs : 0);
  try {
    const actionId = await recordModerationAction({
      createdAt: now,
      expiresAt,
      guildId: message.guildId || message.guild?.id || null,
      channelId: message.channelId || null,
      messageId: message.id || null,
      messageUrl: buildMessageUrl(message),
      userId: message.author?.id || null,
      username: message.member?.displayName || message.author?.username || null,
      actionType,
      actionLabel,
      timeoutMs: timeoutApplied ? timeoutMs : 0,
      timeoutApplied,
      deleteApplied,
      dmSent,
      messageContent: message.content || "",
      recentMessages: [],
      reasons
    });
    return { actionId, expiresAt };
  } catch (err) {
    recordRuntimeEvent("warn", "moderation-action-record", err?.message || err);
    return { actionId: null, expiresAt };
  }
}

function attachLogButtons(richEmbed, { actionId, expiresAt, canRevert }) {
  if (!actionId) {
    return { embeds: [richEmbed], allowedMentions: { parse: [] } };
  }
  const reviewNote = canRevert
    ? `Context + undo controls expire ${formatModerationActionReviewWindow(expiresAt)}`
    : `Context review expires ${formatModerationActionReviewWindow(expiresAt)}`;
  try {
    const existing = richEmbed.data?.footer?.text || "";
    richEmbed.setFooter({ text: existing ? `${existing} · ${reviewNote}` : reviewNote });
  } catch {}
  return {
    embeds: [richEmbed],
    components: buildModerationLogButtonRows(actionId, { canRevert }),
    allowedMentions: { parse: [] }
  };
}

// ─── action handlers ─────────────────────────────────────────────────────────

async function handleBlockedLinkMessage(message, signal, {
  sendLog = sendLogPanel,
  now = Date.now()
} = {}) {
  const action = signal.action || "timeout";
  const timeoutMs = Number(signal.timeoutMs || 0) > 0 ? Number(signal.timeoutMs) : LINK_MODERATION_TIMEOUT_MS;
  const timeoutResult = action === "timeout"
    ? await tryTimeoutMessageMember(message.member, timeoutMs, "high-risk link")
    : { applied: false, reason: action === "warn" ? "warning only" : "not needed" };
  const dmSent = (action === "timeout" || action === "warn")
    ? await safeSend(message.author, buildBlockedLinkUserPayload({ message, signal, durationMs: timeoutMs }))
    : false;
  const deleteResult = action !== "review"
    ? await tryDeleteMessage(message)
    : { deleted: false, reason: "review only" };

  if (action === "timeout" && !timeoutResult.applied) {
    recordRuntimeEvent("warn", "blocked-link-timeout", timeoutResult.reason);
  }
  await recordModerationStat(
    action === "timeout"
      ? (timeoutResult.applied ? "blocked_link_timeout" : "blocked_link_alert")
      : action === "warn"
        ? "blocked_link_warning"
        : "blocked_link_review",
    now
  );

  const embed = buildBlockedLinkLogPanel({
    message, signal, timeoutResult, deleteResult, dmSent, durationMs: timeoutMs
  });
  const review = await createReviewRecord(message, {
    actionType: "blocked_link",
    actionLabel: action === "timeout" ? (timeoutResult.applied ? "Blocked Link Timeout" : "Blocked Link Alert") : "Blocked Link Warning",
    timeoutMs,
    timeoutApplied: timeoutResult.applied,
    deleteApplied: deleteResult.deleted,
    dmSent,
    reasons: signal.reasons || [],
    now
  });
  const payload = attachLogButtons(embed, {
    actionId: review.actionId,
    expiresAt: review.expiresAt,
    canRevert: timeoutResult.applied
  });
  await sendLog(message.guild, payload).catch(() => null);

  return action !== "review";
}

async function handleProhibitedCommerceMessage(message, result, {
  sendLog = sendLogPanel,
  now = Date.now()
} = {}) {
  const timeoutMs = 60 * 60 * 1000; // 1 hour for commerce violations
  const timeoutResult = await tryTimeoutMessageMember(message.member, timeoutMs, "prohibited commerce");
  const dmSent = await safeSend(message.author, buildCommerceUserPayload({ message, result, durationMs: timeoutMs }));
  const deleteResult = await tryDeleteMessage(message);

  if (!timeoutResult.applied) {
    recordRuntimeEvent("warn", "commerce-timeout", timeoutResult.reason);
  }
  await recordModerationStat(
    timeoutResult.applied ? "commerce_timeout" : "commerce_alert",
    now
  );

  const embed = buildCommerceLogPanel({
    message, result, timeoutResult, deleteResult, dmSent, durationMs: timeoutMs
  });
  const review = await createReviewRecord(message, {
    actionType: "prohibited_commerce",
    actionLabel: timeoutResult.applied ? "Prohibited Commerce Timeout" : "Prohibited Commerce Alert",
    timeoutMs,
    timeoutApplied: timeoutResult.applied,
    deleteApplied: deleteResult.deleted,
    dmSent,
    reasons: [result.reason || "prohibited pattern"],
    now
  });
  const payload = attachLogButtons(embed, {
    actionId: review.actionId,
    expiresAt: review.expiresAt,
    canRevert: timeoutResult.applied
  });
  await sendLog(message.guild, payload).catch(() => null);

  return true;
}

// ─── entry point ─────────────────────────────────────────────────────────────

async function maybeHandleModerationWatch(message, {
  kb,
  fetchKbFn = fetchKb,
  checkThreatIntel,
  sendLog = sendLogPanel,
  now = Date.now()
} = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return false;
  if (hasBypassPermission(message)) return false;
  if (await hasManualWhitelistBypass(message)) return false;

  try {
    const policyEnforcementEnabled = await getPolicyEnforcementEnabled().catch(() => true);
    const hasLink = mightContainLink(message.content);
    let resolvedKb = kb || null;
    if (!resolvedKb && hasLink && policyEnforcementEnabled) {
      resolvedKb = await fetchKbFn().catch(() => null);
    }

    // 1) Link policy
    if (hasLink) {
      let blockedLinkSignal = null;
      if (policyEnforcementEnabled && resolvedKb) {
        const trustedLinks = await listTrustedLinks().catch((err) => {
          recordRuntimeEvent("warn", "trusted-link-list", err?.message || err);
          return [];
        });
        blockedLinkSignal = await detectBlockedLinkSignalAsync(message.content, {
          kb: resolvedKb,
          trustedLinks,
          posterContext: getPosterLinkContext(message, now),
          checkThreatIntel
        });
      } else {
        blockedLinkSignal = await detectFishFishOnlyLinkSignal(message.content).catch((err) => {
          recordRuntimeEvent("warn", "fishfish-only-check", err?.message || err);
          return null;
        });
      }
      if (blockedLinkSignal) {
        const handled = await handleBlockedLinkMessage(message, blockedLinkSignal, { sendLog, now });
        if (handled) return true;
      }
    }

    // 2) Prohibited commerce (gated by $policy toggle)
    if (policyEnforcementEnabled) {
      const commerceResult = detectProhibitedCommerce([message.content]);
      if (commerceResult) {
        const handled = await handleProhibitedCommerceMessage(message, commerceResult, { sendLog, now });
        if (handled) return true;
      }
    }

    return false;
  } catch (err) {
    console.warn("Moderation watcher failed:", err.message);
    recordRuntimeEvent("warn", "moderation-watch", err?.message || err);
    return false;
  }
}

// ─── moderation log button handler (view / revert) ───────────────────────────

function parseModerationLogInteraction(customId) {
  const raw = String(customId || "");
  if (raw.startsWith(MODLOG_VIEW_PREFIX)) {
    return { type: "view", actionId: raw.slice(MODLOG_VIEW_PREFIX.length) };
  }
  if (raw.startsWith(MODLOG_REVERT_PREFIX)) {
    return { type: "revert", actionId: raw.slice(MODLOG_REVERT_PREFIX.length) };
  }
  return null;
}

function canUseModerationLogTools(interaction) {
  return canUseEmojiCommands({
    author: interaction?.user,
    member: interaction?.member
  });
}

function buildInteractionPayload(panel, { ephemeral = true } = {}) {
  const payload = {
    embeds: [buildPanel(panel)],
    allowedMentions: { parse: [] }
  };
  if (ephemeral) payload.ephemeral = true;
  return payload;
}

async function replyToModerationLogInteraction(interaction, panel) {
  if (interaction?.deferred || interaction?.replied) {
    await interaction.editReply?.(buildInteractionPayload(panel, { ephemeral: false })).catch(() => null);
    return true;
  }
  await interaction.reply?.(buildInteractionPayload(panel)).catch(() => null);
  return true;
}

async function deferModerationLogInteraction(interaction) {
  if (interaction?.deferred || interaction?.replied || !interaction?.deferReply) return false;
  await interaction.deferReply({ ephemeral: true }).catch(() => null);
  return true;
}

async function disableModerationLogButtons(interaction, actionId) {
  await interaction?.message?.edit?.({
    components: buildModerationLogButtonRows(actionId, { canRevert: false, disabled: true })
  }).catch(() => null);
}

async function resolveActionChannel(guild, channelId) {
  if (!guild?.channels || !channelId) return null;
  const cached = guild.channels.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild.channels.fetch === "function") {
    return guild.channels.fetch(channelId).catch(() => null);
  }
  return null;
}

function asMessageArray(messages) {
  if (!messages) return [];
  if (Array.isArray(messages)) return messages;
  if (typeof messages.values === "function") return [...messages.values()];
  if (messages.cache && typeof messages.cache.values === "function") return [...messages.cache.values()];
  return [];
}

async function fetchVisibleUserMessages(guild, action) {
  const channel = await resolveActionChannel(guild, action.channelId);
  if (!channel?.messages?.fetch) return [];
  const fetched = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return asMessageArray(fetched)
    .filter((entry) => entry?.author?.id === action.userId)
    .sort((a, b) => Number(a.createdTimestamp || 0) - Number(b.createdTimestamp || 0))
    .slice(-MODERATION_CONTEXT_VIEW_LIMIT);
}

function formatVisibleActionMessages(messages) {
  if (!messages.length) return "no visible recent messages found in that channel";
  return messages.map((entry, index) => {
    const when = entry.createdTimestamp ? formatDiscordTimestamp(entry.createdTimestamp, "R") : "recent";
    const jump = entry.url ? ` [jump](${entry.url})` : "";
    return `${index + 1}. ${when}${jump} - ${trimExcerpt(entry.content || "(no text)", 170)}`;
  }).join("\n");
}

function buildActionMessagesPanel(action, visibleMessages) {
  return {
    header: "User Message Context",
    fields: [
      { name: "User", value: action.userId ? `<@${action.userId}>` : action.username || "unknown", inline: true },
      action.channelId ? { name: "Channel", value: `<#${action.channelId}>`, inline: true } : null,
      { name: "Original Action", value: action.actionLabel, inline: true },
      { name: "Review Window", value: `closes ${formatModerationActionReviewWindow(action.expiresAt)}` },
      action.messageUrl && !action.deleteApplied ? { name: "Original Jump", value: `[→ Open](${action.messageUrl})` } : null,
      { name: "Stored Trigger", value: trimExcerpt(action.messageContent || "(no text)", 220) },
      { name: "Still Visible", value: formatVisibleActionMessages(visibleMessages) }
    ].filter(Boolean),
    color: INFO
  };
}

function buildModerationActionExpiredPanel() {
  return {
    header: "Review Window Closed",
    body: "that log review record expired or was already resolved, so the buttons have been retired",
    color: WARN
  };
}

async function resolveActionMember(guild, userId) {
  if (!guild?.members || !userId) return null;
  const cached = guild.members.cache?.get?.(userId);
  if (cached) return cached;
  if (typeof guild.members.fetch === "function") {
    return guild.members.fetch(userId).catch(() => null);
  }
  return null;
}

async function resolveActionUser(interaction, action, member) {
  if (member?.send || member?.user?.send) return member.user || member;
  if (interaction?.client?.users?.fetch && action.userId) {
    return interaction.client.users.fetch(action.userId).catch(() => null);
  }
  return null;
}

function buildRevertUserPayload({ action, actor }) {
  const actorLabel = actor?.id ? `<@${actor.id}>` : actor?.username || actor?.tag || "staff";
  return {
    embeds: [
      buildPanel({
        header: "Timeout Cleared",
        body: `Your timeout was cleared by ${actorLabel}. Sorry for the wrong call.`,
        fields: action.channelId ? [
          { name: "Original Channel", value: `<#${action.channelId}>`, inline: true }
        ] : [],
        color: SUCCESS
      })
    ],
    allowedMentions: { parse: [] }
  };
}

function buildRevertLogPanel({ action, actor, dmSent }) {
  return {
    header: "Moderation Action Reverted",
    body: "staff reverted a moderation timeout from the log controls",
    fields: [
      { name: "User", value: action.userId ? `<@${action.userId}>` : action.username || "unknown", inline: true },
      { name: "Reverted By", value: actor?.id ? `<@${actor.id}>` : actor?.username || "staff", inline: true },
      action.channelId ? { name: "Channel", value: `<#${action.channelId}>`, inline: true } : null,
      { name: "Original Action", value: action.actionLabel, inline: true },
      { name: "Original Timeout", value: formatDuration(action.timeoutMs || 0), inline: true },
      { name: "User DM", value: dmSent ? "sent" : "not sent", inline: true },
      action.messageUrl ? { name: "Original Jump", value: `[→ Open trigger](${action.messageUrl})` } : null
    ].filter(Boolean),
    color: SUCCESS
  };
}

async function handleModerationLogView(interaction, actionId, { now = Date.now() } = {}) {
  const action = await getModerationAction(actionId, { now });
  if (!action) {
    await disableModerationLogButtons(interaction, actionId);
    await replyToModerationLogInteraction(interaction, buildModerationActionExpiredPanel());
    return true;
  }
  const visibleMessages = await fetchVisibleUserMessages(interaction.guild, action);
  await replyToModerationLogInteraction(interaction, buildActionMessagesPanel(action, visibleMessages));
  return true;
}

async function handleModerationLogRevert(interaction, actionId, {
  sendLog = sendLogPanel,
  now = Date.now()
} = {}) {
  await deferModerationLogInteraction(interaction);
  const action = await getModerationAction(actionId, { now });
  if (!action) {
    await disableModerationLogButtons(interaction, actionId);
    await replyToModerationLogInteraction(interaction, buildModerationActionExpiredPanel());
    return true;
  }
  if (!action.timeoutApplied) {
    await replyToModerationLogInteraction(interaction, {
      header: "Nothing Reversible Stored",
      body: "this log has context to review, but no active timeout was stored. Deleted messages cannot be restored from Discord.",
      color: WARN
    });
    return true;
  }
  const member = await resolveActionMember(interaction.guild, action.userId);
  if (!member?.timeout) {
    await replyToModerationLogInteraction(interaction, {
      header: "Could Not Revert",
      body: "i could not fetch that member or clear their timeout. staff may need to check Discord manually.",
      color: DANGER
    });
    return true;
  }
  try {
    await member.timeout(null, `moderation action reverted by ${interaction.user?.tag || interaction.user?.id || "staff"}`);
  } catch (err) {
    await replyToModerationLogInteraction(interaction, {
      header: "Could Not Revert",
      body: `Discord refused the timeout clear: ${err?.message || err}`,
      color: DANGER
    });
    return true;
  }
  const target = await resolveActionUser(interaction, action, member);
  const dmSent = await safeSend(target, buildRevertUserPayload({ action, actor: interaction.user }));
  await deleteModerationAction(action.id);
  await disableModerationLogButtons(interaction, action.id);
  await sendLog(interaction.guild, buildRevertLogPanel({ action, actor: interaction.user, dmSent })).catch(() => null);
  await replyToModerationLogInteraction(interaction, {
    header: "Action Reverted",
    body: [
      `timeout cleared for ${action.userId ? `<@${action.userId}>` : action.username || "that user"}`,
      `**User DM:** ${dmSent ? "sent" : "not sent"}`,
      "**SQLite:** review record deleted"
    ].join("\n"),
    color: SUCCESS
  });
  return true;
}

async function maybeHandleModerationLogInteraction(interaction, deps = {}) {
  if (!interaction?.isButton?.()) return false;
  const parsed = parseModerationLogInteraction(interaction.customId);
  if (!parsed?.actionId) return false;

  if (!interaction.inGuild?.()) {
    await replyToModerationLogInteraction(interaction, {
      header: "Server Only",
      body: "these moderation log tools only work inside the Kicia server log channel",
      color: WARN
    });
    return true;
  }
  if (!canUseModerationLogTools(interaction)) {
    await replyToModerationLogInteraction(interaction, {
      header: "Staff Tools Locked",
      body: "only staff and above can use log review controls",
      color: WARN
    });
    return true;
  }
  if (parsed.type === "view") return handleModerationLogView(interaction, parsed.actionId, deps);
  if (parsed.type === "revert") return handleModerationLogRevert(interaction, parsed.actionId, deps);
  return false;
}

function resetModerationState() {
  // No in-memory state in the new pipeline (link policy + commerce both
  // stateless). Kept for backwards-compat with tests.
}

module.exports = {
  hasBypassPermission,
  maybeHandleModerationWatch,
  maybeHandleModerationLogInteraction,
  resetModerationState
};
