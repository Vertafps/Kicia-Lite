/**
 * KB editorial card — embed image for KB strong matches.
 *
 * Left:  diagonal-stripe accent panel with a small "KB" mark and the article
 *        category abbreviation (CONFIG / EXECUTOR / GUI / KEY / etc.).
 * Right: tag pill, article title, step indicator with a filled progress row,
 *        match meta line, and a "→ open full guide" affordance.
 *
 * @param {Object} data
 * @param {string} data.title
 * @param {string} data.tag         e.g. "EXECUTOR · FIX"
 * @param {number} data.step        1..total
 * @param {number} data.total       total steps
 * @param {number} data.match       0..1 (e.g. 0.92)
 * @param {string} [data.preview]   short preview line (e.g. first step)
 * @returns {Buffer} PNG buffer
 */
function renderKbEditorial({
  title = 'Untitled', tag = 'KB', step = 1, total = 1, match = 0.9, preview,
} = {}) {
  const { makeCanvas, toBuffer, text,
          EMBED_WIDTH, ACCENT, SURFACE, TYPE } = require('./_theme');

  const W = EMBED_WIDTH, H = 180;
  const { canvas, ctx } = makeCanvas(W, H);

  // ── Background wash ────────────────────────────────────────────────────
  const wash = ctx.createLinearGradient(0, 0, W, H);
  wash.addColorStop(0, ACCENT.hex + '24');
  wash.addColorStop(1, ACCENT.hex + '00');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  // ── Striped accent panel (left) ────────────────────────────────────────
  const panelW = 150;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, panelW, H); ctx.clip();
  ctx.fillStyle = ACCENT.hex;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(0, 0, panelW, H);
  // Diagonal stripes
  ctx.globalAlpha = 0.20;
  for (let s = -H; s < W + H; s += 8) {
    ctx.fillRect(s, -10, 1.5, H + 20);
  }
  ctx.restore();
  // Outline
  ctx.strokeStyle = ACCENT.hex + '55';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, panelW - 1, H - 1);

  // KB mark — large initials
  text(ctx, 'KB', panelW / 2, H / 2 - 4, {
    font: 'bold 28px ' + TYPE.sans, color: ACCENT.hex, align: 'center', letterSpacing: 4,
  });
  // Category caption (parsed from tag)
  const category = String(tag).split(/[· ]+/)[0].trim() || 'KB';
  text(ctx, category, panelW / 2, H / 2 + 14, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.text, align: 'center', letterSpacing: 2,
  });

  // ── Right column ───────────────────────────────────────────────────────
  const rx = panelW + 24;
  const rRight = W - 16;
  const rW = rRight - rx;

  // Tag pill
  const tagFont = 'bold 9px ' + TYPE.mono;
  ctx.save();
  ctx.font = tagFont;
  const tagW = Math.min(ctx.measureText(tag).width + 14, rW);
  ctx.fillStyle = ACCENT.hex + '2E';
  ctx.strokeStyle = ACCENT.hex + '88';
  ctx.lineWidth = 0.8;
  ctx.fillRect(rx, 22, tagW, 18);
  ctx.strokeRect(rx + 0.5, 22.5, tagW, 18);
  ctx.restore();
  text(ctx, tag, rx + 7, 35, {
    font: tagFont, color: ACCENT.hex, letterSpacing: 1.4,
  });

  // Title — with truncation that respects pixel width, not just length
  function fitText(str, maxWidth, font) {
    ctx.save();
    ctx.font = font;
    if (ctx.measureText(str).width <= maxWidth) {
      ctx.restore();
      return str;
    }
    let lo = 0, hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const candidate = str.slice(0, mid) + '…';
      if (ctx.measureText(candidate).width <= maxWidth) lo = mid + 1;
      else hi = mid;
    }
    ctx.restore();
    return str.slice(0, Math.max(1, lo - 1)) + '…';
  }
  const titleFont = 'bold 16px ' + TYPE.sans;
  text(ctx, fitText(title, rW, titleFont), rx, 65, {
    font: titleFont, color: SURFACE.text,
  });

  // Optional preview line (e.g. first step or category sub-text)
  if (preview) {
    const previewFont = '11px ' + TYPE.sans;
    text(ctx, fitText(String(preview), rW, previewFont), rx, 84, {
      font: previewFont, color: SURFACE.textMuted,
    });
  }

  // Step indicator
  text(ctx, `STEP ${step} OF ${total}`, rx, 108, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textMuted, letterSpacing: 1.6,
  });
  const segmentMax = Math.min(total, 8);
  const segGap = 4;
  const segW = Math.min(20, (rW - segGap * (segmentMax - 1)) / segmentMax);
  for (let i = 0; i < segmentMax; i++) {
    ctx.fillStyle = i < step ? ACCENT.hex : SURFACE.panelBorder;
    ctx.fillRect(rx + i * (segW + segGap), 116, segW, 4);
  }

  // Match meta line
  const matchPct = Math.round(Math.max(0, Math.min(1, match)) * 100);
  text(ctx, `match · ${matchPct}%`, rx, H - 30, {
    font: '600 10px ' + TYPE.mono, color: SURFACE.text, letterSpacing: 0.6,
  });
  text(ctx, '· source · kb.json', rx + 92, H - 30, {
    font: '10px ' + TYPE.mono, color: SURFACE.textMuted, letterSpacing: 0.6,
  });

  // Hairline divider + CTA
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(rx, H - 22); ctx.lineTo(rRight, H - 22); ctx.stroke();
  text(ctx, '→ open full guide', rx, H - 8, {
    font: 'bold 10px ' + TYPE.mono, color: ACCENT.hex, letterSpacing: 0.5,
  });

  return toBuffer(canvas);
}

module.exports = { renderKbEditorial };
