/**
 * Animated KB no-match — looping GIF for the "let's get a human" embed.
 *
 * Design rule: full content always visible. Animation = a radar sweep arc
 * orbiting a "no signal" pip. The headline + CTA pill never fade.
 */

const { ACCENT, SURFACE, STATUS, TYPE } = require('../colors');
const { renderGif, easeInOutSine } = require('./_animation');

function renderKbNoMatchAnimated({
  score = 38, label = 'no-match',
} = {}) {
  const W = 480, H = 160;
  const cx = 100, cy = 86, radarR = 56;
  const zone =
    score >= 70 ? STATUS.up.hex :
    score >= 45 ? STATUS.warn.hex :
                  STATUS.down.hex;

  return renderGif((ctx, t) => drawFrame(ctx, t), { width: W, height: H });

  function drawFrame(ctx, t) {
    drawGrid(ctx);
    drawHeader(ctx);
    drawRadar(ctx, t);
    drawCopy(ctx, t);
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
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
    ctx.fillText('MATCH CONFIDENCE', 16, 20);

    ctx.font = 'bold 11px ' + TYPE.mono;
    ctx.fillStyle = zone;
    ctx.textAlign = 'right';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillText(`${score}% · ${String(label).toUpperCase()}`, W - 16, 20);
    ctx.restore();
  }

  function drawRadar(ctx, t) {
    // Concentric range rings + crosshair — static, always visible.
    ctx.save();
    ctx.strokeStyle = SURFACE.panelBorder;
    ctx.lineWidth = 1;
    for (const r of [radarR, radarR * 0.66, radarR * 0.33]) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - radarR - 4, cy); ctx.lineTo(cx + radarR + 4, cy);
    ctx.moveTo(cx, cy - radarR - 4); ctx.lineTo(cx, cy + radarR + 4);
    ctx.stroke();
    ctx.restore();

    // Sweeping wedge.
    const sweepAngle = t * Math.PI * 2 - Math.PI / 2;
    const wedgeSpan = Math.PI / 2.2;
    ctx.save();
    const sweepGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radarR);
    sweepGrad.addColorStop(0, zone + '60');
    sweepGrad.addColorStop(1, zone + '00');
    ctx.fillStyle = sweepGrad;
    ctx.globalCompositeOperation = 'screen';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radarR, sweepAngle - wedgeSpan, sweepAngle);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Leading edge line.
    ctx.save();
    ctx.strokeStyle = zone;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + radarR * Math.cos(sweepAngle), cy + radarR * Math.sin(sweepAngle));
    ctx.stroke();
    ctx.restore();

    // Center "no signal" pip — softly pulses, always visible.
    const pulse = (Math.sin(t * Math.PI * 4) + 1) / 2;
    ctx.save();
    ctx.globalAlpha = 0.55 + pulse * 0.4;
    ctx.fillStyle = SURFACE.textMuted;
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawCopy(ctx, t) {
    const tx = 192;

    ctx.save();
    ctx.font = 'bold 18px ' + TYPE.sans;
    ctx.fillStyle = SURFACE.text;
    ctx.fillText('No clear KB match', tx, 64);
    ctx.restore();

    ctx.save();
    ctx.font = '11px ' + TYPE.sans;
    ctx.fillStyle = SURFACE.textMuted;
    ctx.fillText('A moderator needs to look', tx, 86);
    ctx.fillText('at this one — open a ticket', tx, 100);
    ctx.fillText('using the button below.', tx, 114);
    ctx.restore();

    // Footer: split labels with chevron arrows pointing down (per design spec).
    // Three staggered chevrons in the gutter between the two label halves give
    // a clear "look down at the ticket button" cue without an extra pill on
    // the embed image.
    const footerY = H - 18;
    drawFooterChevrons(ctx, t, footerY - 18);
    drawFooterLabels(ctx, t, footerY);
  }

  function drawFooterChevrons(ctx, t, baseY) {
    const cxFooter = W / 2;
    ctx.save();
    ctx.strokeStyle = STATUS.warn.hex;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const phase = (t * Math.PI * 2) - i * 0.6;
      const alpha = 0.35 + (Math.sin(phase) + 1) / 2 * 0.55;
      ctx.globalAlpha = alpha;
      const yOff = baseY + i * 5;
      ctx.beginPath();
      ctx.moveTo(cxFooter - 7, yOff);
      ctx.lineTo(cxFooter,     yOff + 5);
      ctx.lineTo(cxFooter + 7, yOff);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFooterLabels(ctx, t, baseY) {
    const bob = Math.sin(t * Math.PI * 2) * 0.6;

    ctx.save();
    ctx.font = 'bold 9.5px ' + TYPE.mono;
    ctx.fillStyle = STATUS.warn.hex;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.4px';
    ctx.textAlign = 'left';
    ctx.fillText('OPEN A TICKET BELOW', 16, baseY + bob);

    ctx.textAlign = 'right';
    ctx.fillText('USE THE BUTTON ↓', W - 16, baseY + bob);
    ctx.restore();
  }
}

module.exports = { renderKbNoMatchAnimated };
