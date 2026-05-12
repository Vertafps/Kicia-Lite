/**
 * Single-executor detail card — static PNG fallback.
 *
 * v3 design (matches Design By Claude screenshot "Executor (Specific one).png"
 * and animations.jsx executorDetail spec):
 *
 *   - Header strip: "EXECUTOR · KICIAHOOK COMPATIBILITY" left, status pill right.
 *   - Badge (FREE/PAID, optional) + big executor name.
 *   - Single compatibility / status line under the name.
 *   - Big INTEGRITY bar across the bottom — fills based on status.
 *     · supported → 100% green
 *     · not_recommended / temporarily_not_working → 50-60% yellow
 *     · unsupported → 15% red
 *     A tracer pip rests at the fill edge.
 *
 * Notes (if any) are passed to the embed description by the caller, not
 * baked into the image — the bar is the visual payload.
 *
 * @param {Object} data
 * @param {string} data.name
 * @param {string} [data.type]            'free' | 'paid'
 * @param {string} [data.status]          'supported' | 'not_recommended' | 'temporarily_not_working' | 'unsupported'
 * @param {string} [data.compatibility]
 * @param {string} [data.link]
 * @returns {Buffer} PNG buffer
 */
function renderExecutorDetail({
  name = 'Unknown', type, status = 'supported', compatibility, link,
} = {}) {
  const { makeCanvas, toBuffer, gridBackground, roundRect, text,
          EMBED_WIDTH, ACCENT, SURFACE, STATUS, TYPE } = require('./_theme');

  const W = EMBED_WIDTH, H = 210;
  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  const typeStr = String(type || '').toLowerCase();
  const knownType = typeStr === 'free' || typeStr === 'paid';
  const isFree = typeStr === 'free';

  const statusTone =
    status === 'temporarily_not_working' ? STATUS.warn :
    status === 'not_recommended'         ? STATUS.warn :
    status === 'unsupported'             ? STATUS.down :
                                            STATUS.up;
  const statusLabel =
    status === 'temporarily_not_working' ? 'TEMPORARILY DOWN' :
    status === 'not_recommended'         ? 'NOT RECOMMENDED' :
    status === 'unsupported'             ? 'UNSUPPORTED' :
                                            'SUPPORTED';
  const typeTone = knownType
    ? (isFree ? STATUS.up : ACCENT)
    : statusTone;
  const integrity =
    status === 'supported'               ? 1.0 :
    status === 'not_recommended'         ? 0.6 :
    status === 'temporarily_not_working' ? 0.5 :
                                            0.15;

  // ── Outer card ──────────────────────────────────────────────────────────
  ctx.fillStyle = SURFACE.panelBg;
  roundRect(ctx, 12, 12, W - 24, H - 24, 8); ctx.fill();
  ctx.fillStyle = typeTone.hex + '12';
  roundRect(ctx, 12, 12, W - 24, H - 24, 8); ctx.fill();
  ctx.strokeStyle = typeTone.hex + '88';
  ctx.lineWidth = 1;
  roundRect(ctx, 12, 12, W - 24, H - 24, 8); ctx.stroke();

  // ── Header strip ────────────────────────────────────────────────────────
  text(ctx, 'EXECUTOR · KICIAHOOK COMPATIBILITY', 28, 34, {
    font: '600 9.5px ' + TYPE.mono, color: SURFACE.textMuted, letterSpacing: 1.6,
  });

  // Status pill top-right.
  drawStatusPill(ctx, W - 28, 22, statusLabel, statusTone.hex, TYPE, roundRect);

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
      const c = str.slice(0, mid) + '…';
      if (ctx.measureText(c).width <= maxWidth) lo = mid + 1;
      else hi = mid;
    }
    ctx.restore();
    return str.slice(0, Math.max(1, lo - 1)) + '…';
  }

  // ── FREE/PAID badge + big name ──────────────────────────────────────────
  const badgeFont = 'bold 10px ' + TYPE.mono;
  let nameX = 28;
  if (knownType) {
    const badgeText = typeStr.toUpperCase();
    ctx.save();
    ctx.font = badgeFont;
    const badgeW = ctx.measureText(badgeText).width + 16;
    const badgeH = 22;
    const badgeX = 28, badgeY = 60;
    ctx.fillStyle = typeTone.hex;
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 5); ctx.fill();
    ctx.restore();
    text(ctx, badgeText, badgeX + 8, badgeY + 15, {
      font: badgeFont, color: '#0E0F12', letterSpacing: 1.4,
    });
    nameX = badgeX + badgeW + 14;
  }

  const nameFont = 'bold 32px ' + TYPE.sans;
  const nameY = 78;
  const nameStr = fitText(name, W - nameX - 24, nameFont);
  text(ctx, nameStr, nameX, nameY, {
    font: nameFont, color: SURFACE.text, letterSpacing: -0.5,
  });

  // ── Compatibility line ──────────────────────────────────────────────────
  const compatStr = compatibility || (status === 'supported' ? 'fully compatible' : 'see notes');
  text(ctx, compatStr, nameX, nameY + 22, {
    font: '500 12px ' + TYPE.mono, color: statusTone.hex, letterSpacing: 0.6,
  });

  // ── INTEGRITY bar (the design signature) ────────────────────────────────
  const ibX = 28, ibY = 148, ibW = W - 56, ibH = 14;
  text(ctx, 'INTEGRITY', ibX, ibY - 6, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.6,
  });

  // Track.
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.globalAlpha = 0.4;
  roundRect(ctx, ibX, ibY, ibW, ibH, 4); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  roundRect(ctx, ibX + 0.5, ibY + 0.5, ibW - 1, ibH - 1, 4); ctx.stroke();
  ctx.restore();

  // Fill.
  const fillW = ibW * integrity;
  if (fillW > 0) {
    ctx.save();
    roundRect(ctx, ibX, ibY, fillW, ibH, 4); ctx.clip();
    const grad = ctx.createLinearGradient(ibX, 0, ibX + ibW, 0);
    grad.addColorStop(0, statusTone.hex + 'CC');
    grad.addColorStop(1, statusTone.hex);
    ctx.fillStyle = grad;
    ctx.fillRect(ibX, ibY, fillW, ibH);
    ctx.restore();
  }

  // Tracer pip at the fill edge.
  const pipX = ibX + fillW;
  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath(); ctx.arc(pipX, ibY + ibH / 2, 3, 0, Math.PI * 2); ctx.fill();
  // Soft bloom around the pip.
  const bloomGrad = ctx.createRadialGradient(pipX, ibY + ibH / 2, 0, pipX, ibY + ibH / 2, 12);
  bloomGrad.addColorStop(0, statusTone.hex + 'AA');
  bloomGrad.addColorStop(1, statusTone.hex + '00');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = bloomGrad;
  ctx.beginPath(); ctx.arc(pipX, ibY + ibH / 2, 12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Percentage label right.
  text(ctx, `${Math.round(integrity * 100)}%`, W - 28, ibY + ibH + 14, {
    font: '600 9px ' + TYPE.mono, color: statusTone.hex,
    align: 'right', letterSpacing: 1.2,
  });

  // ── Footer hint ─────────────────────────────────────────────────────────
  // The actual link is rendered as a button below the embed (handled in
  // ping.js / buildLinkButtonRows). Showing a shortened URL here just
  // produced bare "discord.gg" / "github.io" strings — useless context.
  const footL = link ? `→ open the link below` : '→ open executor list for the full lineup';
  text(ctx, footL, 28, ibY + ibH + 14, {
    font: 'bold 10px ' + TYPE.mono, color: typeTone.hex, letterSpacing: 0.5,
  });

  return toBuffer(canvas);
}

function drawStatusPill(ctx, rightX, y, label, tone, TYPE, roundRect) {
  const pillFont = 'bold 9px ' + TYPE.mono;
  ctx.save();
  ctx.font = pillFont;
  const pillW = ctx.measureText(label).width + 16;
  const pillH = 18;
  const pillX = rightX - pillW;
  ctx.fillStyle = tone + '26';
  roundRect(ctx, pillX, y, pillW, pillH, 9); ctx.fill();
  ctx.strokeStyle = tone;
  ctx.lineWidth = 1;
  roundRect(ctx, pillX + 0.5, y + 0.5, pillW - 1, pillH - 1, 9); ctx.stroke();
  ctx.fillStyle = tone;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
  ctx.fillText(label, pillX + 8, y + 12);
  ctx.restore();
}

function shorten(url) {
  try {
    const u = new URL(String(url));
    return (u.hostname || String(url)).replace(/^www\./, '');
  } catch {
    return String(url || '').slice(0, 32);
  }
}

module.exports = { renderExecutorDetail };
