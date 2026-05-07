const { DEFAULT_STATUS } = require("./config");

const KNOWN_STATUSES = new Set(["UP", "DOWN", "UNAWARE"]);
const FALLBACK_STATUS = "UP";

function normalizeStatus(status) {
  const value = String(status || "").trim().toUpperCase();
  return KNOWN_STATUSES.has(value) ? value : FALLBACK_STATUS;
}

let currentStatus = normalizeStatus(DEFAULT_STATUS);

function getRuntimeStatus() {
  return currentStatus;
}

function setRuntimeStatus(status) {
  currentStatus = normalizeStatus(status);
  return currentStatus;
}

function isRuntimeDown() {
  return currentStatus === "DOWN";
}

function isRuntimeUp() {
  return currentStatus === "UP";
}

function isRuntimeUnaware() {
  return currentStatus === "UNAWARE";
}

function resetRuntimeStatus() {
  currentStatus = normalizeStatus(DEFAULT_STATUS);
  return currentStatus;
}

module.exports = {
  getRuntimeStatus,
  setRuntimeStatus,
  isRuntimeDown,
  isRuntimeUnaware,
  isRuntimeUp,
  resetRuntimeStatus
};
