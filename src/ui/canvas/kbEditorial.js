/**
 * KB editorial card — appears as the embed image for KB strong matches.
 * Striped placeholder block on the left, editorial title + step indicator right.
 *
 * @param {Object} data
 * @param {string} data.title
 * @param {string} data.tag        e.g. "EXECUTOR · FIX"
 * @param {number} data.step       1..total
 * @param {number} data.total      total steps
 * @param {number} data.match      0..1 (e.g. 0.92)
 * @returns {Buffer} PNG buffer
 */
function renderKbEditorial({ title = 'Untitled', tag = 'KB', step = 1, total = 1, match = 0.9 } = {}) {
  const { makeCanvas, toBuffer, text,
          EMBED_WIDTH, ACCENT, SURFACE, TYPE } = require('./_theme');

  const W = EMBED_WIDTH, H = 170;
  const { canvas, ctx } = makeCanvas(W, H);

  // Subtle accent wash background
  const wash = ctx.createLinearGradient(0, 0, W, H);
  wash.addColorStop(0, ACCENT.hex + '2E');
  wash.addColorStop(1, ACCENT.hex + '00');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  // ── Striped placeholder block (left) ───────────────────────────────────
  ctx.save();
  ctx.fillStyle = ACCENT.hex;
  ctx.globalAlpha = 0.18;
  ctx.beginPath(); ctx.rect(0, 0, 160, H); ctx.clip();
  // 45° stripes
  for (let s = -H; s < W + H; s += 6) {
    ctx.fillStyle = ACCENT.hex;
    ctx.fillRect(s, -10, 2, H + 20);
  }
  ctx.restore();
  // Outline
  ctx.strokeStyle = ACCENT.hex + '4D';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, 159, H - 1);
  text(ctx, 'KB', 80, H / 2 - 6, {
    font: '600 10px ' + TYPE.mono, color: ACCENT.hex, align: 'center', letterSpacing: 2,
  });
  text(ctx, 'art placeholder', 80, H / 2 + 8, {
    font: '9px ' + TYPE.mono, color: SURFACE.textDim, align: 'center',
  });

  // ── Right column ───────────────────────────────────────────────────────
  // Tag pill
  const tagW = (tag.length * 6) + 16;
  ctx.fillStyle = ACCENT.hex + '2E';
  ctx.strokeStyle = ACCENT.hex;
  ctx.lineWidth = 0.5;
  ctx.fillRect(180, 20, tagW, 18);
  ctx.strokeRect(180.5, 20.5, tagW, 18);
  text(ctx, tag, 188, 33, {
    font: 'bold 9px ' + TYPE.mono, color: ACCENT.hex, letterSpacing: 1.5,
  });

  // Title
  const tt = title.length > 28 ? title.slice(0, 28) + '…' : title;
  text(ctx, tt, 180, 62, {
    font: 'bold 15px ' + TYPE.sans, color: SURFACE.text,
  });

  // Step indicator
  text(ctx, `STEP ${step} OF ${total}`, 180, 92, {
    font: '9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });
  for (let i = 0; i < total; i++) {
    ctx.fillStyle = i < step ? ACCENT.hex : SURFACE.panelBorder;
    ctx.fillRect(180 + i * 22, 98, 18, 3);
  }

  // Match meta
  text(ctx, `match · ${match.toFixed(2)}  ·  source · kb.json`, 180, H - 32, {
    font: '9px ' + TYPE.mono, color: SURFACE.textDim,
  });

  // CTA divider + link hint
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(180, H - 22); ctx.lineTo(W - 16, H - 22); ctx.stroke();
  text(ctx, '→ open full guide', 180, H - 8, {
    font: 'bold 10px ' + TYPE.mono, color: ACCENT.hex,
  });

  return toBuffer(canvas);
}

module.exports = { renderKbEditorial };
