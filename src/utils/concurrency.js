// per-key mutex via promise-chaining; different keys run in parallel

let locks = new Map();

async function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();

  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });

  locks.set(key, previous.then(() => next));

  await previous;

  try {
    return await fn();
  } finally {
    release();

    // optimistic cleanup — prevents unbounded map growth on one-shot keys
    if (locks.get(key) === previous.then(() => next) || !locks.has(key)) {
      locks.delete(key);
    }
  }
}

function isLocked(key) {
  return locks.has(key);
}

function getLockedKeys() {
  return Array.from(locks.keys());
}

function withGuildLock(guildId, label, fn) {
  return withLock(`${guildId}:${label}`, fn);
}

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
