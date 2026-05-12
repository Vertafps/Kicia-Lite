/**
 * Animated status orb — looping GIF for $status.
 *
 * v3 design (matches `Design By Claude/Design/animations.jsx` and the
 * Status up/down/unaware screenshots):
 *
 *   - Big orb on the left (R=38, centred at 78,90) with state-tinted halo.
 *   - "CURRENT STATE" label + huge state word (44px) + subtitle on the right.
 *   - Abstract 36-dot pulse strip below — no fake metrics, no time markers,
 *     no "uptime ribbon". Per-state animation:
 *       UP       — sonar rings expand outward; pulse-dot running light L→R
 *                  with a glowing head.
 *       DOWN     — bot disc darkened with a thick X cross-out; pulse-dot
 *                  strip is flat-red with the occasional twitch.
 *       UNAWARE  — slow rotating dashed ring around the orb; pulse-dot
 *                  strip wanders (random dots fade in and out).
 *
 * Every frame is fully readable — no entrance, no fade-up. First frame
 * shows the full layout.
 */

const { SURFACE, STATUS, TYPE } = require('../colors');
const { renderGif } = require('./_animation');

const W = 480;
const H = 200;

function renderStatusOrbRibbonAnimated({ status = 'UP' } = {}) {
  const tone = pickTone(status);
  return renderGif((ctx, t) => drawFrame(ctx, t, status, tone), { width: W, height: H });
}

function pickTone(status) {
  if (status === 'DOWN') return STATUS.down.hex;
  if (status === 'UNAWARE') return STATUS.warn.hex;
  return STATUS.up.hex;
}

function drawFrame(ctx, t, status, col) {
  drawGrid(ctx);
  drawOrb(ctx, t, status, col);
  drawStateBlock(ctx, status, col);
  drawPulseStrip(ctx, t, status, col);
}

function drawGrid(ctx) {
  ctx.save();
  ctx.strokeStyle = SURFACE.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 20) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
  for (let y = 0; y <= H; y += 20) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
  ctx.stroke();
  ctx.restore();
}

function drawOrb(ctx, t, status, col) {
  const cx = 78, cy = 90, R = 38;

  // Halo gradient — pulse amplitude varies per state.
  const haloPulse = (Math.sin(t * Math.PI * 2) + 1) / 2;
  const haloR = 64 + haloPulse * (status === 'UP' ? 16 : status === 'UNAWARE' ? 8 : 4);
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
  halo.addColorStop(0, col + (status === 'DOWN' ? '30' : '70'));
  halo.addColorStop(1, col + '00');
  ctx.save();
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Disc — slightly dim on DOWN, with occasional flicker.
  const flicker = status === 'DOWN' ? (Math.random() < 0.04 ? 0.6 : 1) : 1;
  ctx.save();
  ctx.globalAlpha = flicker;
  const ofill = ctx.createRadialGradient(cx - 10, cy - 12, 0, cx, cy, R);
  ofill.addColorStop(0, '#FFFFFF');
  ofill.addColorStop(0.5, col);
  ofill.addColorStop(1, col + (status === 'DOWN' ? '22' : '55'));
  ctx.fillStyle = ofill;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // Per-state overlay.
  if (status === 'UP') {
    // Two staggered sonar rings expanding outward.
    for (let i = 0; i < 2; i++) {
      const p = ((t + i / 2) % 1);
      const r = R + p * 28;
      ctx.save();
      ctx.strokeStyle = col;
      ctx.globalAlpha = Math.max(0, 1 - p) * 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  } else if (status === 'DOWN') {
    // Thick black X cross-out at 55% of orb radius.
    ctx.save();
    ctx.strokeStyle = '#0E0F12';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    const k = R * 0.55;
    ctx.beginPath();
    ctx.moveTo(cx - k, cy - k); ctx.lineTo(cx + k, cy + k);
    ctx.moveTo(cx + k, cy - k); ctx.lineTo(cx - k, cy + k);
    ctx.stroke();
    ctx.restore();
  } else {
    // UNAWARE: slow rotating dashed ring outside the disc.
    ctx.save();
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = -t * 40;
    ctx.beginPath(); ctx.arc(cx, cy, R + 10, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

function drawStateBlock(ctx, status, col) {
  const sx = 170;

  ctx.save();
  ctx.font = '600 9.5px ' + TYPE.mono;
  ctx.fillStyle = SURFACE.textDim;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.8px';
  ctx.fillText('CURRENT STATE', sx, 50);
  ctx.restore();

  ctx.save();
  ctx.font = 'bold 44px ' + TYPE.sans;
  ctx.fillStyle = col;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.5px';
  ctx.fillText(status, sx, 96);
  ctx.restore();

  const subtitle = status === 'UP'      ? 'all systems nominal'
                 : status === 'DOWN'    ? 'service is offline'
                 :                         'state unconfirmed';
  ctx.save();
  ctx.font = '12px ' + TYPE.mono;
  ctx.fillStyle = SURFACE.textMuted;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0.4px';
  ctx.fillText(subtitle, sx, 120);
  ctx.restore();
}

function drawPulseStrip(ctx, t, status, col) {
  const px = 16, py = 156, pw = W - 32, ph = 28;

  // Strip background — slightly inset dark panel with border.
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.globalAlpha = 0.4;
  roundRect(ctx, px, py, pw, ph, 4); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  roundRect(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, 4); ctx.stroke();
  ctx.restore();

  const N = 36;
  const gap = (pw - 24) / (N - 1);
  for (let i = 0; i < N; i++) {
    const dx = px + 12 + i * gap;
    const dy = py + ph / 2;
    let a, rad;

    if (status === 'UP') {
      // Running light — bright at position p, fades behind it.
      const p = (t * N) % N;
      const d = Math.abs(i - p);
      const dWrap = Math.min(d, N - d);
      a = Math.max(0.18, 1 - dWrap / 6);
      rad = 1.6 + (dWrap < 1 ? 1.4 : dWrap < 3 ? 0.6 : 0);
    } else if (status === 'DOWN') {
      // Mostly flat, very occasional twitch on a deterministic seed.
      const twitch = ((Math.sin(i * 12.9898 + Math.floor(t * 4) * 78.233) * 43758.5453) % 1 + 1) % 1;
      a = twitch > 0.95 ? 0.7 : 0.22;
      rad = 1.6 + (twitch > 0.95 ? 0.6 : 0);
    } else {
      // UNAWARE: scattered breathing — random phase per dot, never settles.
      const seed = (Math.sin(i * 1.7) + 1) / 2;
      const phase = (t + seed) % 1;
      a = 0.2 + 0.55 * (Math.sin(phase * Math.PI * 2 + seed * 4) * 0.5 + 0.5);
      rad = 1.6;
    }

    ctx.save();
    ctx.fillStyle = col;
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.arc(dx, dy, rad, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Bloom only on the bright UP head — keeps file size reasonable.
    if (status === 'UP' && rad > 2) {
      drawBloom(ctx, dx, dy, 8, col, 0.5);
    }
  }
}

function drawBloom(ctx, x, y, radius, color, intensity = 0.6) {
  const a = Math.max(0, Math.min(1, intensity));
  const innerHex = Math.floor(a * 240).toString(16).padStart(2, '0');
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
  grad.addColorStop(0, color + innerHex);
  grad.addColorStop(1, color + '00');
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
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

module.exports = { renderStatusOrbRibbonAnimated };
