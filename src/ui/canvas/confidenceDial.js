/**
 * Scam confidence dial + signal breakdown bars.
 * Half-circle dial colored by zone (clean/borderline/confirmed).
 *
 * @param {Object} data
 * @param {number} data.score                  0..100
 * @param {Array<{name:string,weight:number}>} data.signals
 * @returns {Buffer} PNG buffer
 */
function renderConfidenceDial({ score = 87, signals } = {}) {
  const { makeCanvas, toBuffer, gridBackground, text,
          EMBED_WIDTH, SURFACE, STATUS, TYPE } = require('./_theme');

  const sig = signals && signals.length ? signals : [
    { name: 'Bayes classifier',     weight: 92 },
    { name: 'Keyword pattern',      weight: 88 },
    { name: 'Contact-DM steering',  weight: 81 },
    { name: 'Embedding similarity', weight: 74 },
    { name: 'Gemini review',        weight: 95 },
  ];

  const W = EMBED_WIDTH, H = 200;
  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  text(ctx, 'SCAM CONFIDENCE', 16, 16, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });

  // ── Half-circle dial ───────────────────────────────────────────────────
  const cx = 86, cy = 110, R = 64;
  // Track (full half-circle, dim)
  ctx.strokeStyle = SURFACE.panelBg;
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI, 0, false);
  ctx.stroke();

  // Filled portion — gradient green→yellow→red as score climbs
  const grad = ctx.createLinearGradient(cx - R, 0, cx + R, 0);
  grad.addColorStop(0,    STATUS.up.hex);
  grad.addColorStop(0.6,  STATUS.warn.hex);
  grad.addColorStop(1,    STATUS.down.hex);
  ctx.strokeStyle = grad;
  ctx.beginPath();
  const start = Math.PI;
  const end = Math.PI + (Math.max(0, Math.min(100, score)) / 100) * Math.PI;
  ctx.arc(cx, cy, R, start, end, false);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // Tick labels
  for (const t of [0, 25, 50, 75, 100]) {
    const a = Math.PI + (t / 100) * Math.PI;
    const x = cx + (R + 12) * Math.cos(a);
    const y = cy + (R + 12) * Math.sin(a);
    text(ctx, String(t), x, y + 3, {
      font: '8px ' + TYPE.mono, color: SURFACE.textDim, align: 'center',
    });
  }

  const tone =
    score >= 85 ? STATUS.down.hex :
    score >= 65 ? STATUS.warn.hex :
                  STATUS.up.hex;
  const label =
    score >= 85 ? 'CONFIRMED' :
    score >= 65 ? 'BORDERLINE' :
                  'CLEAN';

  // Center number + label
  text(ctx, String(score), cx, cy - 6, {
    font: 'bold 32px ' + TYPE.sans, color: tone, align: 'center',
  });
  text(ctx, label, cx, cy + 10, {
    font: '9px ' + TYPE.mono, color: tone, align: 'center', letterSpacing: 1.5,
  });

  // ── Signal bars (right side) ───────────────────────────────────────────
  sig.forEach((s, i) => {
    const y = 38 + i * 28;
    text(ctx, s.name, 196, y - 2, {
      font: '9.5px ' + TYPE.mono, color: SURFACE.text,
    });
    text(ctx, `${s.weight}%`, W - 16, y - 2, {
      font: '9px ' + TYPE.mono, color: SURFACE.textDim, align: 'right',
    });
    // Track
    ctx.fillStyle = SURFACE.panelBg;
    ctx.fillRect(196, y + 4, W - 16 - 196, 6);
    // Fill — info color (data-viz, not accent)
    ctx.fillStyle = STATUS.info.hex;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(196, y + 4, (W - 16 - 196) * (s.weight / 100), 6);
    ctx.globalAlpha = 1;
  });

  return toBuffer(canvas);
}

module.exports = { renderConfidenceDial };
