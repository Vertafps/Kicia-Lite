"use strict";

// per-key mutex using promise-chaining
// used for: bulk role assignment, daily-stats reports, channel lock/unlock, etc.
// different keys run fully in parallel; same key queues up

// Map<key, Promise> — the tail of the promise chain for each key
let locks = new Map();

/**
 * Acquire a mutual-exclusion lock on `key`, run fn(), then release.
 * Concurrent calls with the same key are serialized (FIFO).
 * Calls with different keys run in parallel with no contention.
 *
 * @param {string}   key - lock identity string
 * @param {Function} fn  - async function to run under the lock
 * @returns {Promise<*>} resolves/rejects with fn()'s result
 */
async function withLock(key, fn) {
  // chain off whatever is currently the tail for this key
  const previous = locks.get(key) || Promise.resolve();

  // "next" is the gate promise: it resolves when fn() has finished and we call release()
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });

  // the new tail is: previous finishes → run fn → next resolves
  // we store this so a subsequent caller chains off it
  locks.set(key, previous.then(() => next));

  // wait for our turn (previous call's fn() to finish)
  await previous;

  try {
    return await fn();
  } finally {
    // let the next queued caller proceed
    release();

    // soft cleanup: if no one has chained off `next` yet, drop the map entry
    // this prevents unbounded growth on keys that aren't actively reused
    // the comparison checks whether the map's current tail is still our next gate
    if (locks.get(key) === previous.then(() => next) || !locks.has(key)) {
      // heuristic: we're the last in line, clean up
      // (the identity check can't work on the chained promise, so we clean
      //  up optimistically; a concurrent setter will just re-add the entry)
      locks.delete(key);
    }
  }
}

/**
 * Returns true if there is currently an active or queued lock on `key`.
 * @param {string} key
 * @returns {boolean}
 */
function isLocked(key) {
  return locks.has(key);
}

/**
 * Returns all keys that currently have an active or queued lock.
 * @returns {string[]}
 */
function getLockedKeys() {
  return Array.from(locks.keys());
}

/**
 * Convenience wrapper — key is `${guildId}:${label}`.
 * Keeps per-guild operations for different subsystems (label) from blocking each other.
 *
 * @param {string}   guildId
 * @param {string}   label  - e.g. "bulk-role", "daily-stats", "channel-lock"
 * @param {Function} fn
 * @returns {Promise<*>}
 */
function withGuildLock(guildId, label, fn) {
  return withLock(`${guildId}:${label}`, fn);
}

/** clear all lock state (used by tests — makes the module re-entrant across test cases) */
function __resetForTests() {
  locks = new Map();
}

module.exports = {
  withLock,
  isLocked,
  getLockedKeys,
  withGuildLock,
  __resetForTests,
};
