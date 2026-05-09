const {
  getConfiguredChannelId,
  getStaffChannelId
} = require("./channel-config");
const { buildOutageReviewButtonRows } = require("./components");
const {
  buildPanel,
  DANGER,
  INFO,
  SUCCESS,
  WARN,
  brandAuthor,
  ansi,
  terminalBlock,
  kpi,
  kpiTone
} = require("./embed");
const viz = require("./embed-viz");
const ui = require("./ui");
const {
  applyAutomaticLockdown,
  applyAutomaticUnlockdown
} = require("./handlers/lockdown");
const { sendLogPanel } = require("./log-channel");
const { recordRuntimeEvent } = require("./runtime-health");
const { setRuntimeStatus } = require("./runtime-status");
const { foldConfusableText } = require("./text");
const { safeSend } = require("./utils/respond");

// Tuning ----------------------------------------------------------------------

const OUTAGE_DETECTION_WINDOW_MS = 10 * 60 * 1000;
const OUTAGE_DETECTION_THRESHOLD = 4;
const OUTAGE_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const OUTAGE_REVIEW_TTL_MS = 2 * 60 * 60 * 1000;
const OUTAGE_SAMPLE_LIMIT = 5;
const OUTAGE_SIGNAL_MIN_CONFIDENCE = 70;

// Detection -------------------------------------------------------------------

// Brand subjects that legitimately mean "Kicia / KiciaHook".
const BRAND_RE = /\b(?:kicia(?:hook)?|kcia|kicka|kichia|kh)\b/i;

// Words that imply Kicia is in a broken state.
const STATUS_WORDS = [
  "dead", "ded", "down", "dn", "offline", "ofline", "off line",
  "broken", "broke", "busted", "borked", "borken",
  "crashed", "crashing", "crash",
  "patched", "stuck", "frozen", "freezing", "freezeing",
  "bugged", "bugging", "bricked"
];
const STATUS_WORD_RE = new RegExp(`\\b(?:${STATUS_WORDS.map(escapeForAlternation).join("|")})\\b`, "i");

const NEG_VERB_GROUP = "(?:work(?:ing|s)?|load(?:ing|s)?|inject(?:ing|s)?|launch(?:ing|es)?|open(?:ing|s)?|connect(?:ing|s)?|respond(?:ing|s)?|start(?:ing|s)?)";
const NEG_PREFIX = "(?:not|no|isn[' ]?t|isnt|ain[' ]?t|aint|doesn[' ]?t|doesnt|won[' ]?t|wont|will\\s+not|can[' ]?t|cant|cannot)";

// Direct: brand IS dead/down/etc.
const BRAND_IS_STATUS_RE = new RegExp(
  `\\b(?:kicia(?:hook)?|kcia|kicka|kichia|kh)\\b(?:\\s+(?:is|was|are|been|got|seems|looks|appears|just|gone|currently))?\\s+(?:${STATUS_WORDS.map(escapeForAlternation).join("|")})\\b`,
  "i"
);
// Direct: brand DOESN'T work/load.
const BRAND_NEG_VERB_RE = new RegExp(
  `\\b(?:kicia(?:hook)?|kcia|kicka|kichia|kh)\\b(?:\\s+(?:is|are|just|currently))?\\s+${NEG_PREFIX}\\s+${NEG_VERB_GROUP}\\b`,
  "i"
);
// Inverse: NEG VERB ... BRAND ("not loading kicia", "doesnt work in kicia").
const NEG_VERB_BRAND_RE = new RegExp(
  `${NEG_PREFIX}\\s+${NEG_VERB_GROUP}\\b(?:[^\\n]{0,20})?\\b(?:kicia(?:hook)?|kcia|kicka|kichia|kh)\\b`,
  "i"
);
// Question: "is kicia down?".
const IS_BRAND_STATUS_RE = new RegExp(
  `\\b(?:is|are|was)\\s+(?:kicia(?:hook)?|kcia|kicka|kichia|kh)\\s+(?:still\\s+|currently\\s+)?(?:${STATUS_WORDS.map(escapeForAlternation).join("|")})\\b`,
  "i"
);
// Anyone-form: "anyone else having kicia issues / kicia down".
const ANYONE_BRAND_STATUS_RE = new RegExp(
  `\\b(?:anyone|anybody|y'?all|yall|us|everyone)\\b[^\\n]{0,30}\\b(?:kicia(?:hook)?|kcia|kicka|kichia|kh)\\b[^\\n]{0,40}\\b(?:${STATUS_WORDS.map(escapeForAlternation).join("|")})\\b`,
  "i"
);

// Reject patterns -------------------------------------------------------------

const POSITIVE_FINE_RE = /\b(?:not\s+down|isn[' ]?t\s+down|isnt\s+down|works\s+fine|working\s+fine|all\s+good|fine\s+for\s+me|still\s+(?:up|fine|working))\b/i;
const SELF_DOWN_RE = /\b(?:i'?m|im|i\s+am|me|my\s+(?:phone|pc|laptop|computer|wifi|internet|router|account))\b[^.\n]{0,30}\b(?:down|crashed|crashing|broke|broken|bugged|bugging|frozen|stuck)\b/i;
const FUTURE_RE = /\b(?:will\s+be|going\s+to|gonna|might|maybe|may)\b[^.\n]{0,20}\b(?:down|patched|fixed)\b/i;
const REPORT_DISCUSS_RE = /\b(?:was|earlier|yesterday|last\s+(?:night|week|time)|previously|used\s+to)\b[^.\n]{0,30}\b(?:down|broken|crashed)\b/i;
const QUESTION_LEAD_RE = /^(?:is|are|why|when|where|how|does|do|did|will|could)\b/i;

// Keep a public-facing alias so importers can spot the pattern source easily.
const PRODUCT_CONTEXT_RE = BRAND_RE;
const OUTAGE_STATUS_RE = STATUS_WORD_RE;
const NEGATIVE_WORK_RE = new RegExp(`${NEG_PREFIX}\\s+${NEG_VERB_GROUP}`, "i");

function escapeForAlternation(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function foldOutageText(content) {
  return foldConfusableText(String(content || "").toLowerCase())
    .replace(/[^a-z0-9'\s\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectOutageStatusComplaint(content) {
  if (!content) return null;
  const folded = foldOutageText(content);
  if (!folded) return null;

  // Cheap rejects that should win over later signal detection.
  if (POSITIVE_FINE_RE.test(folded)) return null;
  if (SELF_DOWN_RE.test(folded)) return null;
  if (FUTURE_RE.test(folded)) return null;
  if (REPORT_DISCUSS_RE.test(folded)) return null;

  // Must mention Kicia/KiciaHook/KH explicitly as the actor.
  if (!BRAND_RE.test(folded)) return null;

  const directHit =
    BRAND_IS_STATUS_RE.test(folded) ||
    BRAND_NEG_VERB_RE.test(folded) ||
    NEG_VERB_BRAND_RE.test(folded) ||
    IS_BRAND_STATUS_RE.test(folded) ||
    ANYONE_BRAND_STATUS_RE.test(folded);

  if (!directHit) return null;

  const isQuestion = QUESTION_LEAD_RE.test(folded);
  const confidence = isQuestion ? 70 : 88;

  return {
    type: "outage_status_complaint",
    confidence,
    normalized: folded,
    reason: "Kicia outage/not-working pattern with brand subject"
  };
}

// Bucket state ----------------------------------------------------------------

const outageBuckets = new Map();
const pendingReviews = new Map();

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

function observeOutageMessage(message, { now = Date.now() } = {}) {
  if (!message?.inGuild?.() || message.author?.bot) return null;
  const signal = detectOutageStatusComplaint(message.content);
  if (!signal) return null;
  if (signal.confidence < OUTAGE_SIGNAL_MIN_CONFIDENCE) return { signal, triggered: false };

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

// Review state ----------------------------------------------------------------

function buildReviewId(guildId, now) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${String(guildId || "global")}-${now.toString(36)}-${random}`;
}

function pruneExpiredReviews(now = Date.now()) {
  for (const [reviewId, review] of pendingReviews.entries()) {
    if (review.expiresAt <= now) pendingReviews.delete(reviewId);
  }
}

function getPendingReviewForGuild(guildId) {
  for (const review of pendingReviews.values()) {
    if (review.guildId === guildId && review.status === "pending") return review;
  }
  return null;
}

function getReview(reviewId) {
  return pendingReviews.get(String(reviewId || "")) || null;
}

function clearPendingReviewsForGuild(guildId) {
  for (const [reviewId, review] of pendingReviews.entries()) {
    if (review.guildId === guildId) pendingReviews.delete(reviewId);
  }
}

// Panels ----------------------------------------------------------------------

function formatOutageSamples(events = []) {
  if (!events.length) return "no samples captured";
  return events
    .map((entry) => {
      const channel = entry.channelId ? `<#${entry.channelId}>` : "unknown channel";
      const link = entry.url ? ` ([jump](${entry.url}))` : "";
      return `- <@${entry.userId}> in ${channel}${link}: ${trimExcerpt(entry.content, 120)}`;
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

function formatUnlockResult(unlockResult) {
  if (!unlockResult) return "unlock helper did not run";
  const changed = unlockResult.result?.changed?.length || 0;
  const skipped = unlockResult.result?.skipped?.length || 0;
  if (unlockResult.ok) return `unlocked configured channels (${changed} changed, ${skipped} already unlocked)`;
  return `needs review: ${unlockResult.error || "unknown unlock failure"}`;
}

function buildOutageGeneralPayload() {
  const built = ui.buildOutagePublic({ since: "a few minutes ago" });
  return {
    content: "## 🚨 Issue Detected · [Auto Detect]",
    embeds: built.embeds,
    components: built.components,
    files: built.files,
    allowedMentions: { parse: [] }
  };
}

function buildOutageStaffPayload(result, { lockResult, reviewId } = {}) {
  const events = result.events || [];
  const windowMin = Math.round(result.windowMs / 60_000);
  const total = Math.max(1, events.length);
  const reports = events.slice(0, 8).map((evt, idx) => {
    const u = evt.userTag || evt.userId || `user${idx + 1}`;
    const t = ((idx + 0.5) * windowMin) / total;
    const conf = typeof evt.confidence === "number" ? evt.confidence : 80;
    return { t, user: u, conf };
  });

  const built = ui.buildOutageStaffReview({
    reports,
    threshold: result.threshold,
    windowMin,
    caseId: reviewId ? String(reviewId).slice(0, 12) : "O-0000"
  });

  return {
    embeds: built.embeds,
    files: built.files,
    components: buildOutageReviewButtonRows(reviewId),
    allowedMentions: { parse: [] }
  };
}

function buildOutageLogPanel(result, {
  generalSent = false,
  staffSent = false,
  lockResult = null,
  reviewId = null
} = {}) {
  return {
    header: "Outage Auto Detection Triggered",
    author: brandAuthor("OUTAGE LOG"),
    body: [
      `**Distinct Users:** ${result.count}/${result.threshold}`,
      `**Window:** ${Math.round(result.windowMs / 60_000)} minutes`,
      `**Status Action:** UNAWARE (pending staff confirmation)`,
      `**General Alert:** ${generalSent ? "sent" : "not sent"}`,
      `**Staff Review:** ${staffSent ? "sent with buttons" : "not sent or not configured"}`,
      `**Auto Lock:** ${formatLockResult(lockResult)}`,
      reviewId ? `**Review ID:** \`${reviewId}\`` : null,
      "",
      "**Recent Samples**",
      formatOutageSamples(result.events)
    ].filter(Boolean).join("\n"),
    fields: [
      kpiTone("DISTINCT", `${result.count}/${result.threshold}`, "warn"),
      kpi("WINDOW", `${Math.round(result.windowMs / 60_000)}m`),
      kpi("STATUS", "UNAWARE")
    ],
    color: WARN,
    components: reviewId ? buildOutageReviewButtonRows(reviewId) : []
  };
}

function buildOutageResolvedGeneralPayload({ resolution, actor, unlockResult }) {
  if (resolution === "confirmed") {
    const built = ui.buildOutageConfirmed({ since: "a few minutes ago" });
    return {
      embeds: built.embeds,
      components: built.components,
      files: built.files,
      allowedMentions: { parse: [] }
    };
  }
  const built = ui.buildOutageCleared({ uptime: 99.81 });
  return {
    embeds: built.embeds,
    components: built.components,
    files: built.files,
    allowedMentions: { parse: [] }
  };
}

function buildOutageResolvedLogPanel({ resolution, review, actor, unlockResult }) {
  return {
    header: resolution === "confirmed"
      ? "Outage Review — Confirmed"
      : "Outage Review — False Alarm",
    body: [
      `**Resolution:** ${resolution}`,
      `**Reviewed By:** ${actor || "unknown"}`,
      `**Distinct Users:** ${review?.distinctUsers || 0}`,
      resolution === "confirmed"
        ? "**Status Action:** kept DOWN, channels stay locked"
        : `**Status Action:** restored UP, ${formatUnlockResult(unlockResult)}`,
      review?.reviewId ? `**Review ID:** \`${review.reviewId}\`` : null
    ].filter(Boolean).join("\n"),
    color: resolution === "confirmed" ? DANGER : SUCCESS
  };
}

// Channel sends ---------------------------------------------------------------

async function fetchGuildChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const cached = guild.channels?.cache?.get?.(channelId);
  if (cached) return cached;
  if (typeof guild.channels?.fetch === "function") {
    return guild.channels.fetch(channelId).catch(() => null);
  }
  return null;
}

async function sendConfiguredChannel(guild, channelId, payload) {
  const channel = await fetchGuildChannel(guild, channelId);
  if (!channel) return null;
  try {
    return await channel.send(payload);
  } catch (err) {
    recordRuntimeEvent("warn", "outage-channel-send", err?.message || err);
    return null;
  }
}

// Public flow -----------------------------------------------------------------

async function maybeHandleOutageDetection(message, {
  now = Date.now(),
  sendLog = sendLogPanel,
  lockChannels = applyAutomaticLockdown,
  unlockChannels = applyAutomaticUnlockdown
} = {}) {
  pruneExpiredReviews(now);

  const result = observeOutageMessage(message, { now });
  if (!result?.triggered) return false;

  setRuntimeStatus("UNAWARE");
  const lockResult = await lockChannels(message.guild, {
    actorId: "auto-detection",
    actor: "Auto Detection",
    reason: "multiple distinct Kicia not-working reports",
    sendLog
  }).catch((err) => ({
    ok: false,
    error: err?.message || String(err),
    result: { changed: [], skipped: [] }
  }));

  // Replace any prior pending review for this guild — the freshest signal wins.
  clearPendingReviewsForGuild(message.guildId || message.guild?.id);

  const reviewId = buildReviewId(message.guildId || message.guild?.id, now);
  const review = {
    reviewId,
    guildId: message.guildId || message.guild?.id || null,
    createdAt: now,
    expiresAt: now + OUTAGE_REVIEW_TTL_MS,
    distinctUsers: result.count,
    samples: result.events,
    status: "pending",
    lockResult,
    unlockChannels,
    sendLog,
    generalMessageRef: null,
    staffMessageRef: null,
    logMessageRef: null
  };
  pendingReviews.set(reviewId, review);

  const generalMessage = await sendConfiguredChannel(
    message.guild,
    getConfiguredChannelId("general"),
    buildOutageGeneralPayload()
  );
  review.generalMessageRef = generalMessage;

  const staffChannelId = getStaffChannelId();
  let staffMessage = null;
  if (staffChannelId) {
    staffMessage = await sendConfiguredChannel(
      message.guild,
      staffChannelId,
      buildOutageStaffPayload(result, { lockResult, reviewId })
    );
  }
  review.staffMessageRef = staffMessage;

  await sendLog(message.guild, buildOutageLogPanel(result, {
    generalSent: Boolean(generalMessage),
    staffSent: Boolean(staffMessage),
    lockResult,
    reviewId
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

// Resolution helpers (called from interaction handler) -----------------------

async function resolveOutageReview(reviewId, {
  resolution,
  actor,
  guild,
  unlockChannels,
  sendLog = sendLogPanel,
  now = Date.now()
} = {}) {
  const review = getReview(reviewId);
  if (!review) return { ok: false, reason: "review_not_found" };
  if (review.status !== "pending") return { ok: false, reason: "review_already_resolved", review };
  if (!guild) return { ok: false, reason: "missing_guild" };

  if (resolution === "confirmed") {
    setRuntimeStatus("DOWN");
    review.status = "confirmed";
    review.resolvedAt = now;
    review.resolvedBy = actor || null;

    const generalPayload = buildOutageResolvedGeneralPayload({ resolution: "confirmed", actor });
    const generalChannelId = getConfiguredChannelId("general");
    if (generalChannelId) {
      await sendConfiguredChannel(guild, generalChannelId, generalPayload);
    }
    await sendLog(guild, buildOutageResolvedLogPanel({
      resolution: "confirmed",
      review,
      actor
    })).catch(() => null);

    return { ok: true, review };
  }

  if (resolution === "false_alarm") {
    setRuntimeStatus("UP");
    const unlockResult = await (unlockChannels || review.unlockChannels || applyAutomaticUnlockdown)(guild, {
      actorId: actor?.id || "outage-review",
      actor: actor?.label || "Outage Review",
      reason: "outage auto-detection dismissed as false alarm",
      sendLog
    }).catch((err) => ({
      ok: false,
      error: err?.message || String(err),
      result: { changed: [], skipped: [] }
    }));
    review.status = "false_alarm";
    review.resolvedAt = now;
    review.resolvedBy = actor || null;
    review.unlockResult = unlockResult;

    const generalChannelId = getConfiguredChannelId("general");
    if (generalChannelId) {
      await sendConfiguredChannel(guild, generalChannelId, buildOutageResolvedGeneralPayload({
        resolution: "false_alarm",
        actor: actor?.label || actor,
        unlockResult
      }));
    }
    await sendLog(guild, buildOutageResolvedLogPanel({
      resolution: "false_alarm",
      review,
      actor: actor?.label || actor,
      unlockResult
    })).catch(() => null);

    return { ok: true, review, unlockResult };
  }

  return { ok: false, reason: "unknown_resolution" };
}

// Reset (used by tests) -------------------------------------------------------

function resetOutageDetectionState() {
  outageBuckets.clear();
  pendingReviews.clear();
}

module.exports = {
  OUTAGE_DETECTION_THRESHOLD,
  OUTAGE_DETECTION_WINDOW_MS,
  OUTAGE_REVIEW_TTL_MS,
  PRODUCT_CONTEXT_RE,
  OUTAGE_STATUS_RE,
  NEGATIVE_WORK_RE,
  buildOutageGeneralPayload,
  buildOutageLogPanel,
  buildOutageStaffPayload,
  buildOutageResolvedGeneralPayload,
  buildOutageResolvedLogPanel,
  detectOutageStatusComplaint,
  getPendingReviewForGuild,
  getReview,
  maybeHandleOutageDetection,
  observeOutageMessage,
  resetOutageDetectionState,
  resolveOutageReview
};
