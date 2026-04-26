const MAX_EVENTS = 10;

const state = {
  warnings: [],
  errors: []
};

function recordRuntimeEvent(level, scope, detail) {
  const bucket = level === "warn" ? state.warnings : state.errors;
  bucket.unshift({
    at: Date.now(),
    scope: scope || "runtime",
    detail: String(detail || "unknown")
  });
  if (bucket.length > MAX_EVENTS) {
    bucket.length = MAX_EVENTS;
  }
}

function getRuntimeHealthSnapshot() {
  return {
    warnings: [...state.warnings],
    errors: [...state.errors]
  };
}

function resetRuntimeHealth() {
  state.warnings.length = 0;
  state.errors.length = 0;
}

module.exports = {
  recordRuntimeEvent,
  getRuntimeHealthSnapshot,
  resetRuntimeHealth
};
