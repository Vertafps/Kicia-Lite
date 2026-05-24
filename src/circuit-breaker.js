// per-service circuit breaker — closed/open/half-open

const registry = new Map();

function createBreaker({
  name,
  errorThreshold = 0.25,
  windowMs = 300_000,
  openMs = 60_000,
  halfOpenProbes = 1,
  onTransition,
} = {}) {
  if (!name) throw new TypeError("createBreaker: name is required");

  if (registry.has(name)) return registry.get(name);

  let window = [];
  let state = "closed";
  let openSince = null;
  let lastTransitionAt = null;
  let probesRemaining = 0;

  function pruneWindow() {
    const cutoff = Date.now() - windowMs;
    window = window.filter((e) => e.ts >= cutoff);
  }

  function recordCall(ok) {
    pruneWindow();
    window.push({ ts: Date.now(), ok });
  }

  function errorRate() {
    pruneWindow();
    if (window.length === 0) return 0;
    const errors = window.filter((e) => !e.ok).length;
    return errors / window.length;
  }

  function transition(to, reason) {
    const from = state;
    if (from === to) return;
    state = to;
    lastTransitionAt = Date.now();

    if (to === "open") {
      openSince = Date.now();
      probesRemaining = 0;
    } else if (to === "half-open") {
      probesRemaining = halfOpenProbes;
    } else if (to === "closed") {
      openSince = null;
      probesRemaining = 0;
    }

    if (typeof onTransition === "function") {
      try {
        onTransition({ from, to, reason });
      } catch (_) {
        // never let a callback bring down the breaker logic
      }
    }
  }

  function maybeAutoTransition() {
    if (state === "closed") {
      pruneWindow();
      const total = window.length;
      const rate = errorRate();
      // need at least 5 calls in window before we'll open
      if (total >= 5 && rate > errorThreshold) {
        transition("open", `error rate ${(rate * 100).toFixed(1)}% > threshold ${(errorThreshold * 100).toFixed(1)}%`);
      }
    } else if (state === "open") {
      if (openSince !== null && Date.now() - openSince >= openMs) {
        transition("half-open", "open timer expired, probing");
      }
    }
  }

  const instance = {
    async exec(fn) {
      maybeAutoTransition();

      if (state === "open") return null;

      if (state === "half-open") {
        if (probesRemaining <= 0) return null;
        probesRemaining--;
        try {
          const result = await fn();
          recordCall(true);
          transition("closed", "half-open probe succeeded");
          return result;
        } catch (err) {
          recordCall(false);
          transition("open", "half-open probe failed");
          return null;
        }
      }

      try {
        const result = await fn();
        recordCall(true);
        return result;
      } catch (err) {
        recordCall(false);
        maybeAutoTransition();
        throw err;
      }
    },

    state() {
      maybeAutoTransition();
      return state;
    },

    stats() {
      pruneWindow();
      const total = window.length;
      const errors = window.filter((e) => !e.ok).length;
      return {
        state,
        errorRate: total > 0 ? errors / total : 0,
        totalCalls: total,
        errorCount: errors,
        openSince,
        lastTransitionAt,
      };
    },

    forceOpen(reason = "manual") {
      transition("open", `forced open: ${reason}`);
    },

    forceClose(reason = "manual") {
      window = [];
      transition("closed", `forced close: ${reason}`);
    },

    reset() {
      window = [];
      transition("closed", "reset");
    },
  };

  registry.set(name, instance);
  return instance;
}

function listBreakers() {
  return Array.from(registry.entries()).map(([name, b]) => ({
    name,
    stats: b.stats(),
  }));
}

function __resetForTests() {
  registry.clear();
}

module.exports = { createBreaker, listBreakers, __resetForTests };
