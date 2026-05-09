"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let Resvg = null;
let resvgLoadError = null;
try {
  Resvg = require("@resvg/resvg-js").Resvg;
} catch (err) {
  resvgLoadError = err;
}

const CACHE_DIR = path.resolve(__dirname, "..", "data", "viz-cache");

const ACCENT = "#4FD1D9";
const ACCENT_DEEP = "#2BA8B0";
const VIZ_BG = "#0e0f12";
const VIZ_GRID = "rgba(255,255,255,0.04)";
const VIZ_TEXT = "#dbdee1";
const VIZ_MUTED = "#6d6f78";
const VIZ_UP = "#7ee787";
const VIZ_DOWN = "#ff6b6b";
const VIZ_WARN = "#f7c948";
const VIZ_INFO = "#79c0ff";
const VIZ_W = 488;

const FONT_SANS = "'Geist','Inter','Segoe UI',Roboto,sans-serif";
const FONT_MONO = "'Geist Mono','SFMono-Regular',Consolas,monospace";

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function hashContent(svg, opts = {}) {
  const h = crypto.createHash("sha256");
  h.update(svg);
  h.update(JSON.stringify(opts));
  return h.digest("hex").slice(0, 24);
}

function renderSvgToPng(svg, { width = VIZ_W, fitTo = "width" } = {}) {
  if (!Resvg) return null;
  const opts = {
    fitTo: fitTo === "width" ? { mode: "width", value: width } : undefined,
    background: VIZ_BG,
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "DejaVu Sans"
    }
  };
  try {
    const r = new Resvg(svg, opts);
    return r.render().asPng();
  } catch {
    return null;
  }
}

function renderCachedPng(svg, opts = {}) {
  if (!Resvg) return null;
  ensureCacheDir();
  const key = hashContent(svg, opts);
  const file = path.join(CACHE_DIR, `${key}.png`);
  if (fs.existsSync(file)) {
    try {
      return fs.readFileSync(file);
    } catch {}
  }
  const png = renderSvgToPng(svg, opts);
  if (png) {
    try { fs.writeFileSync(file, png); } catch {}
  }
  return png;
}

function escapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function defs() {
  return `
<defs>
  <pattern id="vg" width="20" height="20" patternUnits="userSpaceOnUse">
    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="${VIZ_GRID}" stroke-width="1"/>
  </pattern>
  <linearGradient id="accent-grad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${ACCENT}"/>
    <stop offset="100%" stop-color="${ACCENT_DEEP}"/>
  </linearGradient>
</defs>`;
}

function botAvatarSvg({ size = 64, accent = ACCENT, accentDeep = ACCENT_DEEP } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 40">
  <defs>
    <linearGradient id="kbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f2126"/>
      <stop offset="100%" stop-color="#0d0e12"/>
    </linearGradient>
    <linearGradient id="kshield" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="${accentDeep}"/>
    </linearGradient>
    <radialGradient id="kglow" cx="0.5" cy="0.4" r="0.6">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="20" cy="20" r="20" fill="url(#kbg)"/>
  <circle cx="20" cy="20" r="20" fill="url(#kglow)"/>
  <g transform="rotate(15 20 20)">
    <path d="M20 6 L31 12 L31 24 L20 33 L9 24 L9 12 Z" fill="url(#kshield)" stroke="${accent}" stroke-width="0.5" opacity="0.95"/>
    <path d="M20 9 L28.5 13.5 L28.5 23 L20 30 L11.5 23 L11.5 13.5 Z" fill="none" stroke="rgba(0,0,0,0.4)" stroke-width="0.6"/>
  </g>
  <g>
    <ellipse cx="20" cy="20" rx="9" ry="5.5" fill="#0a0b0f" opacity="0.85"/>
    <ellipse cx="20" cy="20" rx="9" ry="5.5" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="0.5"/>
    <circle cx="20" cy="20" r="3.5" fill="${accent}"/>
    <circle cx="20" cy="20" r="3.5" fill="none" stroke="rgba(0,0,0,0.5)" stroke-width="0.4"/>
    <circle cx="20" cy="20" r="1.6" fill="#0a0b0f"/>
    <circle cx="21" cy="19" r="0.7" fill="#fff" opacity="0.9"/>
  </g>
  <circle cx="20" cy="6.5" r="1.4" fill="${accent}"/>
</svg>`;
}

function statusOrbRibbonSvg({ status = "UP", uptime = 99.94, ribbon } = {}) {
  const data = ribbon || Array.from({ length: 96 }, () => "up");
  const tone = status === "DOWN" ? VIZ_DOWN : status === "UNAWARE" ? VIZ_WARN : VIZ_UP;
  const cell = (VIZ_W - 32 - 60) / data.length;
  const ribbonY = 130;
  const ticks = [0, 90, 180, 270]
    .map((a) => {
      const ax = 60 + 36 * Math.cos((a * Math.PI) / 180);
      const ay = 70 + 36 * Math.sin((a * Math.PI) / 180);
      const bx = 60 + 44 * Math.cos((a * Math.PI) / 180);
      const by = 70 + 44 * Math.sin((a * Math.PI) / 180);
      return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${tone}" stroke-width="1.2" opacity="0.7"/>`;
    })
    .join("");
  const cells = data
    .map((s, i) => {
      const fill = s === "down" ? VIZ_DOWN : s === "unaware" ? VIZ_WARN : VIZ_UP;
      const op = s === "up" ? 0.85 : 1;
      return `<rect x="${16 + i * cell}" y="${ribbonY}" width="${cell - 0.8}" height="26" fill="${fill}" opacity="${op}"/>`;
    })
    .join("");
  const hourTicks = [0, 6, 12, 18, 24]
    .map((h) => {
      const x = 16 + (h / 24) * (data.length * cell);
      return `<line x1="${x}" y1="${ribbonY + 28}" x2="${x}" y2="${ribbonY + 32}" stroke="${VIZ_MUTED}" stroke-width="1"/><text x="${x}" y="${ribbonY + 44}" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" text-anchor="middle">${String(h).padStart(2, "0")}:00</text>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${VIZ_W}" height="200" viewBox="0 0 ${VIZ_W} 200">
  <defs>
    <radialGradient id="orb-glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="${tone}" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="${tone}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orb-fill" cx="0.35" cy="0.3" r="0.7">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.6"/>
      <stop offset="40%" stop-color="${tone}"/>
      <stop offset="100%" stop-color="${tone}" stop-opacity="0.3"/>
    </radialGradient>
    <pattern id="vg" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="${VIZ_GRID}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${VIZ_W}" height="200" fill="${VIZ_BG}"/>
  <rect width="${VIZ_W}" height="200" fill="url(#vg)"/>
  <circle cx="60" cy="70" r="50" fill="url(#orb-glow)"/>
  <circle cx="60" cy="70" r="42" fill="none" stroke="${tone}" stroke-width="0.5" opacity="0.3"/>
  <circle cx="60" cy="70" r="36" fill="none" stroke="${tone}" stroke-width="0.5" opacity="0.5"/>
  <circle cx="60" cy="70" r="28" fill="url(#orb-fill)"/>
  <circle cx="60" cy="70" r="28" fill="none" stroke="${tone}" stroke-width="1"/>
  ${ticks}
  <text x="130" y="50" fill="${VIZ_MUTED}" font-size="10" font-family="${FONT_MONO}" letter-spacing="1.5">CURRENT</text>
  <text x="130" y="80" fill="${tone}" font-size="32" font-weight="700" font-family="${FONT_SANS}" letter-spacing="0.5">${escapeXml(status)}</text>
  <text x="130" y="100" fill="${VIZ_TEXT}" font-size="11" font-family="${FONT_MONO}" opacity="0.7">uptime · ${uptime.toFixed(2)}% (24h)</text>
  <text x="16" y="${ribbonY - 8}" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" letter-spacing="1.5">24H UPTIME RIBBON</text>
  <text x="${VIZ_W - 60}" y="${ribbonY - 8}" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" text-anchor="end">96 slots · 15m each</text>
  ${cells}
  ${hourTicks}
</svg>`;
}

function scamConfidenceSvg({ score = 87, signals = [] } = {}) {
  const sig = signals.length
    ? signals
    : [
        { name: "Bayes classifier", weight: 92 },
        { name: "Keyword pattern", weight: 88 },
        { name: "Contact-DM steering", weight: 81 },
        { name: "Embedding similarity", weight: 74 },
        { name: "Gemini review", weight: 95 }
      ];
  const w = VIZ_W;
  const h = 200;
  const cx = 86;
  const cy = 110;
  const R = 64;
  const start = Math.PI;
  const end = Math.PI + (score / 100) * Math.PI;
  const x1 = cx + R * Math.cos(start);
  const y1 = cy + R * Math.sin(start);
  const x2 = cx + R * Math.cos(end);
  const y2 = cy + R * Math.sin(end);
  const xEnd = cx + R * Math.cos(0);
  const yEnd = cy + R * Math.sin(0);
  const tone = score >= 85 ? VIZ_DOWN : score >= 65 ? VIZ_WARN : VIZ_UP;
  const label = score >= 85 ? "CONFIRMED" : score >= 65 ? "BORDERLINE" : "CLEAN";
  const ticks = [0, 25, 50, 75, 100]
    .map((t) => {
      const a = Math.PI + (t / 100) * Math.PI;
      const x = cx + (R + 12) * Math.cos(a);
      const y = cy + (R + 12) * Math.sin(a);
      return `<text x="${x}" y="${y + 3}" fill="${VIZ_MUTED}" font-size="8" font-family="${FONT_MONO}" text-anchor="middle">${t}</text>`;
    })
    .join("");
  const bars = sig
    .slice(0, 6)
    .map((s, i) => {
      const y = 38 + i * 28;
      const safeName = escapeXml(s.name).slice(0, 28);
      const weight = Math.max(0, Math.min(100, Number(s.weight) || 0));
      return `<text x="196" y="${y - 2}" fill="${VIZ_TEXT}" font-size="10" font-family="${FONT_MONO}">${safeName}</text>
<text x="${w - 16}" y="${y - 2}" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" text-anchor="end">${weight}%</text>
<rect x="196" y="${y + 4}" width="${w - 16 - 196}" height="6" rx="3" fill="#1a1c20"/>
<rect x="196" y="${y + 4}" width="${(w - 16 - 196) * (weight / 100)}" height="6" rx="3" fill="${VIZ_INFO}" opacity="0.85"/>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="sc-track" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${VIZ_UP}"/>
      <stop offset="60%" stop-color="${VIZ_WARN}"/>
      <stop offset="100%" stop-color="${VIZ_DOWN}"/>
    </linearGradient>
    <pattern id="sc-grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="${VIZ_GRID}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="${VIZ_BG}"/>
  <rect width="${w}" height="${h}" fill="url(#sc-grid)"/>
  <text x="16" y="16" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" letter-spacing="1.5">SCAM CONFIDENCE</text>
  <path d="M ${x1} ${y1} A ${R} ${R} 0 0 1 ${xEnd} ${yEnd}" stroke="#1a1c20" stroke-width="14" fill="none" stroke-linecap="round"/>
  <path d="M ${x1} ${y1} A ${R} ${R} 0 ${end - start > Math.PI ? 1 : 0} 1 ${x2} ${y2}" stroke="url(#sc-track)" stroke-width="14" fill="none" stroke-linecap="round"/>
  ${ticks}
  <text x="${cx}" y="${cy - 6}" fill="${tone}" font-size="32" font-weight="700" font-family="${FONT_SANS}" text-anchor="middle">${score}</text>
  <text x="${cx}" y="${cy + 10}" fill="${tone}" font-size="9" font-family="${FONT_MONO}" text-anchor="middle" letter-spacing="1.5">${label}</text>
  ${bars}
</svg>`;
}

function lockdownGridSvg({ channels } = {}) {
  const ch = channels && channels.length ? channels : [
    { name: "general", status: "locked" },
    { name: "support", status: "locked" }
  ];
  const w = VIZ_W;
  const cols = Math.min(4, Math.max(1, ch.length));
  const cellW = (w - 32 - 12 * (cols - 1)) / cols;
  const cellH = 56;
  const rows = Math.ceil(ch.length / cols);
  const h = 28 + rows * (cellH + 12);
  const cells = ch
    .map((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = 16 + col * (cellW + 12);
      const y = 28 + row * (cellH + 12);
      const tone = c.status === "locked" ? VIZ_DOWN : c.status === "unlocked" ? VIZ_UP : VIZ_MUTED;
      const stroke = c.status === "untouched" ? "#24262c" : tone;
      const strokeOp = c.status === "untouched" ? 1 : 0.5;
      const wash = c.status === "locked" ? `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="4" fill="${tone}" opacity="0.08"/>` : "";
      let icon = "";
      if (c.status === "locked") {
        icon = `<rect x="${x + 10}" y="${y + 18}" width="14" height="10" rx="1" fill="${tone}"/><path d="M ${x + 13} ${y + 18} V ${y + 16} a 4 4 0 0 1 8 0 V ${y + 18}" stroke="${tone}" stroke-width="1.5" fill="none"/>`;
      } else if (c.status === "unlocked") {
        icon = `<rect x="${x + 10}" y="${y + 18}" width="14" height="10" rx="1" fill="${tone}"/><path d="M ${x + 13} ${y + 18} V ${y + 16} a 4 4 0 0 1 8 0" stroke="${tone}" stroke-width="1.5" fill="none"/>`;
      } else {
        icon = `<circle cx="${x + 17}" cy="${y + 23}" r="3" fill="none" stroke="${tone}" stroke-width="1.5" opacity="0.5"/>`;
      }
      return `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="4" fill="#15171b" stroke="${stroke}" stroke-opacity="${strokeOp}" stroke-width="1"/>
${wash}
${icon}
<text x="${x + 32}" y="${y + 22}" fill="${VIZ_TEXT}" font-size="11" font-family="${FONT_MONO}" font-weight="600">#${escapeXml(c.name)}</text>
<text x="${x + 32}" y="${y + 38}" fill="${tone}" font-size="9" font-family="${FONT_MONO}" letter-spacing="1.2">${escapeXml(c.status).toUpperCase()}</text>`;
    })
    .join("");
  const lockedCount = ch.filter((c) => c.status === "locked").length;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <pattern id="lg-grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="${VIZ_GRID}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="${VIZ_BG}"/>
  <rect width="${w}" height="${h}" fill="url(#lg-grid)"/>
  <text x="16" y="16" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" letter-spacing="1.5">LOCKDOWN STATE · ${lockedCount}/${ch.length} CHANNELS LOCKED</text>
  ${cells}
</svg>`;
}

function jarvisScorecardSvg({ systems } = {}) {
  const s = systems && systems.length ? systems : [
    { key: "RUNTIME", score: 100, status: "ok", detail: "all good" }
  ];
  const w = VIZ_W;
  const h = 220;
  const cell = (w - 32) / s.length;
  const overall = Math.round(s.reduce((a, b) => a + (Number(b.score) || 0), 0) / s.length);
  const overallTone = overall >= 90 ? VIZ_UP : overall >= 75 ? VIZ_WARN : VIZ_DOWN;
  const bars = s
    .map((sys, i) => {
      const x = 16 + i * cell;
      const score = Math.max(0, Math.min(100, Number(sys.score) || 0));
      const barH = (score / 100) * 110;
      const tone = sys.status === "fail" ? VIZ_DOWN : sys.status === "warn" ? VIZ_WARN : VIZ_UP;
      const detail = String(sys.detail || "");
      const detailShort = detail.length > 22 ? detail.slice(0, 22) + "…" : detail;
      return `<rect x="${x + cell / 2 - 18}" y="40" width="36" height="110" rx="3" fill="#1a1c20" stroke="#24262c" stroke-width="1"/>
<rect x="${x + cell / 2 - 18}" y="${40 + 110 - barH}" width="36" height="${barH}" rx="3" fill="${tone}" opacity="0.9"/>
<text x="${x + cell / 2}" y="${40 + 110 - barH - 6}" fill="${tone}" font-size="11" font-family="${FONT_MONO}" font-weight="700" text-anchor="middle">${score}</text>
<circle cx="${x + cell / 2}" cy="166" r="3" fill="${tone}"/>
<text x="${x + cell / 2}" y="184" fill="${VIZ_TEXT}" font-size="10" font-family="${FONT_MONO}" font-weight="700" text-anchor="middle">${escapeXml(sys.key)}</text>
<text x="${x + cell / 2}" y="200" fill="${VIZ_MUTED}" font-size="8.5" font-family="${FONT_MONO}" text-anchor="middle">${escapeXml(detailShort)}</text>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <pattern id="js-grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="${VIZ_GRID}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="${VIZ_BG}"/>
  <rect width="${w}" height="${h}" fill="url(#js-grid)"/>
  <text x="16" y="16" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" letter-spacing="1.5">SYSTEMS SWEEP · DIAGNOSTIC SCORECARD</text>
  <text x="${w - 16}" y="16" fill="${overallTone}" font-size="11" font-family="${FONT_MONO}" text-anchor="end" font-weight="700">OVERALL ${overall}%</text>
  ${bars}
</svg>`;
}

function dailyRecapSvg({ slices, activity, outageHour } = {}) {
  const sl = slices && slices.length ? slices : [
    { label: "Help Replied", value: 64, color: VIZ_UP },
    { label: "Scam Cleared", value: 18, color: VIZ_WARN },
    { label: "Scam Confirmed", value: 8, color: VIZ_DOWN },
    { label: "Status Pings", value: 24, color: VIZ_INFO }
  ];
  const a = activity && activity.length === 24 ? activity : Array.from({ length: 24 }, () => 10);
  const w = VIZ_W;
  const h = 200;
  const cx = 70;
  const cy = 100;
  const R = 50;
  const r = 32;
  const total = sl.reduce((s, x) => s + (Number(x.value) || 0), 0);
  let acc = 0;
  const arcs = sl
    .map((s) => {
      const v = Number(s.value) || 0;
      const start = (acc / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
      acc += v;
      const end = (acc / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
      const large = end - start > Math.PI ? 1 : 0;
      const x1 = cx + R * Math.cos(start);
      const y1 = cy + R * Math.sin(start);
      const x2 = cx + R * Math.cos(end);
      const y2 = cy + R * Math.sin(end);
      const x3 = cx + r * Math.cos(end);
      const y3 = cy + r * Math.sin(end);
      const x4 = cx + r * Math.cos(start);
      const y4 = cy + r * Math.sin(start);
      return `<path d="M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${large} 0 ${x4} ${y4} Z" fill="${s.color}" opacity="0.92"/>`;
    })
    .join("");
  const legend = sl
    .map((s, i) => `<g transform="translate(${cx + R + 6}, ${cy - 26 + i * 13})"><rect width="8" height="8" fill="${s.color}" rx="1"/><text x="12" y="7" fill="${VIZ_TEXT}" font-size="8.5" font-family="${FONT_MONO}">${Number(s.value) || 0} ${escapeXml(s.label.split(" ")[0])}</text></g>`)
    .join("");
  const actX0 = 200;
  const actY0 = 30;
  const actW = w - actX0 - 16;
  const actH = 130;
  const max = Math.max(...a, 1);
  const bw = actW / a.length;
  const bars = a
    .map((v, i) => {
      const isOutage = outageHour != null && i === outageHour;
      return `<rect x="${actX0 + i * bw}" y="${actY0 + actH - (v / max) * actH}" width="${bw - 1}" height="${(v / max) * actH}" fill="${isOutage ? VIZ_DOWN : VIZ_INFO}" opacity="${isOutage ? 1 : 0.7}" rx="1"/>`;
    })
    .join("");
  const outageMarker = outageHour != null
    ? (() => {
        const x = actX0 + outageHour * bw + bw / 2;
        const hh = String(outageHour).padStart(2, "0");
        return `<line x1="${x}" y1="${actY0 - 8}" x2="${x}" y2="${actY0 + actH}" stroke="${VIZ_DOWN}" stroke-width="1" stroke-dasharray="2 2" opacity="0.7"/><rect x="${x - 36}" y="${actY0 - 18}" width="72" height="14" rx="3" fill="${VIZ_DOWN}" opacity="0.18"/><text x="${x}" y="${actY0 - 8}" fill="${VIZ_DOWN}" font-size="9" font-family="${FONT_MONO}" text-anchor="middle" font-weight="700">⚠ OUTAGE ${hh}:00</text>`;
      })()
    : "";
  const hours = [0, 6, 12, 18]
    .map((h2) => `<text x="${actX0 + h2 * bw + bw / 2}" y="${actY0 + actH + 12}" fill="${VIZ_MUTED}" font-size="8.5" font-family="${FONT_MONO}" text-anchor="middle">${String(h2).padStart(2, "0")}h</text>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <pattern id="dr-grid" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="${VIZ_GRID}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="${VIZ_BG}"/>
  <rect width="${w}" height="${h}" fill="url(#dr-grid)"/>
  <text x="20" y="16" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" letter-spacing="1.5">MIX</text>
  <text x="${actX0}" y="16" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" letter-spacing="1.5">24H ACTIVITY</text>
  ${arcs}
  <text x="${cx}" y="${cy - 2}" fill="${VIZ_TEXT}" font-size="20" font-family="${FONT_SANS}" font-weight="700" text-anchor="middle">${total}</text>
  <text x="${cx}" y="${cy + 12}" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" text-anchor="middle" letter-spacing="1.2">EVENTS</text>
  ${legend}
  ${bars}
  ${outageMarker}
  ${hours}
</svg>`;
}

function outageTimelineSvg({ reports, threshold = 4, windowMin = 10 } = {}) {
  const r = reports && reports.length ? reports : [];
  const w = VIZ_W;
  const h = 180;
  const padL = 36;
  const padR = 16;
  const padT = 24;
  const padB = 32;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const seen = new Set();
  const series = r.map((p) => {
    seen.add(p.user || p.userId);
    return { t: Number(p.t) || 0, n: seen.size, conf: Number(p.conf) || 0 };
  });
  const xFor = (t) => padL + (t / windowMin) * plotW;
  const yFor = (n) => padT + plotH - (n / Math.max(threshold + 2, 6)) * plotH;
  const path = series.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(p.t)} ${yFor(p.n)}`).join(" ");
  const yLabels = [0, 2, 4, 6]
    .map((n) => `<text x="${padL - 6}" y="${yFor(n) + 3}" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" text-anchor="end">${n}</text>`)
    .join("");
  const markers = series
    .map((p, i) => {
      const triggered = p.n >= threshold;
      return `<circle cx="${xFor(p.t)}" cy="${yFor(p.n)}" r="4" fill="${triggered ? VIZ_DOWN : VIZ_INFO}" stroke="${VIZ_BG}" stroke-width="1.5"/><text x="${xFor(p.t)}" y="${padT + plotH + 14}" fill="${VIZ_MUTED}" font-size="8" font-family="${FONT_MONO}" text-anchor="middle">u${i + 1}</text><text x="${xFor(p.t)}" y="${padT + plotH + 24}" fill="${triggered ? VIZ_DOWN : VIZ_MUTED}" font-size="8" font-family="${FONT_MONO}" text-anchor="middle">${p.conf}%</text>`;
    })
    .join("");
  const trig = series.find((p) => p.n >= threshold);
  const trigCallout = trig
    ? `<line x1="${xFor(trig.t)}" y1="${padT}" x2="${xFor(trig.t)}" y2="${yFor(trig.n)}" stroke="${VIZ_DOWN}" stroke-width="1" stroke-dasharray="2 2" opacity="0.7"/><rect x="${xFor(trig.t) + 6}" y="${padT + 4}" width="78" height="16" rx="3" fill="${VIZ_DOWN}" opacity="0.15"/><text x="${xFor(trig.t) + 10}" y="${padT + 15}" fill="${VIZ_DOWN}" font-size="9" font-family="${FONT_MONO}" font-weight="700">⚡ TRIGGERED</text>`
    : "";
  const area = series.length
    ? `<path d="${path} L ${xFor(series[series.length - 1].t)} ${padT + plotH} L ${xFor(series[0].t)} ${padT + plotH} Z" fill="url(#ot-area)"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="ot-area" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${VIZ_INFO}" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="${VIZ_INFO}" stop-opacity="0"/>
    </linearGradient>
    <pattern id="ot-grid" width="40" height="20" patternUnits="userSpaceOnUse">
      <path d="M 40 0 L 0 0 0 20" fill="none" stroke="${VIZ_GRID}" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="${VIZ_BG}"/>
  <rect width="${w}" height="${h}" fill="url(#ot-grid)"/>
  <text x="${padL}" y="14" fill="${VIZ_MUTED}" font-size="9" font-family="${FONT_MONO}" letter-spacing="1.5">REPORT WINDOW · ${windowMin} MIN ROLLING</text>
  <rect x="${padL}" y="${padT}" width="${plotW}" height="${yFor(threshold) - padT}" fill="${VIZ_DOWN}" opacity="0.08"/>
  <line x1="${padL}" y1="${yFor(threshold)}" x2="${w - padR}" y2="${yFor(threshold)}" stroke="${VIZ_DOWN}" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>
  <text x="${w - padR - 4}" y="${yFor(threshold) - 4}" fill="${VIZ_DOWN}" font-size="9" font-family="${FONT_MONO}" text-anchor="end">TRIGGER ≥ ${threshold}</text>
  ${yLabels}
  ${area}
  <path d="${path}" fill="none" stroke="${VIZ_INFO}" stroke-width="2" stroke-linejoin="round"/>
  ${markers}
  ${trigCallout}
</svg>`;
}

function terminalPaneSvg({ title = "JARVIS // wizard-of-kicia", lines = [], width = VIZ_W } = {}) {
  const padX = 16;
  const padY = 14;
  const lineH = 16;
  const chromeH = 32;
  const inner = lines.length;
  const h = chromeH + padY * 2 + inner * lineH + 8;
  const wt = (s) => escapeXml(String(s));
  const renderTokens = (tokens, baseY) => {
    let x = padX;
    return tokens
      .map((tk) => {
        const text = wt(tk.text);
        const fill = tk.color || "#c9d1d9";
        const weight = tk.bold ? 700 : 400;
        const charW = (tk.charW != null ? tk.charW : 7.0);
        const out = `<text x="${x}" y="${baseY}" fill="${fill}" font-family="${FONT_MONO}" font-size="12.5" font-weight="${weight}" xml:space="preserve">${text}</text>`;
        x += text.length * charW;
        return out;
      })
      .join("");
  };
  const renderedLines = lines
    .map((line, i) => {
      const baseY = chromeH + padY + (i + 1) * lineH - 4;
      if (typeof line === "string") {
        return `<text x="${padX}" y="${baseY}" fill="#c9d1d9" font-family="${FONT_MONO}" font-size="12.5" xml:space="preserve">${wt(line)}</text>`;
      }
      if (Array.isArray(line)) return renderTokens(line, baseY);
      return "";
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">
  <defs>
    <linearGradient id="tp-chrome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#15171b"/>
      <stop offset="100%" stop-color="#0e0f12"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${h}" rx="6" fill="#0c0d10" stroke="#1f2126" stroke-width="1"/>
  <rect width="${width}" height="${chromeH}" rx="6" fill="url(#tp-chrome)"/>
  <rect y="${chromeH - 1}" width="${width}" height="1" fill="#1a1c20"/>
  <circle cx="16" cy="${chromeH / 2}" r="5" fill="#ff5f56"/>
  <circle cx="32" cy="${chromeH / 2}" r="5" fill="#ffbd2e"/>
  <circle cx="48" cy="${chromeH / 2}" r="5" fill="#27c93f"/>
  <text x="${width / 2}" y="${chromeH / 2 + 4}" fill="#5b6168" font-size="11" font-family="${FONT_MONO}" text-anchor="middle" letter-spacing="0.5">${wt(title)}</text>
  ${renderedLines}
</svg>`;
}

let AttachmentBuilder = null;
try { AttachmentBuilder = require("discord.js").AttachmentBuilder; } catch {}

function makeImageAttachment(name, svg, opts = {}) {
  if (!Resvg || !AttachmentBuilder) return null;
  const png = renderCachedPng(svg, opts);
  if (!png) return null;
  const safeName = String(name || "viz").replace(/[^a-z0-9_.-]/gi, "_");
  const fileName = safeName.endsWith(".png") ? safeName : `${safeName}.png`;
  const attachment = new AttachmentBuilder(png, { name: fileName });
  return { attachment, url: `attachment://${fileName}`, name: fileName };
}

function isAvailable() {
  return Resvg !== null;
}

function getLoadError() {
  return resvgLoadError;
}

module.exports = {
  isAvailable,
  getLoadError,
  renderCachedPng,
  renderSvgToPng,
  makeImageAttachment,
  botAvatarSvg,
  statusOrbRibbonSvg,
  scamConfidenceSvg,
  lockdownGridSvg,
  jarvisScorecardSvg,
  dailyRecapSvg,
  outageTimelineSvg,
  terminalPaneSvg,
  ACCENT,
  ACCENT_DEEP,
  VIZ_BG,
  VIZ_TEXT,
  VIZ_MUTED,
  VIZ_UP,
  VIZ_DOWN,
  VIZ_WARN,
  VIZ_INFO,
  VIZ_W
};
