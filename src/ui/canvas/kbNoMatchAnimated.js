/**
 * Animated KB no-match card — APNG looping hero for the "let's get a human"
 * embed. Renders a radar sweep that arcs across a grid, lands on "no clear
 * match", and softly settles before looping back.
 *
 * Same data shape as renderConfidenceMeter (score, label) — drop-in for the
 * no-match embed.
 */

const { ACCENT, SURFACE, STATUS, TYPE } = require('../colors');
const { renderApng, easeOutQuint, smoothstep } = require('./_animation');

function renderKbNoMatchAnimated({
  score = 38, label = 'no-match',
} = {}) {
  const W = 480, H = 160;
  const cx = 100, cy = 86, radarR = 56;
  const zone =
    score >= 70 ? STATUS.up.hex :
    score >= 45 ? STATUS.warn.hex :
                  STATUS.down.hex;

  return renderApng((ctx, t) => {
    drawFrame(ctx, t);
  }, { width: W, height: H, durationSec: 1.5 });

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
    // Concentric range rings
    ctx.save();
    ctx.strokeStyle = SURFACE.panelBorder;
    ctx.lineWidth = 1;
    for (const r of [radarR, radarR * 0.66, radarR * 0.33]) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
    // Crosshair
    ctx.beginPath();
    ctx.moveTo(cx - radarR - 4, cy); ctx.lineTo(cx + radarR + 4, cy);
    ctx.moveTo(cx, cy - radarR - 4); ctx.lineTo(cx, cy + radarR + 4);
    ctx.stroke();
    ctx.restore();

    // Sweeping wedge (alpha fades along the trail)
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

    // Leading edge line
    ctx.save();
    ctx.strokeStyle = zone;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + radarR * Math.cos(sweepAngle), cy + radarR * Math.sin(sweepAngle));
    ctx.stroke();
    ctx.restore();

    // "No signal" pip — softly pulses at center after first sweep
    const pipAlpha = smoothstep(Math.min(1, (t - 0.35) / 0.4));
    if (pipAlpha > 0) {
      const pulse = (Math.sin(t * Math.PI * 4) + 1) / 2;
      ctx.save();
      ctx.globalAlpha = pipAlpha * (0.5 + pulse * 0.5);
      ctx.fillStyle = SURFACE.textMuted;
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  function drawCopy(ctx, t) {
    const headlineAlpha = smoothstep(Math.min(1, (t - 0.45) / 0.4));
    const subAlpha = smoothstep(Math.min(1, (t - 0.6) / 0.35));
    const tx = 192;

    ctx.save();
    ctx.globalAlpha = headlineAlpha;
    ctx.font = 'bold 18px ' + TYPE.sans;
    ctx.fillStyle = SURFACE.text;
    ctx.fillText('No clear KB match', tx, 64);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = subAlpha;
    ctx.font = '11px ' + TYPE.sans;
    ctx.fillStyle = SURFACE.textMuted;
    ctx.fillText('Routing this one to staff —', tx, 86);
    ctx.fillText('open a ticket and a moderator will pick it up.', tx, 102);
    ctx.restore();

    // CTA pill
    ctx.save();
    ctx.globalAlpha = subAlpha;
    const pillX = tx, pillY = 116, pillW = 130, pillH = 22;
    ctx.fillStyle = STATUS.warn.hex + '22';
    ctx.strokeStyle = STATUS.warn.hex + '88';
    ctx.lineWidth = 1;
    ctx.fillRect(pillX, pillY, pillW, pillH);
    ctx.strokeRect(pillX + 0.5, pillY + 0.5, pillW, pillH);
    ctx.font = 'bold 9.5px ' + TYPE.mono;
    ctx.fillStyle = STATUS.warn.hex;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.4px';
    ctx.fillText('OPEN A TICKET →', pillX + 10, pillY + 14);
    ctx.restore();
  }
}

module.exports = { renderKbNoMatchAnimated };
