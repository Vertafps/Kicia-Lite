const {
  USER_COOLDOWN_MS,
  GLOBAL_COOLDOWN_MS,
  USER_COOLDOWN_EMOJI,
  GLOBAL_COOLDOWN_EMOJI
} = require("../config");

const lastReplyByUser = new Map();
let lastGlobalReplyAt = 0;

function cleanupCooldowns(now = Date.now()) {
  for (const [userId, lastTime] of lastReplyByUser.entries()) {
    if (now - lastTime > USER_COOLDOWN_MS) {
      lastReplyByUser.delete(userId);
    }
  }
}

function getCooldownReaction(userId, now = Date.now()) {
  cleanupCooldowns(now);
  if (lastReplyByUser.has(userId) && now - lastReplyByUser.get(userId) < USER_COOLDOWN_MS) {
    return USER_COOLDOWN_EMOJI;
  }
  if (now - lastGlobalReplyAt < GLOBAL_COOLDOWN_MS) {
    return GLOBAL_COOLDOWN_EMOJI;
  }
  return null;
}

function markGuildReply(userId, now = Date.now()) {
  lastReplyByUser.set(userId, now);
  lastGlobalReplyAt = now;
}

function resetCooldowns() {
  lastReplyByUser.clear();
  lastGlobalReplyAt = 0;
}

module.exports = { getCooldownReaction, markGuildReply, resetCooldowns };
