/**
 * Carrot UI — barrel export.
 *
 * Single import surface for handler files:
 *
 *   const ui = require('./ui');
 *   await channel.send(ui.buildStatusEmbed({...}));
 *
 * Or pick a builder directly:
 *
 *   const { buildScamEmbed } = require('./ui');
 */

// Tokens
const { ACCENT, ACCENT_VARIANTS, STATUS, SURFACE, TYPE, BRAND } = require('./colors');

// ANSI helpers
const ansiHelpers = require('./ansi');

// Embed builders
const scam     = require('./embeds/scam');
const sweep    = require('./embeds/sweep');
const outage   = require('./embeds/outage');
const status   = require('./embeds/status');
const daily    = require('./embeds/daily');
const kb       = require('./embeds/kb');
const lockdown = require('./embeds/lockdown');

// Canvas renderers (exposed for advanced callers / testing)
const canvas = {
  renderStatusOrbRibbon:  require('./canvas/statusOrb').renderStatusOrbRibbon,
  renderOutageTimeline:   require('./canvas/outageTimeline').renderOutageTimeline,
  renderScorecard:        require('./canvas/scorecard').renderScorecard,
  renderDailyRecap:       require('./canvas/dailyRecap').renderDailyRecap,
  renderConfidenceDial:   require('./canvas/confidenceDial').renderConfidenceDial,
  renderConfidenceMeter:  require('./canvas/confidenceMeter').renderConfidenceMeter,
  renderLockdownGrid:     require('./canvas/lockdownGrid').renderLockdownGrid,
  renderKbEditorial:      require('./canvas/kbEditorial').renderKbEditorial,
  renderExecutorList:     require('./canvas/executorList').renderExecutorList,
};

module.exports = {
  // Tokens
  ACCENT, ACCENT_VARIANTS, STATUS, SURFACE, TYPE, BRAND,

  // ANSI
  ansi: ansiHelpers.ansi,
  ansiLine: ansiHelpers.line,
  ansiPad: ansiHelpers.pad,
  ansiBlock: ansiHelpers.block,
  ansiProgress: ansiHelpers.progressBar,

  // Embed builders — every one returns { embeds, components, files }
  ...scam, ...sweep, ...outage, ...status, ...daily, ...kb, ...lockdown,

  // Canvas (advanced)
  canvas,
};
