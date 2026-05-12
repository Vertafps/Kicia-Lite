"use strict";

/**
 * Status pinned widget.
 *
 * Behaviour:
 *  - Reads the configured `statuswidget` channel via channel-config.
 *  - Every STATUS_WIDGET_REFRESH_MS, redraws the widget message.
 *  - On status transitions, callers invoke refreshStatusWidget() to redraw
 *    immediately.
 *  - First run in a channel: finds an existing bot-authored pinned widget
 *    message; if none, sends + pins a new one.
 *  - All work is best-effort; widget failures never bubble up.
 *
 * The widget is the bot's response to a config-set, so it lives in the
 * widget channel (not the log channel). The widget content is public-safe
 * (status state, latency, uptime — nothing staff-only).
 */

const { STATUS_WIDGET_REFRESH_MS } = require("../config");
const { getStatusWidgetChannelId } = require("../channel-config");
const { getRuntimeStatus } = require("../runtime-status");
const { buildStatusMetrics } = require("../status-metrics");
const { recordRuntimeEvent } = require("../runtime-health");
const ui = require("../ui");

const REFRESH_MS = Math.max(15_000, Number(STATUS_WIDGET_REFRESH_MS) || 60_000);
const WIDGET_MARKER = "kicia-status-widget";

// channelId -> messageId mapping; rebuilt per process from pin search.
const widgetMessages = new Map();
let refreshTimer = null;
let activeClient = null;
let inflight = null;

function buildSyntheticRibbon(status) {
  if (status === "UP") return Array.from({ length: 96 }, () => "up");
  if (status === "UNAWARE") return Array.from({ length: 96 }, (_, i) => (i >= 88 ? "unaware" : "up"));
  return Array.from({ length: 96 }, (_, i) => (i >= 90 ? "down" : i >= 86 ? "unaware" : "up"));
}

async function buildWidgetPayload(status, latencyMs) {
  let metrics = null;
  try {
    metrics = await buildStatusMetrics({ currentStatus: status });
  } catch (err) {
    recordRuntimeEvent("warn", "status-widget-metrics", err?.message || err);
  }

  const ribbon = metrics?.ribbon?.length === 96 ? metrics.ribbon : buildSyntheticRibbon(status);
  const uptime = metrics ? Number(metrics.uptimePct.toFixed(2))
    : status === "UP" ? 100 : status === "UNAWARE" ? 99.50 : 98.20;
  const incidents = metrics?.incidents ?? (status === "UP" ? 0 : 1);
  const lastDown = metrics?.lastDownLabel || (status === "UP" ? "—" : "earlier today");

  const result = ui.buildStatusEmbed({
    status,
    uptime,
    latencyMs: Math.max(0, Number.isFinite(latencyMs) ? Math.round(latencyMs) : 0),
    ribbon,
    lastDown,
    incidents7d: String(incidents)
  });

  return {
    embeds: result.embeds,
    files: result.files,
    components: result.components || [],
    allowedMentions: { parse: [] },
    content: `​​${WIDGET_MARKER}​`
  };
}

function isOurWidgetMessage(message, clientUserId) {
  if (!message) return false;
  if (message.author?.id && clientUserId && message.author.id !== clientUserId) return false;
  if (typeof message.content === "string" && message.content.includes(WIDGET_MARKER)) return true;
  return false;
}

async function findExistingWidgetMessage(channel, clientUserId) {
  try {
    const pins = await channel.messages.fetchPinned();
    if (!pins) return null;
    for (const message of pins.values()) {
      if (isOurWidgetMessage(message, clientUserId)) return message;
    }
  } catch {}

  try {
    const recent = await channel.messages.fetch({ limit: 25 });
    if (!recent) return null;
    for (const message of recent.values()) {
      if (isOurWidgetMessage(message, clientUserId)) return message;
    }
  } catch {}

  return null;
}

async function resolveWidgetChannel(client) {
  const channelId = getStatusWidgetChannelId();
  if (!channelId) return null;
  const guilds = [...(client?.guilds?.cache?.values?.() || [])];
  for (const guild of guilds) {
    const cached = guild.channels?.cache?.get?.(channelId);
    if (cached?.send && cached?.isTextBased?.()) return cached;
    const fetched = await guild.channels?.fetch?.(channelId).catch(() => null);
    if (fetched?.send && fetched?.isTextBased?.()) return fetched;
  }
  return null;
}

async function refreshStatusWidget(client = activeClient) {
  if (!client) return false;
  if (inflight) return inflight;

  inflight = (async () => {
    const channel = await resolveWidgetChannel(client);
    if (!channel) return false;

    const status = getRuntimeStatus();
    const latency = client.ws?.ping;
    const payload = await buildWidgetPayload(status, latency);

    let widgetMessage = null;
    const cachedId = widgetMessages.get(channel.id);
    if (cachedId) {
      widgetMessage = await channel.messages.fetch(cachedId).catch(() => null);
    }
    if (!widgetMessage) {
      widgetMessage = await findExistingWidgetMessage(channel, client.user?.id);
      if (widgetMessage) widgetMessages.set(channel.id, widgetMessage.id);
    }

    if (widgetMessage) {
      try {
        await widgetMessage.edit(payload);
        if (!widgetMessage.pinned) {
          await widgetMessage.pin().catch(() => null);
        }
        return true;
      } catch (err) {
        recordRuntimeEvent("warn", "status-widget-edit", err?.message || err);
        widgetMessages.delete(channel.id);
      }
    }

    try {
      const sent = await channel.send(payload);
      widgetMessages.set(channel.id, sent.id);
      await sent.pin().catch(() => null);
      return true;
    } catch (err) {
      recordRuntimeEvent("warn", "status-widget-send", err?.message || err);
      return false;
    }
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

function startStatusWidgetScheduler(client) {
  activeClient = client;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshStatusWidget(client).catch(() => null);
  }, REFRESH_MS);
  refreshTimer.unref?.();
  return refreshTimer;
}

function stopStatusWidgetScheduler() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function __resetForTests() {
  widgetMessages.clear();
  inflight = null;
  stopStatusWidgetScheduler();
  activeClient = null;
}

module.exports = {
  refreshStatusWidget,
  startStatusWidgetScheduler,
  stopStatusWidgetScheduler,
  __resetForTests
};
