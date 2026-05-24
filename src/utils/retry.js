"use strict";

// retry-with-exponential-backoff-and-jitter helper
// wraps transient-failure-prone calls like embedText or threat-intel fetches

// programmer errors that we should never retry — they indicate bugs in calling code
const FATAL_ERRORS = new Set(["TypeError", "ReferenceError", "SyntaxError"]);

/**
 * Default shouldRetry: rethrow programmer errors, retry everything else.
 * @param {Error} err
 * @returns {boolean}
 */
function defaultShouldRetry(err) {
  return !FATAL_ERRORS.has(err?.constructor?.name);
}

/**
 * Run fn() up to `attempts` times with exponential backoff + jitter.
 *
 * @param {Function} fn             - async function to call
 * @param {object}  [opts]
 * @param {number}  [opts.attempts=3]      - total attempts (not retries)
 * @param {number}  [opts.baseMs=200]      - base delay in ms; also jitter ceiling
 * @param {number}  [opts.maxMs=2000]      - max delay cap before jitter
 * @param {Function}[opts.shouldRetry]     - (err) => bool; return false to rethrow immediately
 * @param {Function}[opts.onRetry]         - ({attempt, err, nextDelayMs}) called before each sleep
 * @returns {Promise<*>} resolves with fn()'s return value; rejects with last error after exhaustion
 */
async function retryWithJitter(fn, {
  attempts = 3,
  baseMs = 200,
  maxMs = 2000,
  shouldRetry = defaultShouldRetry,
  onRetry,
} = {}) {
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // non-retryable (programmer error) → bail immediately
      if (!shouldRetry(err)) throw err;

      // exhausted all attempts
      if (attempt === attempts) break;

      // exponential cap: baseMs * 2^(attempt-1), capped at maxMs
      const expDelay = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
      // jitter: add random [0, baseMs) so concurrent callers don't thunderherd
      const jitter = Math.random() * baseMs;
      const nextDelayMs = Math.floor(expDelay + jitter);

      if (typeof onRetry === "function") {
        try {
          onRetry({ attempt, err, nextDelayMs });
        } catch (_) {
          // never let the callback abort the retry loop
        }
      }

      await new Promise((resolve) => setTimeout(resolve, nextDelayMs));
    }
  }

  throw lastErr;
}

/** clear any state (tests; this module is stateless but exported for symmetry) */
function __resetForTests() {
  // nothing to clear — retryWithJitter is purely functional
}

module.exports = { retryWithJitter, defaultShouldRetry, __resetForTests };
