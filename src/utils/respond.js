const { isNoResponseChannel } = require("../channel-policy");

async function safeReact(message, emoji) {
  try {
    await message.react?.(emoji);
    return true;
  } catch {
    return false;
  }
}

async function safeReply(message, payload, { fallbackToChannel = true } = {}) {
  try {
    return await message.reply(payload) || true;
  } catch (replyErr) {
    const channelId = message?.channelId || message?.channel?.id;
    if (!fallbackToChannel || !message?.channel?.send || isNoResponseChannel(channelId)) {
      throw replyErr;
    }
  }

  return await message.channel.send(payload) || true;
}

async function safeSend(target, payload) {
  try {
    const result = await target?.send?.(payload);
    // `target?.send?.(...)` returns undefined when target is null or has no
    // .send method — that's a no-op, not a successful send. Only count it
    // as sent when send() actually resolved with a Message-like value.
    return result != null;
  } catch (err) {
    try {
      const { recordRuntimeEvent } = require("../runtime-health");
      const code = err?.code || err?.rawError?.code;
      const httpStatus = err?.status || err?.httpStatus;
      const name = err?.name || "Error";
      const msg = err?.message || String(err);
      recordRuntimeEvent(
        "warn",
        "safe-send",
        `${name}${code ? ` (${code})` : ""}${httpStatus ? ` HTTP ${httpStatus}` : ""}: ${msg}`
      );
    } catch {}
    return false;
  }
}

async function safeEdit(message, payload) {
  if (typeof message?.edit !== "function") return false;
  try {
    return await message.edit(payload) || true;
  } catch {
    return false;
  }
}

// ─── DM circuit breaker ──────────────────────────────────────────────────
// Discord's anti-spam system flags bots that get a high rate of DM
// rejections (typically from users with "Allow direct messages from
// server members" disabled). Once flagged, the bot's DM endpoint gets
// rate-limited or hard-blocked for hours-to-days. Every additional DM
// attempt during that window deepens the penalty.
//
// We detect the flag from Discord's error message and immediately open
// the circuit — all subsequent trySendDM calls short-circuit to a
// "DM cooldown" failure for the configured window, giving Discord's
// detector time to cool off. Auto-recovers without operator action.
//
// State is in-memory only — survives nodemon restarts via the app_config
// persist below, hydrated lazily on first call.

const DEFAULT_COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 4 hours
const ANTI_SPAM_PATTERNS = [
  /anti-spam/i,
  /abusive behavior/i,
  /flagged.*spam/i,
  /flagged by.*automated/i
];

let _circuit = { openUntil: 0, reason: null, hydrated: false };

async function hydrateCircuit() {
  if (_circuit.hydrated) return;
  _circuit.hydrated = true;
  try {
    const { getDatabase } = require("../restricted-emoji-db");
    const db = await getDatabase();
    if (!db) return;
    const stmt = db.prepare("SELECT key, value FROM app_config WHERE key IN ('dm.circuit.openUntil','dm.circuit.reason')");
    try {
      while (stmt.step()) {
        const row = stmt.get();
        if (row[0] === "dm.circuit.openUntil") {
          const n = Number(row[1]);
          if (Number.isFinite(n) && n > Date.now()) _circuit.openUntil = n;
        } else if (row[0] === "dm.circuit.reason") {
          _circuit.reason = String(row[1] || "") || null;
        }
      }
    } finally {
      stmt.free();
    }
  } catch {
    // best-effort; if hydrate fails the circuit just starts closed
  }
}

async function persistCircuit() {
  try {
    const { getDatabase, setAppConfigValue } = require("../restricted-emoji-db");
    const db = await getDatabase();
    if (!db) return;
    await setAppConfigValue(db, "dm.circuit.openUntil", String(_circuit.openUntil), { immediate: true });
    await setAppConfigValue(db, "dm.circuit.reason", _circuit.reason || "", { immediate: true });
  } catch {}
}

function getCooldownMs() {
  try {
    const { getSetting } = require("../settings");
    const hours = Number(getSetting("dm.circuit.cooldownHours"));
    if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000;
  } catch {}
  return DEFAULT_COOLDOWN_MS;
}

function isCircuitOpen() {
  return Date.now() < _circuit.openUntil;
}

function tripCircuit(reason) {
  const cooldown = getCooldownMs();
  _circuit.openUntil = Date.now() + cooldown;
  _circuit.reason = reason || "anti-spam flagged";
  try {
    const { recordRuntimeEvent } = require("../runtime-health");
    const hrs = (cooldown / 3600000).toFixed(1);
    recordRuntimeEvent("warn", "dm-circuit-open", `${_circuit.reason} · cooldown ${hrs}h`);
  } catch {}
  // best-effort persistence so nodemon restarts don't reopen the floodgates
  persistCircuit();
}

function isAntiSpamError(err) {
  const msg = String(err?.message || err?.rawError?.message || "");
  return ANTI_SPAM_PATTERNS.some((re) => re.test(msg));
}

// Owner-facing helpers (used by $config / status panels)
function getDmCircuitState() {
  return {
    open: isCircuitOpen(),
    openUntil: _circuit.openUntil,
    reason: _circuit.reason,
    remainingMs: Math.max(0, _circuit.openUntil - Date.now())
  };
}

function clearDmCircuit() {
  _circuit.openUntil = 0;
  _circuit.reason = null;
  persistCircuit();
}

// Verbose variant of safeSend for user-DM paths where the caller wants to
// know WHY a DM failed (so the moderation log can show "user has DMs
// disabled" instead of just "✗"). Returns {sent, code, reason} — sent is
// the boolean equivalent to safeSend's return.
async function trySendDM(user, payload) {
  await hydrateCircuit();
  if (isCircuitOpen()) {
    const remainMin = Math.ceil((_circuit.openUntil - Date.now()) / 60000);
    return {
      sent: false,
      code: "circuit-open",
      reason: `DM cooldown (${_circuit.reason || "anti-spam"}, ~${remainMin}m left)`
    };
  }
  try {
    const result = await user?.send?.(payload);
    if (result != null) return { sent: true, code: null, reason: null };
    return { sent: false, code: null, reason: "no send target" };
  } catch (err) {
    const code = err?.code || err?.rawError?.code || null;
    // Map common Discord DM rejection codes to short human reasons.
    let reason;
    switch (code) {
      case 50007: reason = "user DMs disabled"; break;
      case 40003: reason = "rate limited"; break;
      case 50001: reason = "missing access"; break;
      case 50013: reason = "missing permissions"; break;
      default: reason = err?.message?.slice(0, 80) || "send failed";
    }
    // Detect Discord's anti-spam flag and open the circuit immediately so
    // we stop digging the hole deeper.
    if (isAntiSpamError(err)) {
      tripCircuit("anti-spam flagged by Discord");
      reason = "anti-spam flagged (DM cooldown engaged)";
    }
    try {
      const { recordRuntimeEvent } = require("../runtime-health");
      recordRuntimeEvent("warn", "dm-send", `code=${code || "none"} · ${reason}`);
    } catch {}
    return { sent: false, code, reason };
  }
}

module.exports = {
  safeReact,
  safeReply,
  safeSend,
  safeEdit,
  trySendDM,
  getDmCircuitState,
  clearDmCircuit
};
