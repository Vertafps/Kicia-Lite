/**
 * Animation primitives — APNG frame stitching shared by every animated canvas.
 *
 * Why APNG and not GIF: GIF caps at 256 indexed colors, which destroys the
 * orb glows + accent gradients we draw. APNG is full-color and Discord renders
 * it natively as a looping `.png` attachment.
 *
 * Frames are generated entirely in-memory via @napi-rs/canvas and encoded with
 * upng-js. Nothing touches disk — important on the storage-constrained VPS.
 */

const { createCanvas } = require('@napi-rs/canvas');

let UPNG = null;
function loadUPNG() {
  if (UPNG) return UPNG;
  UPNG = require('upng-js');
  return UPNG;
}

// Tuned for Discord render path:
//  - 24 fps × 1.2 s = ~29 frames keeps motion smooth without ballooning size.
//  - Scale 1 means native px (480px wide). Discord's animated PNG path serves
//    images at native, not retina, so 2× was wasted bytes and CPU.
//  - cnum=0 keeps full color (no palette quantization) — gradients survive.
const DEFAULT_FPS = 24;
const DEFAULT_DURATION_S = 1.2;
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
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOutQuint(t) {
  return 1 - Math.pow(1 - t, 5);
}

function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

function smoothstep(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Run drawFn across N frames. drawFn receives the canvas context, the frame's
 * normalized progress t ∈ [0, 1], and the loop index. Returns an APNG Buffer.
 *
 * @param {Object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} [opts.fps=30]
 * @param {number} [opts.durationSec=1.5]
 * @param {number} [opts.loop=0]   APNG loop count (0 = infinite)
 * @param {number} [opts.cnum=0]   APNG palette size (0 = full color)
 * @param {(ctx, t, frame) => void} drawFn
 */
function renderApng(drawFn, opts = {}) {
  const {
    width, height,
    fps = DEFAULT_FPS,
    durationSec = DEFAULT_DURATION_S,
    loop = 0,
    cnum = 0,
  } = opts;

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('renderApng requires numeric width and height');
  }

  const totalFrames = Math.max(2, Math.round(fps * durationSec));
  const frameDelayMs = Math.round(1000 / fps);
  const buffers = [];
  const delays = [];

  for (let i = 0; i < totalFrames; i++) {
    const t = i / (totalFrames - 1);
    const { canvas, ctx } = makeFrameCanvas(width, height);
    drawFn(ctx, t, i);
    // upng-js needs raw RGBA buffers, not ImageData objects. Extract as a
    // typed-array-backed ArrayBuffer the encoder can read directly.
    const raw = canvas.getContext('2d').getImageData(0, 0, width * RENDER_SCALE, height * RENDER_SCALE);
    buffers.push(raw.data.buffer);
    delays.push(frameDelayMs);
  }

  const upng = loadUPNG();
  const apng = upng.encode(buffers, width * RENDER_SCALE, height * RENDER_SCALE, cnum, delays);
  // upng returns an ArrayBuffer-like; wrap as Node Buffer for AttachmentBuilder.
  const buf = Buffer.from(apng);
  if (loop !== 0) {
    // Patch the acTL chunk's `num_plays` field if a non-default loop was requested.
    // upng writes 0 (infinite) by default; for our hero animations we always loop, so
    // this branch is rarely needed but kept for completeness.
    patchApngLoopCount(buf, loop);
  }
  return buf;
}

function patchApngLoopCount(buf, plays) {
  // PNG signature is 8 bytes; chunks are length(4) + type(4) + data + crc(4).
  let offset = 8;
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL') {
      buf.writeUInt32BE(plays >>> 0, offset + 8 + 4);
      return;
    }
    offset += 12 + length;
  }
}

module.exports = {
  renderApng,
  easeInOut,
  easeOutQuint,
  easeInOutSine,
  smoothstep,
};
