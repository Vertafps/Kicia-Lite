"use strict";

// per-service circuit breaker — closed/open/half-open
// used by link-policy.js to gate fishfish, safebrowsing, webrisk, etc.

// internal registry: name → BreakerInstance
const registry = new Map();

/**
 * @param {object} opts
 * @param {string}   opts.name              - unique breaker name (also registry key)
 * @param {number}  [opts.errorThreshold=0.25] - error rate above which we open
 * @param {number}  [opts.windowMs=300_000]    - rolling window length (5 min)
 * @param {number}  [opts.openMs=60_000]       - how long to stay open before half-open
 * @param {number}  [opts.halfOpenProbes=1]    - how many probes to allow in half-open
 * @param {Function}[opts.onTransition]        - ({from,to,reason}) callback
 */
function createBreaker({
  name,
  errorThreshold = 0.25,
  windowMs = 300_000,
  openMs = 60_000,
  halfOpenProbes = 1,
  onTransition,
} = {}) {
  if (!name) throw new TypeError("createBreaker: name is required");

  // reuse existing instance if one already exists under this name (idempotent)
  if (registry.has(name)) return registry.get(name);

  // rolling window: array of {ts: number, ok: boolean}
  let window = [];
  let state = "closed"; // "closed" | "open" | "half-open"
  let openSince = null;
  let lastTransitionAt = null;
  let probesRemaining = 0; // only relevant in half-open

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
    // half-open → closed/open handled inside exec()
  }

  const instance = {
    /**
     * Execute fn() through the breaker.
     * Returns null immediately (without calling fn) when open or when half-open probes are exhausted.
     * Returns the fn() result on success, or throws (and records the failure) on error.
     */
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

      // state === "closed"
      try {
        const result = await fn();
        recordCall(true);
        // check if this success crosses nothing (state stays closed)
        return result;
      } catch (err) {
        recordCall(false);
        maybeAutoTransition(); // might open now
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

/**
 * Returns a snapshot of all registered breakers and their current stats.
 * @returns {{ name: string, stats: object }[]}
 */
function listBreakers() {
  return Array.from(registry.entries()).map(([name, b]) => ({
    name,
    stats: b.stats(),
  }));
}

/** clear all state (used by tests) */
function __resetForTests() {
  registry.clear();
}

module.exports = { createBreaker, listBreakers, __resetForTests };
