const { ActivityType } = require("discord.js");
const { BOT_PRESENCE_TEXT } = require("./config");

const MAX_PRESENCE_STATE_LENGTH = 128;
const BOT_PRESENCE_STATE_KEY = "bot_presence_state";
const CUSTOM_STATUS_ACTIVITY_NAME = "customstatus";
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

function sanitizePresenceState(input) {
  return String(input || "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validatePresenceState(input) {
  const state = sanitizePresenceState(input);

  if (!state) {
    return {
      ok: false,
      state,
      error: "state message cannot be empty"
    };
  }

  if (state.length > MAX_PRESENCE_STATE_LENGTH) {
    return {
      ok: false,
      state,
      error: `state message must be ${MAX_PRESENCE_STATE_LENGTH} characters or less`
    };
  }

  return {
    ok: true,
    state,
    error: null
  };
}

function buildCustomPresenceData(state = BOT_PRESENCE_TEXT) {
  const safeState = sanitizePresenceState(state) || BOT_PRESENCE_TEXT;
  return {
    status: "online",
    afk: false,
    activities: [
      {
        name: CUSTOM_STATUS_ACTIVITY_NAME,
        state: safeState,
        type: ActivityType.Custom
      }
    ]
  };
}

async function applyConfiguredPresenceState(clientUser, state = BOT_PRESENCE_TEXT) {
  if (!clientUser?.setPresence) return false;
  await clientUser.setPresence(buildCustomPresenceData(state));
  return true;
}

module.exports = {
  BOT_PRESENCE_STATE_KEY,
  CUSTOM_STATUS_ACTIVITY_NAME,
  MAX_PRESENCE_STATE_LENGTH,
  applyConfiguredPresenceState,
  buildCustomPresenceData,
  sanitizePresenceState,
  validatePresenceState
};
