/**
 * Animated KB no-match — looping GIF for the "let's get a human" embed.
 *
 * v3 — minimal composition. Every duplicate CTA was clutter; the real
 * ticket button sits below the embed already, so the canvas just needs
 * to say "we looked, no match, talk to staff" and get out of the way.
 *
 * Layout:
 *   - Top-right: small red "NO MATCH" tag (no "MATCH CONFIDENCE"
 *     header — the reticle + tag carry the signal).
 *   - Left: small quiet reticle (two rings, 4 compass ticks, pulsing
 *     red center pip with halo).
 *   - Right: title + a single body line that points at the button.
 *
 * No footer labels, no chevron stack — the embed's actual ticket button
 * lives right under the image.
 */

const { SURFACE, STATUS, TYPE } = require('../colors');
const { renderGif } = require('./_animation');

const W = 480;
const H = 132;

function renderKbNoMatchAnimated() {
  return renderGif((ctx, t) => drawFrame(ctx, t), { width: W, height: H });
}

function drawFrame(ctx, t) {
  drawGrid(ctx);
  drawHeader(ctx);
  drawReticle(ctx, t);
  drawCopy(ctx);
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

function drawHeader(ctx) {
  ctx.save();
  ctx.font = 'bold 9px ' + TYPE.mono;
  ctx.fillStyle = STATUS.down.hex;
  ctx.textAlign = 'right';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
  ctx.fillText('NO MATCH', W - 16, 22);
  ctx.restore();
}

function drawReticle(ctx, t) {
  const cx = 70, cy = 72;
  const rOuter = 26;
  const rInner = 14;

  ctx.save();
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, rInner, 0, Math.PI * 2); ctx.stroke();

  // Tiny crosshair ticks at the 4 compass points — short, dim.
  ctx.strokeStyle = SURFACE.textDim;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  const tickLen = 4;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.beginPath();
    ctx.moveTo(cx + dx * (rOuter + 2), cy + dy * (rOuter + 2));
    ctx.lineTo(cx + dx * (rOuter + 2 + tickLen), cy + dy * (rOuter + 2 + tickLen));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // Pulsing red center pip + soft halo so the reticle reads as "no signal".
  const pulse = (Math.sin(t * Math.PI * 2) + 1) / 2;
  ctx.save();
  ctx.fillStyle = STATUS.down.hex;
  ctx.globalAlpha = 0.6 + pulse * 0.3;
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 12);
  halo.addColorStop(0, STATUS.down.hex + Math.floor(40 + pulse * 60).toString(16).padStart(2, '0'));
  halo.addColorStop(1, STATUS.down.hex + '00');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawCopy(ctx) {
  const tx = 144;

  ctx.save();
  ctx.font = 'bold 18px ' + TYPE.sans;
  ctx.fillStyle = SURFACE.text;
  ctx.textAlign = 'left';
  ctx.fillText('No clear KB match', tx, 62);
  ctx.restore();

  ctx.save();
  ctx.font = '12px ' + TYPE.sans;
  ctx.fillStyle = SURFACE.textMuted;
  ctx.textAlign = 'left';
  ctx.fillText('Open a ticket below — staff will', tx, 86);
  ctx.fillText('pick this one up.',                 tx, 104);
  ctx.restore();
}

module.exports = { renderKbNoMatchAnimated };
