/**
 * Animation primitives — GIF frame stitching shared by every animated canvas.
 *
 * Why GIF (not APNG): Discord's embed image renderer plays animated GIFs
 * reliably on every client (desktop, mobile, web) but only shows the first
 * frame of APNG on most of them. We pay a 256-color palette cost in exchange
 * for guaranteed playback. Our UI is dark with limited palette, so the
 * quantization loss is mostly invisible.
 *
 * Frames are generated entirely in-memory via @napi-rs/canvas and encoded with
 * gifenc. Nothing touches disk — important on the storage-tight VPS.
 *
 * Animation design rule (CRITICAL): every animated builder must be a
 * **continuous, always-readable loop**. The first frame must show all the
 * content the user needs — no fade-in entrance, no slide-from-offscreen. If
 * Discord ever falls back to the first frame (or a slow client renders only
 * the first frame), the embed must still be readable.
 */

const { createCanvas } = require('@napi-rs/canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

// Tuned for Discord render path:
//   24 fps × 1.5 s = 36 frames keeps motion smooth without ballooning size.
//   Native scale (1×) — Discord serves animated images at native, not retina.
const DEFAULT_FPS = 24;
const DEFAULT_DURATION_S = 1.5;
const RENDER_SCALE = 1;

function makeFrameCanvas(width, height, scale = RENDER_SCALE) {
  const canvas = createCanvas(width * scale, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#0E0F12';
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx, width, height };
}

function easeInOut(t) {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
}

function easeOutQuint(t) {
  const c = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - c, 5);
}

function easeInOutSine(t) {
  return -(Math.cos(Math.PI * Math.max(0, Math.min(1, t))) - 1) / 2;
}

function smoothstep(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Run drawFn across N frames. drawFn receives the canvas context, the frame's
 * normalized progress t ∈ [0, 1), and the frame index. Returns a GIF Buffer.
 *
 * @param {Object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} [opts.fps=24]
 * @param {number} [opts.durationSec=1.5]
 * @param {(ctx, t, frame) => void} drawFn
 */
function renderGif(drawFn, opts = {}) {
  const {
    width, height,
    fps = DEFAULT_FPS,
    durationSec = DEFAULT_DURATION_S,
  } = opts;

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('renderGif requires numeric width and height');
  }

  const totalFrames = Math.max(2, Math.round(fps * durationSec));
  const frameDelayMs = Math.round(1000 / fps);
  const W = Math.round(width * RENDER_SCALE);
  const H = Math.round(height * RENDER_SCALE);

  const enc = GIFEncoder();

  // Compute a single global palette from a settled frame (t = 0.5) so colors
  // stay stable across the loop. Per-frame palettes give marginally better
  // color but produce much larger files; for a UI with limited color range
  // a single palette is the better tradeoff.
  const settled = makeFrameCanvas(width, height);
  drawFn(settled.ctx, 0.5, Math.floor(totalFrames / 2));
  const settledRgba = new Uint8Array(
    settled.ctx.getImageData(0, 0, W, H).data.buffer
  );
  const palette = quantize(settledRgba, 256, { format: 'rgb565' });

  for (let i = 0; i < totalFrames; i++) {
    const t = i / totalFrames; // [0, 1)
    const { ctx } = makeFrameCanvas(width, height);
    drawFn(ctx, t, i);
    const rgba = new Uint8Array(ctx.getImageData(0, 0, W, H).data.buffer);
    const indexed = applyPalette(rgba, palette, 'rgb565');
    enc.writeFrame(indexed, W, H, { palette, delay: frameDelayMs });
  }

  enc.finish();
  return Buffer.from(enc.bytes());
}

module.exports = {
  renderGif,
  easeInOut,
  easeOutQuint,
  easeInOutSine,
  smoothstep,
};
