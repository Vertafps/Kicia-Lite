const { DEFAULT_STATUS } = require("./config");

let currentStatus = DEFAULT_STATUS === "DOWN" ? "DOWN" : "UP";

function normalizeStatus(status) {
  return String(status || "").trim().toUpperCase() === "DOWN" ? "DOWN" : "UP";
}

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

function resetRuntimeStatus() {
  currentStatus = normalizeStatus(DEFAULT_STATUS);
  return currentStatus;
}

module.exports = {
  getRuntimeStatus,
  setRuntimeStatus,
  isRuntimeDown,
  resetRuntimeStatus
};
