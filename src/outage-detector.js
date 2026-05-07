const { getConfiguredChannelId, getStaffChannelId } = require("./channel-config");
const { buildPanel, DANGER, INFO, WARN } = require("./embed");
const { applyAutomaticLockdown } = require("./handlers/lockdown");
const { sendLogPanel } = require("./log-channel");
const { recordRuntimeEvent } = require("./runtime-health");
const { setRuntimeStatus } = require("./runtime-status");
const { normalizeText } = require("./text");
const { safeSend } = require("./utils/respond");

const OUTAGE_DETECTION_WINDOW_MS = 10 * 60 * 1000;
const OUTAGE_DETECTION_THRESHOLD = 4;
const OUTAGE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const OUTAGE_SAMPLE_LIMIT = 5;

const outageBuckets = new Map();

const PRODUCT_CONTEXT_RE =
  /\b(?:kicia|kiciahook|kh|kcia|kicka|loader|client|script|executor|premium|prem|prm|v3)\b/;
const OUTAGE_STATUS_RE =
  /\b(?:down|offline|dead|broken|broke|bugging|bugged|freezing|frozen|crashing|crashed|crash|patched|detected|stuck|error|errors)\b/;
const NEGATIVE_WORK_RE =
  /\b(?:doesn t|doesnt|does not|dont|do not|isn t|isnt|is not|not|wont|won t|will not|cant|can t|cannot)\b.{0,28}\b(?:work|working|load|loading|open|opening|inject|injecting|launch|launching)\b/;
const NEGATIVE_WORK_REVERSED_RE =
  /\b(?:work|working|load|loading|open|opening|inject|injecting|launch|launching)\b.{0,28}\b(?:doesn t|doesnt|does not|dont|do not|isn t|isnt|is not|not|wont|won t|will not|cant|can t|cannot)\b/;
const ISSUE_REPORT_RE =
  /\b(?:everyone|anyone|anybody|somebody|ppl|people|users?)\b.{0,40}\b(?:down|broken|not working|doesnt work|doesn t work|cant load|can t load|detected|patched)\b/;
const SOFT_QUESTION_RE = /^(?:does|do|is|are|can|could|will|when|where|why|how)\b/;

function getOutageBucket(guildId) {
  const key = String(guildId || "global");
  if (!outageBuckets.has(key)) {
    outageBuckets.set(key, {
      events: [],
      lastTriggeredAt: 0
    });
  }
  return outageBuckets.get(key);
}

function trimExcerpt(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 12)).trim()}...(trimmed)`;
}

function detectOutageStatusComplaint(content) {
  const normalized = normalizeText(content);
  if (!normalized) return null;

  const compact = normalized.replace(/\s+/g, "");
  const hasProductContext =
    PRODUCT_CONTEXT_RE.test(normalized) ||
    /\bkiciahook\b/.test(compact) ||
    /\bkiciav3\b/.test(compact);
  if (!hasProductContext) return null;

  const hasHardOutageSignal =
    OUTAGE_STATUS_RE.test(normalized) ||
    NEGATIVE_WORK_RE.test(normalized) ||
    NEGATIVE_WORK_REVERSED_RE.test(normalized) ||
    ISSUE_REPORT_RE.test(normalized);
  if (!hasHardOutageSignal) return null;

  const isSoftQuestion = SOFT_QUESTION_RE.test(normalized) && !OUTAGE_STATUS_RE.test(normalized);
  const confidence = isSoftQuestion ? 72 : NEGATIVE_WORK_RE.test(normalized) ? 90 : 84;

  return {
    type: "outage_status_complaint",
    confidence,
    normalized,
    reason: "Kicia outage/not-working wording with product context"
  };
}

function observeOutageMessage(message, { now = Date.now() } = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return null;
  const signal = detectOutageStatusComplaint(message.content);
  if (!signal) return null;

  const bucket = getOutageBucket(message.guildId);
  const cutoff = now - OUTAGE_DETECTION_WINDOW_MS;
  bucket.events = bucket.events.filter((entry) => entry.at >= cutoff);
  bucket.events.push({
    at: now,
    userId: message.author?.id || "unknown",
    channelId: message.channelId,
    messageId: message.id,
    url: message.url || "",
    content: String(message.content || ""),
    normalized: signal.normalized,
    confidence: signal.confidence
  });

  const distinctUsers = new Set(bucket.events.map((entry) => entry.userId).filter(Boolean));
  const result = {
    signal,
    triggered: false,
    count: distinctUsers.size,
    threshold: OUTAGE_DETECTION_THRESHOLD,
    windowMs: OUTAGE_DETECTION_WINDOW_MS,
    cooldownMs: OUTAGE_ALERT_COOLDOWN_MS,
    events: bucket.events.slice(-OUTAGE_SAMPLE_LIMIT)
  };

  if (distinctUsers.size < OUTAGE_DETECTION_THRESHOLD) return result;
  if (bucket.lastTriggeredAt && now - bucket.lastTriggeredAt < OUTAGE_ALERT_COOLDOWN_MS) {
    return {
      ...result,
      cooldownRemainingMs: OUTAGE_ALERT_COOLDOWN_MS - (now - bucket.lastTriggeredAt)
    };
  }

  bucket.lastTriggeredAt = now;
  return {
    ...result,
    triggered: true
  };
}

async function fetchGuildChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const cached = guild.channels?.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild.channels?.fetch === "function") {
    return guild.channels.fetch(channelId).catch(() => null);
  }
  return null;
}

function formatOutageSamples(events = []) {
  if (!events.length) return "no samples captured";
  return events
    .map((entry) => {
      const channel = entry.channelId ? `<#${entry.channelId}>` : "unknown channel";
      return `- <@${entry.userId}> in ${channel}: ${trimExcerpt(entry.content, 120)}`;
    })
    .join("\n");
}

function formatLockResult(lockResult) {
  if (!lockResult) return "lock helper did not run";
  const changed = lockResult.result?.changed?.length || 0;
  const skipped = lockResult.result?.skipped?.length || 0;
  if (lockResult.ok) return `locked configured channels (${changed} changed, ${skipped} already locked)`;
  return `needs review: ${lockResult.error || "unknown lock failure"}`;
}

function buildOutageGeneralPayload(result, { lockResult } = {}) {
  return {
    content: "## ISSUE DETECTED [Auto Detection]",
    embeds: [
      buildPanel({
        header: "KiciaHook Issue Detected",
        body: [
          "Multiple different users are reporting that KiciaHook is not working.",
          "",
          "**Auto Actions**",
          "- Status set to **DOWN**",
          `- Chat lock: ${formatLockResult(lockResult)}`,
          "",
          "Staff has been alerted. Use the status channel for updates."
        ].join("\n"),
        color: DANGER
      })
    ],
    allowedMentions: { parse: [] }
  };
}

function buildOutageStaffPayload(result, { lockResult } = {}) {
  return {
    embeds: [
      buildPanel({
        header: "Outage Auto Detection",
        body: [
          `**Signal:** ${result.count}/${result.threshold} distinct users in 10 minutes`,
          `**Status:** set to DOWN`,
          `**Lock:** ${formatLockResult(lockResult)}`,
          "",
          "**Recent Samples**",
          formatOutageSamples(result.events)
        ].join("\n"),
        color: WARN
      })
    ],
    allowedMentions: { parse: [] }
  };
}

function buildOutageLogPanel(result, {
  generalSent = false,
  staffSent = false,
  lockResult = null
} = {}) {
  return {
    header: "Outage Auto Detection Triggered",
    body: [
      `**Distinct Users:** ${result.count}/${result.threshold}`,
      `**Window:** ${Math.round(result.windowMs / 60_000)} minutes`,
      `**Status Action:** DOWN`,
      `**General Alert:** ${generalSent ? "sent" : "not sent"}`,
      `**Staff Alert:** ${staffSent ? "sent" : "not sent or not configured"}`,
      `**Auto Lock:** ${formatLockResult(lockResult)}`,
      "",
      "**Recent Samples**",
      formatOutageSamples(result.events)
    ].join("\n"),
    color: DANGER
  };
}

async function sendConfiguredChannel(guild, channelId, payload) {
  const channel = await fetchGuildChannel(guild, channelId);
  if (!channel) return false;
  return safeSend(channel, payload);
}

async function maybeHandleOutageDetection(message, {
  now = Date.now(),
  sendLog = sendLogPanel,
  lockChannels = applyAutomaticLockdown
} = {}) {
  const result = observeOutageMessage(message, { now });
  if (!result?.triggered) return false;

  setRuntimeStatus("DOWN");
  const lockResult = await lockChannels(message.guild, {
    actorId: "auto-detection",
    actor: "Auto Detection",
    reason: "multiple distinct Kicia not-working reports",
    sendLog
  }).catch((err) => ({
    ok: false,
    error: err?.message || String(err),
    result: {
      changed: [],
      skipped: []
    }
  }));

  const generalSent = await sendConfiguredChannel(
    message.guild,
    getConfiguredChannelId("general"),
    buildOutageGeneralPayload(result, { lockResult })
  );
  const staffChannelId = getStaffChannelId();
  const staffSent = staffChannelId
    ? await sendConfiguredChannel(message.guild, staffChannelId, buildOutageStaffPayload(result, { lockResult }))
    : false;

  await sendLog(message.guild, buildOutageLogPanel(result, {
    generalSent,
    staffSent,
    lockResult
  })).catch((err) => {
    recordRuntimeEvent("warn", "outage-auto-log", err?.message || err);
  });

  recordRuntimeEvent(
    "warn",
    "outage-auto-detection",
    `triggered by ${result.count}/${result.threshold} distinct users`
  );
  return true;
}

function resetOutageDetectionState() {
  outageBuckets.clear();
}

module.exports = {
  OUTAGE_DETECTION_THRESHOLD,
  OUTAGE_DETECTION_WINDOW_MS,
  buildOutageGeneralPayload,
  buildOutageLogPanel,
  buildOutageStaffPayload,
  detectOutageStatusComplaint,
  maybeHandleOutageDetection,
  observeOutageMessage,
  resetOutageDetectionState
};
