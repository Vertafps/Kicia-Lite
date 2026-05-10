/**
 * Scam confidence dial + signal breakdown bars.
 *
 * Layout matches the design:
 *   - Half-circle dial on the LEFT (≈210px wide).
 *   - Section header "SCAM CONFIDENCE" at the top, "VERDICT · {label}" right-aligned.
 *   - Up to 5 horizontal breakdown bars on the RIGHT, each labelled with the
 *     signal name and its weight.
 *
 * @param {Object} data
 * @param {number} data.score                      0..100
 * @param {Array<{name:string,weight:number,kind?:string}>} data.signals
 * @returns {Buffer} PNG buffer
 */
function renderConfidenceDial({ score = 87, signals } = {}) {
  const { makeCanvas, toBuffer, gridBackground, roundRect, text,
          EMBED_WIDTH, SURFACE, STATUS, ACCENT, TYPE } = require('./_theme');

  const sig = (signals && signals.length ? signals : [
    { name: 'Bayes classifier',     weight: 92 },
    { name: 'Keyword pattern',      weight: 88 },
    { name: 'Contact-DM steering',  weight: 81 },
    { name: 'Embedding similarity', weight: 74 },
    { name: 'Gemini review',        weight: 95 },
  ]).slice(0, 5);

  const W = EMBED_WIDTH, H = 220;
  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  const tone =
    score >= 85 ? STATUS.down :
    score >= 65 ? STATUS.warn :
                  STATUS.up;
  const verdictLabel =
    score >= 85 ? 'CONFIRMED' :
    score >= 65 ? 'BORDERLINE' :
                  'CLEAN';

  // ── Header strip ──────────────────────────────────────────────────────
  text(ctx, 'SCAM CONFIDENCE', 16, 18, {
    font: '600 9.5px ' + TYPE.mono, color: SURFACE.textMuted, letterSpacing: 1.6,
  });
  text(ctx, `VERDICT · ${verdictLabel}`, W - 16, 18, {
    font: 'bold 9.5px ' + TYPE.mono, color: tone.hex, align: 'right', letterSpacing: 1.4,
  });

  // ── Half-circle dial ──────────────────────────────────────────────────
  const dialAreaX = 16;
  const dialAreaW = 200;
  const cx = dialAreaX + dialAreaW / 2;
  const cy = 138;
  const R = 70;
  const gaugeWidth = 16;

  // Track (full half-circle, dim grey)
  ctx.strokeStyle = SURFACE.panelBg;
  ctx.lineWidth = gaugeWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, R, Math.PI, 0, false);
  ctx.stroke();

  // Filled arc — gradient green→yellow→red
  const grad = ctx.createLinearGradient(cx - R, 0, cx + R, 0);
  grad.addColorStop(0,    STATUS.up.hex);
  grad.addColorStop(0.55, STATUS.warn.hex);
  grad.addColorStop(1,    STATUS.down.hex);
  ctx.strokeStyle = grad;
  ctx.beginPath();
  const start = Math.PI;
  const end = Math.PI + (Math.max(0, Math.min(100, score)) / 100) * Math.PI;
  ctx.arc(cx, cy, R, start, end, false);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // Tick marks at 0/25/50/75/100 — small dot + label
  for (const t of [0, 25, 50, 75, 100]) {
    const a = Math.PI + (t / 100) * Math.PI;
    const tx = cx + (R + 16) * Math.cos(a);
    const ty = cy + (R + 16) * Math.sin(a);
    ctx.fillStyle = SURFACE.textDim;
    ctx.beginPath();
    ctx.arc(cx + (R - gaugeWidth / 2 - 2) * Math.cos(a), cy + (R - gaugeWidth / 2 - 2) * Math.sin(a), 1.5, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, String(t), tx, ty + 3, {
      font: '8px ' + TYPE.mono, color: SURFACE.textMuted, align: 'center',
    });
  }

  // Big centred score + verdict label
  text(ctx, String(Math.round(score)), cx, cy - 4, {
    font: 'bold 38px ' + TYPE.sans, color: tone.hex, align: 'center',
  });
  text(ctx, verdictLabel, cx, cy + 14, {
    font: '600 9.5px ' + TYPE.mono, color: tone.hex, align: 'center', letterSpacing: 1.8,
  });

  // ── Breakdown bars (right column) ─────────────────────────────────────
  const barsX = 230;
  const barsRight = W - 16;
  const barsTop = 38;
  const rowH = 30;
  const labelGap = 6;
  const barH = 7;

  sig.forEach((s, i) => {
    const y = barsTop + i * rowH;
    const weight = Math.max(0, Math.min(100, Number(s.weight) || 0));
    const labelStr = String(s.name || 'signal');
    const fitted = labelStr.length > 28 ? labelStr.slice(0, 27) + '…' : labelStr;

    // Label
    text(ctx, fitted, barsX, y, {
      font: '500 10px ' + TYPE.mono, color: SURFACE.text,
    });
    // Weight (right-aligned)
    text(ctx, `${Math.round(weight)}%`, barsRight, y, {
      font: 'bold 10px ' + TYPE.mono, color: SURFACE.text, align: 'right',
    });

    // Track
    const trackX = barsX;
    const trackW = barsRight - barsX;
    const trackY = y + labelGap;
    ctx.fillStyle = SURFACE.panelBg;
    roundRect(ctx, trackX, trackY, trackW, barH, barH / 2); ctx.fill();

    // Fill — info colour for data-viz (never accent)
    const fillW = Math.max(barH, (trackW * weight) / 100);
    const fillTone =
      weight >= 85 ? STATUS.down.hex :
      weight >= 65 ? STATUS.warn.hex :
      weight >= 45 ? STATUS.info.hex :
                     STATUS.mute.hex;
    ctx.fillStyle = fillTone;
    ctx.globalAlpha = 0.92;
    roundRect(ctx, trackX, trackY, fillW, barH, barH / 2); ctx.fill();
    ctx.globalAlpha = 1;
  });

  // Footer hairline + caption
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(16, H - 22); ctx.lineTo(W - 16, H - 22); ctx.stroke();
  text(ctx, 'CONFIDENCE = bayes · pattern · embedding · ai · policy', 16, H - 8, {
    font: '9px ' + TYPE.mono, color: SURFACE.textMuted, letterSpacing: 1.1,
  });

  return toBuffer(canvas);
}

module.exports = { renderConfidenceDial };
