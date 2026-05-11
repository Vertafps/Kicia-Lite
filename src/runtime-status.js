const { DEFAULT_STATUS } = require("./config");

const KNOWN_STATUSES = new Set(["UP", "DOWN", "UNAWARE"]);
const FALLBACK_STATUS = "UP";

function normalizeStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  return KNOWN_STATUSES.has(value) ? value : FALLBACK_STATUS;
}

let currentStatus = normalizeStatus(DEFAULT_STATUS);
let currentStatusSinceAt = Date.now();
// Persistence is wired lazily so test isolation is preserved and runtime-status
// remains synchronous. Use enablePersistence() to wire it up at startup.
let persistenceImpl = null;

function getRuntimeStatus() {
  return currentStatus;
}

function getRuntimeStatusSinceAt() {
  return currentStatusSinceAt;
}

function setRuntimeStatus(status, options = {}) {
  const next = normalizeStatus(status);
  const previous = currentStatus;
  const now = Math.max(1, Math.round(Number(options.now) || Date.now()));

  if (next === previous && options.force !== true) {
    return currentStatus;
  }

  currentStatus = next;
  currentStatusSinceAt = now;

  if (persistenceImpl?.recordStatusTransition) {
    Promise.resolve()
      .then(() =>
        persistenceImpl.recordStatusTransition({
          occurredAt: now,
          fromStatus: previous,
          toStatus: next,
          actor: options.actor || null,
          reason: options.reason || null
        })
      )
      .catch((err) => {
        if (persistenceImpl?.onPersistError) {
          try {
            persistenceImpl.onPersistError(err);
          } catch {}
        }
      });
  }

  return currentStatus;
}

function isRuntimeDown() {
  return currentStatus === "DOWN";
}

function isRuntimeUp() {
  return currentStatus === "UP";
}

function isRuntimeUnaware() {
  return currentStatus === "UNAWARE";
}

function resetRuntimeStatus() {
  currentStatus = normalizeStatus(DEFAULT_STATUS);
  currentStatusSinceAt = Date.now();
  return currentStatus;
}

function enableStatusPersistence(impl) {
  persistenceImpl = impl || null;
}

async function hydrateRuntimeStatus({ now = Date.now() } = {}) {
  if (!persistenceImpl?.getPersistedRuntimeStatus) return null;
  try {
    const snapshot = await persistenceImpl.getPersistedRuntimeStatus();
    if (!snapshot?.status) return null;
    currentStatus = normalizeStatus(snapshot.status);
    currentStatusSinceAt = snapshot.sinceAt && snapshot.sinceAt > 0
      ? snapshot.sinceAt
      : now;
    return { status: currentStatus, sinceAt: currentStatusSinceAt };
  } catch {
    return null;
  }
}

module.exports = {
  getRuntimeStatus,
  getRuntimeStatusSinceAt,
  setRuntimeStatus,
  isRuntimeDown,
  isRuntimeUnaware,
  isRuntimeUp,
  resetRuntimeStatus,
  enableStatusPersistence,
  hydrateRuntimeStatus
};
