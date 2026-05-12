/**
 * Animated KB no-match — looping GIF for the "let's get a human" embed.
 *
 * v2 — cleaner composition per design screenshot:
 *   - Header strip: "MATCH CONFIDENCE" left, "NO MATCH" red right (no score).
 *   - Small clean reticle on the left (2 rings + tiny crosshair ticks +
 *     center pip). No sweeping wedge, no leading edge line — those were
 *     loud and pulled attention away from the actual message.
 *   - Title + 3-line body text on the right.
 *   - Bottom: split labels "OPEN A TICKET BELOW" / "USE THE BUTTON ↓" with
 *     3 pulsing chevron arrows centred between them, pointing down at the
 *     real ticket button below the embed.
 *
 * Every frame is fully readable — no entrance, no fade-up.
 */

const { SURFACE, STATUS, TYPE } = require('../colors');
const { renderGif } = require('./_animation');

const W = 480;
const H = 160;

function renderKbNoMatchAnimated() {
  return renderGif((ctx, t) => drawFrame(ctx, t), { width: W, height: H });
}

function drawFrame(ctx, t) {
  drawGrid(ctx);
  drawHeader(ctx);
  drawReticle(ctx, t);
  drawCopy(ctx);
  drawFooter(ctx, t);
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
  ctx.font = '600 9px ' + TYPE.mono;
  ctx.fillStyle = SURFACE.textDim;
  ctx.textAlign = 'left';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
  ctx.fillText('MATCH CONFIDENCE', 16, 22);

  ctx.font = 'bold 9px ' + TYPE.mono;
  ctx.fillStyle = STATUS.down.hex;
  ctx.textAlign = 'right';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
  ctx.fillText('NO MATCH', W - 16, 22);
  ctx.restore();
}

function drawReticle(ctx, t) {
  // Small reticle: two concentric rings + 4 tiny crosshair ticks + center pip.
  // No wedge, no leading edge line — keep it quiet so the copy reads first.
  const cx = 80, cy = 82;
  const rOuter = 26;
  const rInner = 14;

  ctx.save();
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, rInner, 0, Math.PI * 2); ctx.stroke();

  // Tiny crosshair tick marks — short, only at compass points.
  ctx.strokeStyle = SURFACE.textDim;
  ctx.globalAlpha = 0.6;
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

  // Center pip — gently pulsing, dim red to signal the no-match state.
  const pulse = (Math.sin(t * Math.PI * 2) + 1) / 2;
  ctx.save();
  ctx.fillStyle = STATUS.down.hex;
  ctx.globalAlpha = 0.55 + pulse * 0.35;
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
  // Soft halo on the pip so it reads even at low alpha.
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 12);
  halo.addColorStop(0, STATUS.down.hex + Math.floor(40 + pulse * 60).toString(16).padStart(2, '0'));
  halo.addColorStop(1, STATUS.down.hex + '00');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawCopy(ctx) {
  const tx = 160;

  ctx.save();
  ctx.font = 'bold 17px ' + TYPE.sans;
  ctx.fillStyle = SURFACE.text;
  ctx.textAlign = 'left';
  ctx.fillText('No clear KB match', tx, 64);
  ctx.restore();

  ctx.save();
  ctx.font = '11px ' + TYPE.sans;
  ctx.fillStyle = SURFACE.textMuted;
  ctx.textAlign = 'left';
  ctx.fillText('A moderator needs to look at',  tx, 86);
  ctx.fillText('this one — open a ticket',      tx, 102);
  ctx.fillText('using the button below.',       tx, 118);
  ctx.restore();
}

function drawFooter(ctx, t) {
  // Bottom row: labels yellow on left+right, chevrons pulsing in the centre
  // gutter pointing down at the actual ticket button below the embed.
  const baseY = H - 18;
  const bob = Math.sin(t * Math.PI * 2) * 0.6;

  ctx.save();
  ctx.font = 'bold 9.5px ' + TYPE.mono;
  ctx.fillStyle = STATUS.warn.hex;
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.4px';

  ctx.textAlign = 'left';
  ctx.fillText('OPEN A TICKET BELOW', 16, baseY + bob);

  ctx.textAlign = 'right';
  ctx.fillText('USE THE BUTTON ↓', W - 16, baseY + bob);
  ctx.restore();

  // Three pulsing chevron arrows pointing down, centred between the labels.
  const cxFooter = W / 2;
  const chevronTopY = baseY - 18;
  ctx.save();
  ctx.strokeStyle = STATUS.warn.hex;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 3; i++) {
    const phase = (t * Math.PI * 2) - i * 0.6;
    const alpha = 0.45 + (Math.sin(phase) + 1) / 2 * 0.45;
    ctx.globalAlpha = alpha;
    const yTop = chevronTopY + i * 5;
    ctx.beginPath();
    ctx.moveTo(cxFooter - 8, yTop);
    ctx.lineTo(cxFooter,     yTop + 5);
    ctx.lineTo(cxFooter + 8, yTop);
    ctx.stroke();
  }
  ctx.restore();
}

module.exports = { renderKbNoMatchAnimated };
