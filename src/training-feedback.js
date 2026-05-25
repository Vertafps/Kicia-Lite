const crypto = require("crypto");

function getGetSetting() {
  try {
    return require("./settings").getSetting;
  } catch (_) {
    return () => undefined;
  }
}

function getNormalizeText() {
  try {
    return require("./text").normalizeText;
  } catch (_) {
    return (s) => String(s || "");
  }
}

function getEmbedText() {
  try {
    return require("./embeddings").embedText;
  } catch (_) {
    return null;
  }
}

function getTrainingDb() {
  return require("./training-db");
}

function getChannelConfig() {
  return require("./channel-config");
}

function getRecordRuntimeEvent() {
  try {
    return require("./runtime-health").recordRuntimeEvent;
  } catch (_) {
    return () => {};
  }
}

function getEmbedMod() {
  return require("./embed");
}

function getConfig() {
  try {
    return require("./config");
  } catch (_) {
    return {};
  }
}

function getComponentsBuilder() {
  try {
    const mod = require("./components");
    return typeof mod.buildTrainingFeedbackButtonRows === "function"
      ? mod.buildTrainingFeedbackButtonRows
      : null;
  } catch (_) {
    return null;
  }
}

function sha1Hash(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

function parseJsonSafe(json) {
  try {
    return JSON.parse(json || "{}");
  } catch (_) {
    return {};
  }
}

function trimExcerpt(text, max = 240) {
  const s = String(text || "");
  if (!s) return "—";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function authorLabelFor(user) {
  if (!user) return "user";
  const username = String(user.username || "user");
  const discrim = user.discriminator;
  return discrim && discrim !== "0" ? `${username}#${discrim}` : username;
}

// QUEUE: guildId -> { entries, timer, stats, guildRef, lastWarnAt }
const QUEUE = new Map();

function getMaxQueueDepth() {
  const v = getGetSetting()("training.post.max_queue");
  const n = v == null ? 100 : parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function getDrainIntervalMs() {
  const rate = getGetSetting()("training.post.rate_per_sec");
  const r = rate == null ? 1 : Number(rate);
  if (!Number.isFinite(r) || r <= 0) return 1000;
  return Math.max(250, Math.round(1000 / r));
}

function initState(guildRef) {
  return {
    entries: [],
    timer: null,
    stats: { pending: 0, dropped: 0, sent: 0 },
    guildRef,
    lastWarnAt: null
  };
}

function enforceMaxDepth(state, maxDepth) {
  if (state.entries.length < maxDepth) return;
  let droppedNow = 0;
  while (state.entries.length >= maxDepth) {
    state.entries.shift();
    state.stats.dropped++;
    state.stats.pending = Math.max(0, state.stats.pending - 1);
    droppedNow++;
  }
  const now = Date.now();
  if (state.lastWarnAt == null || now - state.lastWarnAt > 5 * 60_000) {
    state.lastWarnAt = now;
    getRecordRuntimeEvent()(
      "warn",
      "training-post-overflow",
      `dropped ${droppedNow} sample(s) for guild ${state.guildRef?.id ?? "unknown"} (depth cap ${maxDepth})`
    );
  }
}

function startDrainIfIdle(state) {
  if (state.timer) return;
  const intervalMs = getDrainIntervalMs();
  state.timer = setInterval(async () => {
    const entry = state.entries.shift();
    if (!entry) {
      stopDrainTimer(state);
      return;
    }
    state.stats.pending = Math.max(0, state.stats.pending - 1);
    try {
      const ok = await postSampleToTrainingChannel(
        state.guildRef,
        entry.sampleId,
        entry.classifier
      );
      if (ok) state.stats.sent++;
    } catch (err) {
      getRecordRuntimeEvent()("warn", "training-post", err?.message || String(err));
    }
  }, intervalMs);
  if (typeof state.timer.unref === "function") state.timer.unref();
}

function stopDrainTimer(state) {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

function enqueueForPost({ guildId, sampleId, guildRef, classifier, severity }) {
  if (!guildId || sampleId == null) return;
  let state = QUEUE.get(guildId);
  if (!state) {
    state = initState(guildRef);
    QUEUE.set(guildId, state);
  } else if (guildRef) {
    state.guildRef = guildRef;
  }
  enforceMaxDepth(state, getMaxQueueDepth());
  state.entries.push({ sampleId, classifier, severity });
  state.stats.pending++;
  startDrainIfIdle(state);
}

async function enqueueTrainingSample(message, classification) {
  try {
    const getSetting = getGetSetting();
    if (!getSetting("training.enabled")) {
      return { sampleId: null, queued: false, deduped: false, reason: "disabled" };
    }
    if (!message?.guild?.id) {
      return { sampleId: null, queued: false, deduped: false, reason: "no-guild" };
    }
    if (!message.author?.id) {
      return { sampleId: null, queued: false, deduped: false, reason: "no-author" };
    }
    if (!classification || !classification.classifier) {
      return { sampleId: null, queued: false, deduped: false, reason: "no-classification" };
    }

    const verdict = classification.verdict;
    // Confidence is exposed at signals.confidence by some classifiers, top-level by others.
    const rawConfidence = classification.confidence ?? classification.signals?.confidence;
    const confidence = Number(rawConfidence);
    const safeConfidence = Number.isFinite(confidence) ? confidence : 0;

    // Timeouts always pass through to SQLite so the corpus stays complete.
    if (verdict !== "timeout") {
      const thresholdRaw = getSetting(`training.classifier.${classification.classifier}.threshold`);
      const threshold = Number.isFinite(Number(thresholdRaw)) ? Number(thresholdRaw) : 0.55;
      const marginRaw = getSetting("training.borderline.margin");
      const margin = Number.isFinite(Number(marginRaw)) ? Number(marginRaw) : 0.10;

      if (safeConfidence < threshold - margin) {
        return { sampleId: null, queued: false, deduped: false, reason: "below-borderline" };
      }
      if (safeConfidence > 1 - margin) {
        return { sampleId: null, queued: false, deduped: false, reason: "above-borderline" };
      }
    }

    const text = String(message.content || "");
    const normalizeText = getNormalizeText();
    const normalized = normalizeText(text).slice(0, 4000);

    const dedupKey =
      sha1Hash(normalized).slice(0, 24) +
      "|" +
      message.author.id +
      "|" +
      classification.classifier;

    // Link classifier uses URL features, not text embeddings.
    let embedding = classification.embedding instanceof Float32Array ? classification.embedding : null;
    if (!embedding && classification.classifier !== "link") {
      const embedText = getEmbedText();
      if (embedText) {
        try {
          const vec = await embedText(normalized.slice(0, 512));
          if (vec instanceof Float32Array && vec.length > 0) embedding = vec;
        } catch (err) {
          getRecordRuntimeEvent()("warn", "training-embed", err?.message || String(err));
        }
      }
    }

    const { createTrainingSample } = getTrainingDb();
    const config = getConfig();
    const signalsJson = JSON.stringify({
      ...(classification.signals || {}),
      confidence: safeConfidence
    });

    const decision = verdict === "timeout" ? "action" : "review";

    const postActions = getSetting("training.post.action.enabled");
    const shouldPost = verdict !== "timeout" || postActions === true;

    const { sampleId, deduped } = await createTrainingSample({
      classifier: classification.classifier,
      guildId: message.guild.id,
      channelId: message.channelId,
      messageId: message.id,
      messageUrl: `https://discord.com/channels/${message.guild.id}/${message.channelId}/${message.id}`,
      authorId: message.author.id,
      authorLabel: authorLabelFor(message.author),
      rawText: text.slice(0, 4000),
      normalizedText: normalized,
      signalsJson,
      decision,
      actionActionId: classification.actionActionId || null,
      dedupKey,
      vector: embedding,
      modelId: embedding ? config.KB_EMBED_MODEL_ID || "Xenova/all-MiniLM-L6-v2" : null,
      posted: shouldPost ? 0 : 1
    });

    if (deduped) {
      return { sampleId, queued: false, deduped: true };
    }

    if (!shouldPost) {
      return { sampleId, queued: false, deduped: false, reason: "action-no-post" };
    }

    enqueueForPost({
      guildId: message.guild.id,
      sampleId,
      guildRef: message.guild,
      classifier: classification.classifier,
      severity: classification.severity || null
    });

    return { sampleId, queued: true, deduped: false };
  } catch (err) {
    getRecordRuntimeEvent()("error", "training-enqueue", err?.message || String(err));
    return { sampleId: null, queued: false, deduped: false, reason: "error" };
  }
}

async function postSampleToTrainingChannel(guild, sampleId, classifier) {
  if (!guild || sampleId == null) return false;

  const { getTrainingSampleById, setTrainingSamplePosted } = getTrainingDb();
  let sample = null;
  try {
    sample = await getTrainingSampleById(sampleId);
  } catch (err) {
    getRecordRuntimeEvent()("warn", "training-db-read", err?.message || String(err));
    return false;
  }
  if (!sample) return false;
  if (sample.posted) return false;

  const channelId = getChannelConfig().getConfiguredChannelId("training");
  if (!channelId) {
    // No channel configured: leave posted=0 so drain revisits when slot is set.
    return false;
  }

  let channel = null;
  try {
    channel = await guild.channels.fetch(channelId).catch(() => null);
  } catch (_) {
    channel = null;
  }
  if (!channel) {
    getRecordRuntimeEvent()(
      "warn",
      "training-channel-missing",
      `channel ${channelId} unreachable for guild ${guild.id}`
    );
    return false;
  }

  const staffRoleId = resolveStaffPingRole(classifier);
  const embed = buildTrainingPanel(sample, classifier);
  const components = buildButtonRows(sampleId, classifier, sample);

  const payload = {
    embeds: [embed],
    components,
    allowedMentions: { roles: staffRoleId ? [staffRoleId] : [] }
  };
  if (staffRoleId) payload.content = `<@&${staffRoleId}>`;

  let sent = null;
  try {
    sent = await channel.send(payload);
  } catch (err) {
    getRecordRuntimeEvent()("warn", "training-channel-send", err?.message || String(err));
    return false;
  }
  if (!sent) return false;

  try {
    await setTrainingSamplePosted(sampleId, {
      feedbackMessageId: sent.id,
      feedbackChannelId: channelId,
      posted: 1
    });
  } catch (err) {
    getRecordRuntimeEvent()("warn", "training-db-mark-posted", err?.message || String(err));
  }
  return true;
}

function resolveStaffPingRole(classifier) {
  const getSetting = getGetSetting();
  const fromSetting = getSetting(`${classifier}.staff.ping.role`);
  if (fromSetting) {
    const str = String(fromSetting).trim();
    if (str) return str;
  }
  const cfg = getConfig();
  const ids = Array.isArray(cfg.STAFF_ROLE_IDS) ? cfg.STAFF_ROLE_IDS : [];
  return ids[0] || null;
}

function buildTrainingPanel(sample, classifier) {
  const embedMod = getEmbedMod();
  const buildRichPanel = embedMod.buildRichPanel;
  const DANGER = embedMod.DANGER;
  const WARN = embedMod.WARN;

  const signals = parseJsonSafe(sample.signalsJson || sample.signals_json);
  const isAction = sample.decision === "action";
  const confidenceRaw = Number(signals.confidence ?? 0);
  const confidencePct = Math.round(Math.max(0, Math.min(1, confidenceRaw)) * 100);

  const fields = [];

  if (sample.authorId || sample.author_id) {
    fields.push({
      name: "User",
      value: `<@${sample.authorId || sample.author_id}>`,
      inline: true
    });
  }
  if (sample.channelId || sample.channel_id) {
    fields.push({
      name: "Channel",
      value: `<#${sample.channelId || sample.channel_id}>`,
      inline: true
    });
  }
  fields.push({ name: "Confidence", value: `${confidencePct}%`, inline: true });

  if (sample.severity) {
    fields.push({ name: "Suggested", value: String(sample.severity), inline: true });
  }
  if (sample.actionActionId || sample.action_action_id) {
    fields.push({ name: "Action", value: "auto-timeout applied", inline: true });
  }
  if (sample.messageUrl || sample.message_url) {
    fields.push({
      name: "Jump",
      value: `[→ Open](${sample.messageUrl || sample.message_url})`,
      inline: true
    });
  }

  const signalLines = buildSignalLines(classifier, signals);
  if (signalLines.length) {
    fields.push({
      name: "Signals",
      value: "```" + signalLines.join("\n") + "```"
    });
  }

  fields.push({
    name: "Message",
    value: trimExcerpt(sample.rawText || sample.raw_text, 240)
  });

  return buildRichPanel({
    title: `Training · ${classifier} · ${isAction ? "auto-action" : "review"}`,
    author: { name: sample.authorLabel || sample.author_label || "user" },
    fields,
    color: isAction ? DANGER : WARN,
    footer: { text: `sample #${sample.id}` }
  });
}

function buildSignalLines(classifier, signals) {
  const s = signals || {};
  if (classifier === "scam") {
    const head = s.headScore != null && Number.isFinite(Number(s.headScore))
      ? Number(s.headScore).toFixed(2)
      : "—";
    const sem = Number.isFinite(Number(s.semDelta)) ? Number(s.semDelta).toFixed(2) : "0.00";
    return [
      `direction: ${s.directionScore ?? 0}`,
      `price: ${s.priceHit ? "yes" : "no"}`,
      `dm: ${s.dmHit ? "yes" : "no"}`,
      `sem: ${sem}`,
      `head: ${head}`
    ];
  }
  if (classifier === "respect") {
    const ratio = Number.isFinite(Number(s.kiciaNegRatio))
      ? Number(s.kiciaNegRatio).toFixed(2)
      : "0.00";
    const sem = Number.isFinite(Number(s.semDisrespect))
      ? Number(s.semDisrespect).toFixed(2)
      : "0.00";
    return [
      `kiciaNeg: ${s.kiciaNegMag ?? 0}`,
      `ratio: ${ratio}`,
      `sem: ${sem}`,
      `sarcasm: ${s.sarcasm ? "yes" : "no"}`,
      `q: ${s.question ? "yes" : "no"}`
    ];
  }
  const lines = [];
  if (s.confidence != null) lines.push(`confidence: ${Number(s.confidence).toFixed(2)}`);
  for (const key of Object.keys(s).slice(0, 6)) {
    if (key === "confidence") continue;
    const val = s[key];
    if (val == null) continue;
    if (typeof val === "object") continue;
    lines.push(`${key}: ${val}`);
  }
  return lines;
}

function buildButtonRows(sampleId, classifier, sample) {
  const builder = getComponentsBuilder();
  if (builder) {
    try {
      const rows = builder(sampleId, classifier, sample);
      if (Array.isArray(rows)) return rows;
    } catch (err) {
      getRecordRuntimeEvent()(
        "warn",
        "training-buttons",
        err?.message || String(err)
      );
    }
  }
  return buildButtonRowsInline(sampleId, classifier);
}

function buildButtonRowsInline(sampleId, classifier) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
  const isScam = classifier === "scam";

  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`train:neg:${sampleId}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel(isScam ? "Not Scam" : "Not Disrespect"),
    new ButtonBuilder()
      .setCustomId(`train:${classifier}:light:${sampleId}`)
      .setStyle(ButtonStyle.Success)
      .setLabel(isScam ? "Light (1h)" : "Light (15m)"),
    new ButtonBuilder()
      .setCustomId(`train:${classifier}:medium:${sampleId}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel(isScam ? "Medium (12h)" : "Medium (1h)"),
    new ButtonBuilder()
      .setCustomId(`train:${classifier}:severe:${sampleId}`)
      .setStyle(ButtonStyle.Danger)
      .setLabel(isScam ? "Severe (24h)" : "Severe (24h)")
  );
  return [row];
}

async function drainTrainingChannelQueue() {
  let samples = [];
  try {
    const { listUnpostedTrainingSamples } = getTrainingDb();
    samples = await listUnpostedTrainingSamples({ limit: 100 });
  } catch (err) {
    getRecordRuntimeEvent()("warn", "training-drain-list", err?.message || String(err));
    return;
  }
  if (!Array.isArray(samples) || !samples.length) return;

  const client = getClientRef();

  for (const sample of samples) {
    if (!sample || !sample.guildId) continue;

    let guildRef = QUEUE.get(sample.guildId)?.guildRef || null;
    if (!guildRef && client?.guilds?.cache?.get) {
      guildRef = client.guilds.cache.get(sample.guildId) || null;
    }
    if (!guildRef && client?.guilds?.fetch) {
      try {
        guildRef = await client.guilds.fetch(sample.guildId);
      } catch (_) {
        guildRef = null;
      }
    }
    if (!guildRef) continue;

    enqueueForPost({
      guildId: sample.guildId,
      sampleId: sample.id,
      guildRef,
      classifier: sample.classifier,
      severity: sample.severity || null
    });
  }
}

function getClientRef() {
  try {
    const idx = require("./index");
    return idx?.client || null;
  } catch (_) {
    return null;
  }
}

let schedulerTimer = null;
const SCHEDULER_INTERVAL_MS = 30_000;

function startTrainingChannelScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    drainTrainingChannelQueue().catch((err) => {
      getRecordRuntimeEvent()(
        "warn",
        "training-scheduler",
        err?.message || String(err)
      );
    });
  }, SCHEDULER_INTERVAL_MS);
  if (typeof schedulerTimer.unref === "function") schedulerTimer.unref();
}

function stopTrainingChannelScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

// Graceful shutdown: 2s total budget, up to 10 sends per guild.
async function flushAllTrainingQueues() {
  const BUDGET_PER_GUILD = 10;
  const flushPromises = [];

  stopTrainingChannelScheduler();

  for (const [, state] of QUEUE) {
    stopDrainTimer(state);
    const toFlush = state.entries.splice(0, BUDGET_PER_GUILD);
    state.stats.pending = Math.max(0, state.stats.pending - toFlush.length);
    state.entries.length = 0;

    const batch = Promise.allSettled(
      toFlush.map((entry) =>
        postSampleToTrainingChannel(state.guildRef, entry.sampleId, entry.classifier)
          .then((ok) => {
            if (ok) state.stats.sent++;
          })
          .catch((err) => {
            getRecordRuntimeEvent()(
              "warn",
              "training-flush",
              err?.message || String(err)
            );
          })
      )
    );
    flushPromises.push(batch);
  }

  await Promise.race([
    Promise.allSettled(flushPromises),
    new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      if (typeof t.unref === "function") t.unref();
    })
  ]);
}

function getTrainingQueueStats() {
  const out = {};
  for (const [guildId, state] of QUEUE) {
    out[guildId] = { ...state.stats };
  }
  return out;
}

function __resetForTests() {
  for (const [, state] of QUEUE) {
    stopDrainTimer(state);
  }
  QUEUE.clear();
  stopTrainingChannelScheduler();
}

module.exports = {
  enqueueTrainingSample,
  drainTrainingChannelQueue,
  startTrainingChannelScheduler,
  flushAllTrainingQueues,
  getTrainingQueueStats,
  __resetForTests,
  __internals: {
    sha1Hash,
    parseJsonSafe,
    trimExcerpt,
    authorLabelFor,
    buildTrainingPanel,
    buildSignalLines,
    buildButtonRows,
    buildButtonRowsInline,
    resolveStaffPingRole,
    postSampleToTrainingChannel,
    enqueueForPost,
    QUEUE,
    stopTrainingChannelScheduler
  }
};
