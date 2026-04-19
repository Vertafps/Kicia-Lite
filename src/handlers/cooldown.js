const { COOLDOWN_MS } = require("../config");

const lastReplyByUser = new Map();

function isCoolingDown(userId) {
  return Date.now() - (lastReplyByUser.get(userId) || 0) < COOLDOWN_MS;
}

function markReplied(userId) {
  lastReplyByUser.set(userId, Date.now());
}

module.exports = { isCoolingDown, markReplied };
