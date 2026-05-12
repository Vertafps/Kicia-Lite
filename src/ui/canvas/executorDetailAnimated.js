/**
 * Single-executor detail card — animated GIF variant.
 *
 * Matches the static layout (statusOrb-style header strip + FREE/PAID
 * badge + big name + compat line + full-width INTEGRITY bar), but adds
 * the design-spec motion:
 *
 *   t = 0   .. 0.50  : bar fills 0 → target% with easeOutQuint, tracer
 *                      pip sits at the fill edge with a tone-colored bloom.
 *   t = 0.50 .. 1.00 : bar rests at target%, tracer pip orbits the full
 *                      bar width at constant speed (loops back to start
 *                      seamlessly at the loop boundary).
 *
 * Status pill border breathes opacity 0.55 → 1.0 (1 Hz) so the card
 * reads as live even when the user pauses on it.
 *
 * @param {Object} data — same shape as executorDetail.js
 */

const { ACCENT, SURFACE, STATUS, TYPE } = require('../colors');
const { renderGif, easeOutQuint } = require('./_animation');

const W = 480;
const H = 210;

function renderExecutorDetailAnimated({
  name = 'Unknown', type, status = 'supported', compatibility, link,
} = {}) {
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
  const integrityTarget =
    status === 'supported'               ? 1.0 :
    status === 'not_recommended'         ? 0.6 :
    status === 'temporarily_not_working' ? 0.5 :
                                            0.15;
  const hasLink = Boolean(link);

  return renderGif((ctx, t) => drawFrame(ctx, t), { width: W, height: H });

  function drawFrame(ctx, t) {
    drawGrid(ctx);
    drawCard(ctx, t);
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

  function drawCard(ctx, t) {
    // ── Outer card ──────────────────────────────────────────────────────────
    ctx.fillStyle = SURFACE.panelBg;
    roundRect(ctx, 12, 12, W - 24, H - 24, 8); ctx.fill();
    ctx.fillStyle = typeTone.hex + '12';
    roundRect(ctx, 12, 12, W - 24, H - 24, 8); ctx.fill();
    ctx.strokeStyle = typeTone.hex + '88';
    ctx.lineWidth = 1;
    roundRect(ctx, 12, 12, W - 24, H - 24, 8); ctx.stroke();

    // ── Header strip ────────────────────────────────────────────────────────
    drawText(ctx, 'EXECUTOR · KICIAHOOK COMPATIBILITY', 28, 34, {
      font: '600 9.5px ' + TYPE.mono,
      color: SURFACE.textMuted,
      letterSpacing: 1.6,
    });

    drawStatusPill(ctx, t, statusLabel, statusTone.hex);

    // ── FREE/PAID badge + big name ──────────────────────────────────────────
    let nameX = 28;
    if (knownType) {
      const badgeText = typeStr.toUpperCase();
      const badgeFont = 'bold 10px ' + TYPE.mono;
      ctx.save();
      ctx.font = badgeFont;
      const badgeW = ctx.measureText(badgeText).width + 16;
      const badgeH = 22;
      const badgeX = 28, badgeY = 60;
      ctx.fillStyle = typeTone.hex;
      roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 5); ctx.fill();
      ctx.restore();
      drawText(ctx, badgeText, badgeX + 8, badgeY + 15, {
        font: badgeFont, color: '#0E0F12', letterSpacing: 1.4,
      });
      nameX = badgeX + badgeW + 14;
    }

    const nameStr = fitText(ctx, name, W - nameX - 24, 'bold 32px ' + TYPE.sans);
    drawText(ctx, nameStr, nameX, 78, {
      font: 'bold 32px ' + TYPE.sans, color: SURFACE.text, letterSpacing: -0.5,
    });

    // ── Compatibility line ──────────────────────────────────────────────────
    const compatStr = compatibility || (status === 'supported' ? 'fully compatible' : 'see notes');
    drawText(ctx, compatStr, nameX, 100, {
      font: '500 12px ' + TYPE.mono, color: statusTone.hex, letterSpacing: 0.6,
    });

    // ── INTEGRITY bar (the design signature, now animated) ─────────────────
    drawIntegrityBar(ctx, t);

    // ── Footer hint ─────────────────────────────────────────────────────────
    const footL = hasLink ? '→ open the link below' : '→ open executor list for the full lineup';
    drawText(ctx, footL, 28, 176, {
      font: 'bold 10px ' + TYPE.mono, color: typeTone.hex, letterSpacing: 0.5,
    });
  }

  function drawStatusPill(ctx, t, label, tone) {
    const pillFont = 'bold 9px ' + TYPE.mono;
    const rightX = W - 28;
    const y = 22;
    ctx.save();
    ctx.font = pillFont;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const pillW = ctx.measureText(label).width + 16;
    const pillH = 18;
    const pillX = rightX - pillW;

    // Background wash.
    ctx.fillStyle = tone + '26';
    roundRect(ctx, pillX, y, pillW, pillH, 9); ctx.fill();

    // Border breathes opacity 0.55 → 1.0.
    const pulse = (Math.sin(t * Math.PI * 2) + 1) / 2;
    ctx.globalAlpha = 0.55 + pulse * 0.45;
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1.2;
    roundRect(ctx, pillX + 0.5, y + 0.5, pillW - 1, pillH - 1, 9); ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = tone;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
    ctx.fillText(label, pillX + 8, y + 12);
    ctx.restore();
  }

  function drawIntegrityBar(ctx, t) {
    const ibX = 28, ibY = 148, ibW = W - 56, ibH = 14;

    drawText(ctx, 'INTEGRITY', ibX, ibY - 6, {
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

    // Fill — fills 0→target over t=0..0.2 with easeOutQuint, then rests at
    // target for the remaining 80% of the loop. Tight window so the bar is
    // visibly "live" but stays at the true integrity value most of the time
    // (matters if a client only renders the first frame).
    const fillProgress = t < 0.2 ? easeOutQuint(t * 5) : 1;
    const fillW = ibW * integrityTarget * fillProgress;
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

    // Tracer pip — during fill (t<0.2), sits at the fill edge. After fill,
    // orbits the bar continuously (loops back to start at t=1 → 0 boundary).
    let pipX;
    if (t < 0.2) {
      pipX = ibX + fillW;
    } else {
      // Orbit over t=0.2..1.0 spanning the full filled bar width.
      const orbitT = (t - 0.2) / 0.8;
      pipX = ibX + (ibW * integrityTarget) * orbitT;
    }
    const pipY = ibY + ibH / 2;

    // Bloom under the pip.
    ctx.save();
    const bloomGrad = ctx.createRadialGradient(pipX, pipY, 0, pipX, pipY, 14);
    bloomGrad.addColorStop(0, statusTone.hex + 'CC');
    bloomGrad.addColorStop(1, statusTone.hex + '00');
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = bloomGrad;
    ctx.beginPath(); ctx.arc(pipX, pipY, 14, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Pip itself.
    ctx.save();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.arc(pipX, pipY, 3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Percentage label right — always shows the true integrity value so a
    // single-frame fallback never reads as "0%".
    const pctText = `${Math.round(integrityTarget * 100)}%`;
    drawText(ctx, pctText, W - 28, ibY + ibH + 14, {
      font: '600 9px ' + TYPE.mono, color: statusTone.hex,
      align: 'right', letterSpacing: 1.2,
    });
  }

  function drawText(ctx, str, x, y, opts = {}) {
    const {
      font = '12px ' + TYPE.sans,
      color = SURFACE.text,
      align = 'left',
      baseline = 'alphabetic',
      letterSpacing = 0,
    } = opts;
    ctx.save();
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${letterSpacing}px`;
    ctx.fillText(str, x, y);
    ctx.restore();
  }

  function fitText(ctx, str, maxWidth, font) {
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

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y,     x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x,     y + h, rr);
    ctx.arcTo(x,     y + h, x,     y,     rr);
    ctx.arcTo(x,     y,     x + w, y,     rr);
    ctx.closePath();
  }
}

module.exports = { renderExecutorDetailAnimated };
