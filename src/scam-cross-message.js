"use strict";

/**
 * Per-user partial-signal accumulator.
 *
 * Closes the obvious split-message evasion: a scammer sends "got configs",
 * then "20 robux", then "dm me" across three short messages within a minute.
 * Each message alone falls below the decompose threshold; together they're
 * a clear scam.
 *
 * Keeps an in-memory buffer keyed by userId that the moderation pipeline
 * can flush into the standard rawTexts array before calling classify.
 *
 * Safety:
 *  - 60 s sliding window — anything older is evicted.
 *  - 5 messages cap per user — protects against memory blowups.
 *  - 50 active users cap — global eviction when exceeded.
 *  - Only stores text + timestamp; no message IDs / channel IDs.
 */

const WINDOW_MS = 60 * 1000;
const MAX_PER_USER = 5;
const MAX_USERS = 50;

const _buffer = new Map(); // userId -> { entries: [{text, ts}], updatedAt }

function pruneEntries(now, list) {
  return list.filter((entry) => now - entry.ts < WINDOW_MS).slice(-MAX_PER_USER);
}

function evictOldestIfFull() {
  if (_buffer.size <= MAX_USERS) return;
  let oldestKey = null;
  let oldestTs = Infinity;
  for (const [key, value] of _buffer.entries()) {
    if (value.updatedAt < oldestTs) {
      oldestTs = value.updatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey != null) _buffer.delete(oldestKey);
}

function pushUserMessage(userId, text, now = Date.now()) {
  if (!userId || !text) return;
  const trimmed = String(text).slice(0, 600);
  const existing = _buffer.get(userId) || { entries: [], updatedAt: 0 };
  const entries = pruneEntries(now, [...existing.entries, { text: trimmed, ts: now }]);
  _buffer.set(userId, { entries, updatedAt: now });
  evictOldestIfFull();
}

function getRecentMessages(userId, now = Date.now()) {
  const existing = _buffer.get(userId);
  if (!existing) return [];
  const entries = pruneEntries(now, existing.entries);
  if (!entries.length) {
    _buffer.delete(userId);
    return [];
  }
  if (entries.length !== existing.entries.length) {
    _buffer.set(userId, { entries, updatedAt: existing.updatedAt });
  }
  return entries.map((e) => e.text);
}

function clearUser(userId) {
  if (userId) _buffer.delete(userId);
}

function snapshotForTests() {
  return [..._buffer.entries()].map(([userId, value]) => ({
    userId,
    entries: value.entries.slice()
  }));
}

function resetForTests() {
  _buffer.clear();
}

module.exports = {
  pushUserMessage,
  getRecentMessages,
  clearUser,
  snapshotForTests,
  resetForTests,
  WINDOW_MS,
  MAX_PER_USER,
  MAX_USERS
};
