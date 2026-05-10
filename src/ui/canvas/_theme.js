/**
 * Shared canvas theme + helpers.
 *
 * ─── Canvas library ──────────────────────────────────────────────────────────
 * This bundle uses the `canvas` package (Cairo-backed). If `canvas` fails to
 * install on your host (missing libvips/cairo headers, Apple Silicon, etc.),
 * swap to @napi-rs/canvas which is a drop-in replacement. Two lines change:
 *
 *   - const { createCanvas, registerFont } = require('canvas');
 *   + const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
 *   + const registerFont = (path, opts) => GlobalFonts.registerFromPath(path, opts.family);
 *
 * Everything else is identical — fillStyle, strokeStyle, gradients, paths.
 *
 * ─── Fonts ───────────────────────────────────────────────────────────────────
 * If you want pixel-identical type to the mockup, drop the Geist .ttf files
 * into src/ui/canvas/fonts/ and call registerFonts() once at boot. Without it
 * canvas falls back to whatever sans/mono the host has — the layouts still
 * read fine, just slightly different metrics.
 */

const path = require('path');
const fs = require('fs');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const registerFont = (file, opts) => GlobalFonts.registerFromPath(file, opts.family);

const { SURFACE, STATUS, ACCENT, TYPE } = require('../colors');

// ── Fonts ────────────────────────────────────────────────────────────────────

let fontsRegistered = false;
function registerFonts() {
  if (fontsRegistered) return;
  fontsRegistered = true;
  const fontsDir = path.join(__dirname, 'fonts');
  if (!fs.existsSync(fontsDir)) return; // silent — fall back to system fonts
  const tryRegister = (file, family, weight = 'normal') => {
    const full = path.join(fontsDir, file);
    if (fs.existsSync(full)) {
      try { registerFont(full, { family, weight }); } catch (_) { /* swallow */ }
    }
  };
  tryRegister('Geist-Regular.ttf',     'Geist', 'normal');
  tryRegister('Geist-Medium.ttf',      'Geist', '500');
  tryRegister('Geist-SemiBold.ttf',    'Geist', '600');
  tryRegister('Geist-Bold.ttf',        'Geist', 'bold');
  tryRegister('GeistMono-Regular.ttf', 'Geist Mono', 'normal');
  tryRegister('GeistMono-Medium.ttf',  'Geist Mono', '500');
  tryRegister('GeistMono-SemiBold.ttf','Geist Mono', '600');
  tryRegister('GeistMono-Bold.ttf',    'Geist Mono', 'bold');
}

// ── Canvas factory + theme ───────────────────────────────────────────────────

/**
 * Make a canvas pre-painted with the embed background so it blends seamlessly
 * into the Discord embed surface. Discord renders embed images at native px;
 * we draw at 2× and let Discord scale down for crisp results on retina.
 */
function makeCanvas(width, height, scale = 2) {
  registerFonts();
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#0E0F12'; // slightly darker than embed bg → graphs feel inset
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx, width, height };
}

function toBuffer(canvas) {
  // node-canvas + napi-rs both expose toBuffer('image/png') → Buffer.
  return canvas.toBuffer('image/png');
}

// ── Common drawing helpers ───────────────────────────────────────────────────

function gridBackground(ctx, w, h, step = 20) {
  ctx.save();
  ctx.strokeStyle = SURFACE.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += step) {
    ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += step) {
    ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y,     x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x,     y + h, rr);
  ctx.arcTo(x,     y + h, x,     y,     rr);
  ctx.arcTo(x,     y,     x + w, y,     rr);
  ctx.closePath();
}

/** Simple text helper that respects font + alignment. */
function text(ctx, str, x, y, opts = {}) {
  const {
    font = '12px ' + TYPE.sans,
    color = SURFACE.text,
    align = 'left',
    baseline = 'alphabetic',
    letterSpacing = 0, // node-canvas supports ctx.letterSpacing in newer versions
  } = opts;
  ctx.save();
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${letterSpacing}px`;
  ctx.fillText(str, x, y);
  ctx.restore();
}

/** Section header strip: small uppercase mono label + optional right-side value. */
function sectionLabel(ctx, x, y, label, right) {
  text(ctx, label, x, y, {
    font: '600 9px ' + TYPE.mono,
    color: SURFACE.textDim,
    letterSpacing: 1.5,
  });
  if (right) {
    text(ctx, right, x + (ctx.canvas.width / 2 - x - 8), y, {
      font: '600 11px ' + TYPE.mono,
      color: ACCENT.hex,
      align: 'right',
      letterSpacing: 0.6,
    });
  }
}

// ── Polish helpers (gradients, bloom, hairlines) ─────────────────────────────

/**
 * Linear gradient fill across a region. `stops` is `[[offset, color], ...]`.
 */
function linearGradientFill(ctx, x0, y0, x1, y1, stops) {
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  return grad;
}

/**
 * Radial gradient fill. `stops` is `[[offset, color], ...]`.
 */
function radialGradientFill(ctx, x0, y0, r0, x1, y1, r1, stops) {
  const grad = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  return grad;
}

/**
 * Soft glow at (x, y). Composites a radial gradient with `screen` blend mode
 * so it lifts the underlying canvas instead of overwriting. `intensity` is
 * 0..1 controlling the inner alpha.
 */
function bloom(ctx, x, y, radius, color, intensity = 0.6) {
  const a = Math.max(0, Math.min(1, intensity));
  const innerHex = Math.floor(a * 240).toString(16).padStart(2, '0');
  const grad = radialGradientFill(ctx, x, y, 0, x, y, radius, [
    [0,   color + innerHex],
    [1,   color + '00'],
  ]);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/**
 * Gradient-fading hairline — fades to transparent at both ends, classier than
 * a flat 1 px line. Use for dividers between sections.
 */
function hairline(ctx, x1, y1, x2, y2, color = SURFACE.panelBorder) {
  ctx.save();
  const grad = linearGradientFill(ctx, x1, y1, x2, y2, [
    [0,    color + '00'],
    [0.2,  color + 'CC'],
    [0.8,  color + 'CC'],
    [1,    color + '00'],
  ]);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.restore();
}

// ── Embed image dimensions ───────────────────────────────────────────────────
// Discord embeds clamp the inline image to ~488px wide. Drawing slightly
// narrower (480) gives a 4px breathing margin against the embed border.

const EMBED_WIDTH = 480;

module.exports = {
  registerFonts,
  makeCanvas,
  toBuffer,
  gridBackground,
  roundRect,
  text,
  sectionLabel,
  bloom,
  linearGradientFill,
  radialGradientFill,
  hairline,
  EMBED_WIDTH,
  // Re-export tokens for convenience
  SURFACE, STATUS, ACCENT, TYPE,
};
