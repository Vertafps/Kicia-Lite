"use strict";

const { BRAND } = require("./config");

const CARROT_BRAND = 0x4FD1D9;
const CARROT_DANGER = 0xFF6B6B;
const CARROT_WARN = 0xE8B247;
const CARROT_SUCCESS = 0x7EE787;
const CARROT_INFO = 0x79C0FF;
const CARROT_MUTED = 0x6D6F78;
const CARROT_PURPLE = 0xD2A8FF;
const CARROT_PINK = 0xF49BBF;

const ANSI = {
  reset: "[0m",
  bold: "[1m",
  underline: "[4m",
  gray: "[30m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  blue: "[34m",
  pink: "[35m",
  cyan: "[36m",
  white: "[37m"
};

const ANSI_TONE = {
  ok: ANSI.green,
  good: ANSI.green,
  success: ANSI.green,
  pass: ANSI.green,
  warn: ANSI.yellow,
  warning: ANSI.yellow,
  caution: ANSI.yellow,
  pending: ANSI.yellow,
  fail: ANSI.red,
  failed: ANSI.red,
  danger: ANSI.red,
  error: ANSI.red,
  bad: ANSI.red,
  info: ANSI.cyan,
  accent: ANSI.cyan,
  brand: ANSI.cyan,
  link: ANSI.cyan,
  // "dim" and "muted" map to white (37) instead of gray (30): code 30
  // renders #4f545c, near-invisible on the embed background. Hierarchy is
  // preserved by *bold + colored* tokens popping against the lighter body.
  // Use "gray" explicitly when you genuinely want the muted look.
  dim: ANSI.white,
  muted: ANSI.white,
  white: ANSI.white,
  pink: ANSI.pink,
  blue: ANSI.blue,
  green: ANSI.green,
  cyan: ANSI.cyan,
  yellow: ANSI.yellow,
  red: ANSI.red,
  gray: ANSI.gray
};

function ansi(text, color, { bold = false } = {}) {
  const safe = String(text ?? "");
  const codes = [];
  if (bold) codes.push(ANSI.bold);
  if (color) {
    const code = ANSI_TONE[color] || ANSI[color];
    if (code) codes.push(code);
  }
  if (!codes.length) return safe;
  return `${codes.join("")}${safe}${ANSI.reset}`;
}

function terminalBlock(lines) {
  const arr = Array.isArray(lines) ? lines : [lines];
  const body = arr.map((line) => (line == null ? "" : String(line))).join("\n");
  return ["```ansi", body || " ", "```"].join("\n");
}

function statusGlyph(tone) {
  switch (tone) {
    case "danger":
    case "fail":
    case "error":
      return "●";
    case "warn":
    case "warning":
      return "●";
    case "info":
    case "accent":
      return "●";
    case "muted":
    case "dim":
      return "○";
    default:
      return "●";
  }
}

function statusPill(label, tone = "good") {
  const glyph = statusGlyph(tone);
  return `\`${glyph} ${String(label).toUpperCase()}\``;
}

function ansiPill(label, tone = "good") {
  const glyph = statusGlyph(tone);
  return terminalBlock([ansi(`${glyph} ${String(label).toUpperCase()}`, tone, { bold: true })]);
}

function safePillValue(value, { mono = true } = {}) {
  if (value == null) return "—";
  const s = String(value);
  if (!s.trim()) return "—";
  if (!mono) return s;
  return `\`${s.replace(/`/g, "'")}\``;
}

function kpi(name, value, { mono = true } = {}) {
  return {
    name: String(name).toUpperCase(),
    value: safePillValue(value, { mono }),
    inline: true
  };
}

function kpiTone(name, value, tone) {
  const safe = String(value ?? "").replace(/`/g, "'");
  const text = terminalBlock([ansi(safe || "—", tone, { bold: true })]);
  return {
    name: String(name).toUpperCase(),
    value: text,
    inline: true
  };
}

function divider() {
  return "─".repeat(28);
}

function dividerField() {
  return { name: "​", value: divider(), inline: false };
}

function brandLabel(section) {
  const base = (BRAND.NAME || "Kicia").toUpperCase();
  if (!section) return base;
  return `${base} · ${String(section).toUpperCase()}`;
}

function brandAuthor(section, { iconURL, url } = {}) {
  const author = { name: brandLabel(section) };
  if (iconURL) author.iconURL = iconURL;
  if (url) author.url = url;
  return author;
}

function carrotFooter({ text, iconURL } = {}) {
  return {
    text: text || BRAND.NAME,
    iconURL: iconURL || undefined
  };
}

function progressBar(percent, { width = 24, full = "█", empty = "░" } = {}) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((pct / 100) * width);
  return `${full.repeat(filled)}${empty.repeat(Math.max(0, width - filled))}`;
}

function ansiProgressBar(percent, tone = "info", opts = {}) {
  const bar = progressBar(percent, opts);
  return `${ansi(bar, tone, { bold: true })}`;
}

function bracketLabel(label, tone = "info") {
  return `${ansi("[", "dim")}${ansi(label, tone, { bold: true })}${ansi("]", "dim")}`;
}

function colorForTone(tone) {
  switch (tone) {
    case "danger":
    case "fail":
    case "error":
      return CARROT_DANGER;
    case "warn":
    case "warning":
    case "caution":
      return CARROT_WARN;
    case "success":
    case "ok":
    case "good":
    case "pass":
      return CARROT_SUCCESS;
    case "info":
    case "accent":
    case "brand":
      return CARROT_INFO;
    case "purple":
      return CARROT_PURPLE;
    case "pink":
      return CARROT_PINK;
    case "muted":
    case "dim":
      return CARROT_MUTED;
    default:
      return CARROT_INFO;
  }
}

module.exports = {
  CARROT_BRAND,
  CARROT_DANGER,
  CARROT_WARN,
  CARROT_SUCCESS,
  CARROT_INFO,
  CARROT_MUTED,
  CARROT_PURPLE,
  CARROT_PINK,
  ANSI,
  ANSI_TONE,
  ansi,
  terminalBlock,
  statusPill,
  ansiPill,
  kpi,
  kpiTone,
  divider,
  dividerField,
  brandLabel,
  brandAuthor,
  carrotFooter,
  progressBar,
  ansiProgressBar,
  bracketLabel,
  colorForTone
};
