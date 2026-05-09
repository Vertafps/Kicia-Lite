/**
 * Confidence meter — single-line gradient track with a glowing tick.
 * Used by KB no-match.
 *
 * @param {Object} data
 * @param {number} data.score   0..100
 * @param {string} data.label   short qualifier ("no-match", "weak", "strong")
 * @returns {Buffer} PNG buffer
 */
function renderConfidenceMeter({ score = 38, label = 'no-match' } = {}) {
  const { makeCanvas, toBuffer, text,
          EMBED_WIDTH, SURFACE, STATUS, TYPE } = require('./_theme');

  const W = EMBED_WIDTH, H = 78;
  const { canvas, ctx } = makeCanvas(W, H);

  const padX = 16, trackY = 40;
  const trackW = W - padX * 2;
  const tickX = padX + (Math.max(0, Math.min(100, score)) / 100) * trackW;

  const zone =
    score >= 70 ? STATUS.up.hex :
    score >= 45 ? STATUS.warn.hex :
                  STATUS.down.hex;

  // Header
  text(ctx, 'MATCH CONFIDENCE', padX, 16, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });
  text(ctx, `${score}% · ${label.toUpperCase()}`, W - padX, 16, {
    font: 'bold 11px ' + TYPE.mono, color: zone, align: 'right',
  });

  // Track base
  ctx.fillStyle = SURFACE.panelBg;
  ctx.fillRect(padX, trackY - 3, trackW, 6);

  // Track gradient
  const grad = ctx.createLinearGradient(padX, 0, padX + trackW, 0);
  grad.addColorStop(0,   STATUS.down.hex);
  grad.addColorStop(0.5, STATUS.warn.hex);
  grad.addColorStop(1,   STATUS.up.hex);
  ctx.fillStyle = grad;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(padX, trackY - 3, trackW, 6);
  ctx.globalAlpha = 1;

  // Zone labels
  const zones = [
    { from: 0,  to: 45,  label: 'NO-MATCH', color: STATUS.down.hex },
    { from: 45, to: 70,  label: 'WEAK',     color: STATUS.warn.hex },
    { from: 70, to: 100, label: 'STRONG',   color: STATUS.up.hex   },
  ];
  zones.forEach((z) => {
    const x = padX + ((z.from + z.to) / 2 / 100) * trackW;
    ctx.globalAlpha = 0.7;
    text(ctx, z.label, x, trackY + 18, {
      font: '8px ' + TYPE.mono, color: z.color, align: 'center', letterSpacing: 1.2,
    });
    ctx.globalAlpha = 1;
  });

  // Glowing tick
  const glow = ctx.createRadialGradient(tickX, trackY, 0, tickX, trackY, 14);
  glow.addColorStop(0, zone + 'B3');
  glow.addColorStop(1, zone + '00');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(tickX, trackY, 14, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = zone;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tickX, trackY - 9);
  ctx.lineTo(tickX, trackY + 9);
  ctx.stroke();
  ctx.lineCap = 'butt';

  ctx.fillStyle = zone;
  ctx.strokeStyle = '#0E0F12';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(tickX, trackY, 3.5, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();

  return toBuffer(canvas);
}

module.exports = { renderConfidenceMeter };
