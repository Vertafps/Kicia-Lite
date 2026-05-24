const {
  USER_COOLDOWN_MS,
  GLOBAL_COOLDOWN_MS,
  USER_COOLDOWN_EMOJI,
  GLOBAL_COOLDOWN_EMOJI
} = require("../config");
const { getSetting } = require("../settings");

const lastReplyByUser = new Map();
let lastGlobalReplyAt = 0;

function cleanupCooldowns(now = Date.now()) {
  const userCooldown = getSetting("support.cooldown.user") ?? USER_COOLDOWN_MS;
  for (const [userId, lastTime] of lastReplyByUser.entries()) {
    if (now - lastTime > userCooldown) {
      lastReplyByUser.delete(userId);
    }
  }
}

function getCooldownReaction(userId, now = Date.now()) {
  cleanupCooldowns(now);
  const userCooldown = getSetting("support.cooldown.user") ?? USER_COOLDOWN_MS;
  const globalCooldown = getSetting("support.cooldown.global") ?? GLOBAL_COOLDOWN_MS;
  if (lastReplyByUser.has(userId) && now - lastReplyByUser.get(userId) < userCooldown) {
    return USER_COOLDOWN_EMOJI;
  }
  if (now - lastGlobalReplyAt < globalCooldown) {
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
