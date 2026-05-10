/**
 * Single-executor detail card.
 *
 * Used when a user asks about a specific executor (e.g. "is Wave supported",
 * "tell me about Yub X"). Shows:
 *   - Big executor name
 *   - Type badge (FREE / PAID) coloured to match
 *   - Status pill (SUPPORTED / NOT RECOMMENDED / TEMPORARILY DOWN / UNSUPPORTED)
 *   - "fully compatible" / custom compatibility line
 *   - Up to two short notes
 *
 * @param {Object} data
 * @param {string} data.name
 * @param {string} [data.type]            'free' | 'paid'
 * @param {string} [data.status]          'supported' | 'not_recommended' | 'temporarily_not_working' | 'unsupported'
 * @param {string} [data.compatibility]   short compatibility line
 * @param {Array<string>} [data.notes]    bullet notes (up to 2 shown)
 * @param {string} [data.link]            primary link (URL)
 * @returns {Buffer} PNG buffer
 */
function renderExecutorDetail({
  name = 'Unknown', type, status = 'supported',
  compatibility, notes = [], link,
} = {}) {
  const { makeCanvas, toBuffer, gridBackground, roundRect, text,
          EMBED_WIDTH, ACCENT, SURFACE, STATUS, TYPE } = require('./_theme');

  const W = EMBED_WIDTH, H = 196;
  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  // type is intentionally optional — many KB entries (especially
  // not_recommended / unsupported) ship without a free/paid tag, and we
  // would rather show no label than guess wrong. When type is missing the
  // card leans on the *status* pill (SUPPORTED / NOT RECOMMENDED / etc.)
  // for its colour and meaning, and skips the FREE/PAID badge entirely.
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

  // ── Outer card ──────────────────────────────────────────────────────────
  ctx.fillStyle = SURFACE.panelBg;
  ctx.strokeStyle = typeTone.hex + '88';
  ctx.lineWidth = 1;
  roundRect(ctx, 12, 12, W - 24, H - 24, 8); ctx.fill(); ctx.stroke();
  // tone wash
  ctx.fillStyle = typeTone.hex + '12';
  roundRect(ctx, 12, 12, W - 24, H - 24, 8); ctx.fill();

  // ── Header strip ────────────────────────────────────────────────────────
  text(ctx, 'EXECUTOR · KICIAHOOK COMPATIBILITY', 28, 34, {
    font: '600 9.5px ' + TYPE.mono, color: SURFACE.textMuted, letterSpacing: 1.6,
  });
  text(ctx, statusLabel, W - 28, 34, {
    font: 'bold 9.5px ' + TYPE.mono, color: statusTone.hex, align: 'right', letterSpacing: 1.6,
  });

  // ── Big name + type badge row ───────────────────────────────────────────
  const nameY = 76;
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

  // Optional type badge (FREE / PAID) — only when the KB knows. For
  // entries without a type we skip the badge entirely and let the name
  // start at the card edge so the layout doesn't leave a hole.
  const badgeFont = 'bold 9.5px ' + TYPE.mono;
  const badgeX = 28, badgeY = 50;
  let nameX = badgeX;
  if (knownType) {
    const badgeText = typeStr.toUpperCase();
    ctx.save();
    ctx.font = badgeFont;
    const badgeW = ctx.measureText(badgeText).width + 14;
    const badgeH = 18;
    ctx.fillStyle = typeTone.hex;
    ctx.globalAlpha = 0.92;
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 4); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
    text(ctx, badgeText, badgeX + 7, badgeY + 13, {
      font: badgeFont, color: '#0E0F12', letterSpacing: 1.4,
    });
    nameX = badgeX + badgeW + 14;
  }

  // executor name
  const nameFont = 'bold 26px ' + TYPE.sans;
  const nameStr = fitText(name, W - nameX - 24, nameFont);
  text(ctx, nameStr, nameX, nameY, {
    font: nameFont, color: SURFACE.text,
  });

  // ── Compatibility line ─────────────────────────────────────────────────
  const compatStr = compatibility || (status === 'supported' ? 'fully compatible' : 'see notes');
  text(ctx, compatStr, nameX, nameY + 22, {
    font: '500 11px ' + TYPE.mono, color: statusTone.hex, letterSpacing: 0.8,
  });

  // ── Notes (up to 2) ────────────────────────────────────────────────────
  const noteList = (Array.isArray(notes) ? notes : []).filter(Boolean).slice(0, 2);
  if (noteList.length) {
    let y = 132;
    for (const note of noteList) {
      const fitted = fitText('· ' + String(note), W - 56, '11px ' + TYPE.sans);
      text(ctx, fitted, 28, y, {
        font: '11px ' + TYPE.sans, color: SURFACE.text,
      });
      y += 18;
    }
  }

  // ── Footer hint ────────────────────────────────────────────────────────
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(28, H - 28); ctx.lineTo(W - 28, H - 28); ctx.stroke();
  const footL = link ? `→ ${shorten(link)}` : '→ open full executor list';
  text(ctx, footL, 28, H - 14, {
    font: 'bold 10px ' + TYPE.mono, color: typeTone.hex, letterSpacing: 0.5,
  });
  const footRight = knownType
    ? (isFree ? 'FREE EXECUTOR' : 'PAID EXECUTOR')
    : `STATUS · ${statusLabel}`;
  text(ctx, footRight, W - 28, H - 14, {
    font: 'bold 10px ' + TYPE.mono, color: SURFACE.textMuted, align: 'right', letterSpacing: 1.2,
  });

  return toBuffer(canvas);
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
