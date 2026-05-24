// programmer errors that should never be retried
const FATAL_ERRORS = new Set(["TypeError", "ReferenceError", "SyntaxError"]);

function defaultShouldRetry(err) {
  return !FATAL_ERRORS.has(err?.constructor?.name);
}

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

      if (!shouldRetry(err)) throw err;

      if (attempt === attempts) break;

      // exponential cap + jitter to avoid thundering herd
      const expDelay = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
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

function __resetForTests() {}

module.exports = { retryWithJitter, defaultShouldRetry, __resetForTests };
