/**
 * Animated executor list — reticle cursor hops card-to-card.
 *
 * Design concept (from animations.jsx): every card is fully readable from
 * frame 0. The motion is a single tracking reticle (corner brackets) that
 * walks the grid in reading order. When the reticle sits on a card, that
 * card gets a soft wash and its badge blooms briefly.
 *
 * No fade-ins, no entrance animations — first frame is the full grid.
 */

const { SURFACE, STATUS, ACCENT, TYPE } = require('../colors');
const { renderGif, easeInOutSine } = require('./_animation');

function renderExecutorListAnimated({ executors = [] } = {}) {
  const list = executors.length ? executors : [
    { name: 'Isaeva', type: 'paid', compatibility: 'fully compatible' },
    { name: 'Yub X',  type: 'free', compatibility: 'fully compatible' },
    { name: 'Volt',   type: 'paid', compatibility: 'fully compatible' },
    { name: 'Madium', type: 'free', compatibility: 'fully compatible' },
  ];

  const W = 480;
  const cols = list.length <= 2 ? 2 : list.length <= 4 ? 2 : list.length <= 6 ? 3 : 4;
  const cellW = (W - 32 - 12 * (cols - 1)) / cols;
  const cellH = 64;
  const rows = Math.ceil(list.length / cols);
  const H = 32 + rows * (cellH + 12);

  const freeCount = list.filter((e) => (e.type || '').toLowerCase() === 'free').length;
  const paidCount = list.length - freeCount;

  return renderGif((ctx, t) => drawFrame(ctx, t), { width: W, height: H });

  function drawFrame(ctx, t) {
    drawGrid(ctx);
    drawHeader(ctx);

    // Reticle hops card-to-card. Each "dwell" is one full hop slot.
    // activeFrac eases in/out so the wash and bloom feel deliberate.
    const slot = t * list.length;
    const activeIdx = Math.floor(slot) % list.length;
    const activeFrac = slot - Math.floor(slot);
    // Soften the wash at start/end of each hop so it feels like a beat.
    const dwellAlpha = 1 - Math.abs(0.5 - activeFrac) * 2; // 0..1..0 across slot

    list.forEach((e, i) => {
      drawCard(ctx, e, i, i === activeIdx ? easeInOutSine(dwellAlpha) : 0);
    });

    // Reticle on the active card.
    const activeCardCoords = cardCoords(activeIdx);
    drawReticle(ctx, activeCardCoords, easeInOutSine(dwellAlpha));
  }

  function cardCoords(i) {
    const col = i % cols, row = Math.floor(i / cols);
    return {
      x: 16 + col * (cellW + 12),
      y: 32 + row * (cellH + 12),
      w: cellW,
      h: cellH,
    };
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
    ctx.textAlign = 'left';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
    ctx.fillText(
      `SUPPORTED EXECUTORS · ${list.length} TOTAL · ${freeCount} FREE · ${paidCount} PAID`,
      16, 18
    );
    ctx.restore();
  }

  function drawCard(ctx, e, i, activeAmount) {
    const { x, y, w, h } = cardCoords(i);
    const isFree = (e.type || '').toLowerCase() === 'free';
    const tone = isFree ? STATUS.up.hex : ACCENT.hex;

    // Card base (always rendered fully).
    ctx.save();
    roundRect(ctx, x, y, w, h, 5);
    ctx.clip();

    ctx.fillStyle = SURFACE.panelBg;
    ctx.fillRect(x, y, w, h);
    // Faint always-on tone wash so cards read as colored.
    ctx.fillStyle = tone + '12';
    ctx.fillRect(x, y, w, h);

    // Active wash — brightens the card when the reticle is on it.
    if (activeAmount > 0.02) {
      const alpha = Math.floor(activeAmount * 28).toString(16).padStart(2, '0');
      ctx.fillStyle = tone + alpha;
      ctx.fillRect(x, y, w, h);
    }

    // Badge pill (top-left).
    const badgeText = (e.type || 'paid').toUpperCase();
    const badgeFont = 'bold 8px ' + TYPE.mono;
    ctx.font = badgeFont;
    ctx.textAlign = 'left';
    const badgeW = ctx.measureText(badgeText).width + 12;
    const badgeH = 14;
    ctx.fillStyle = tone;
    ctx.globalAlpha = 0.85;
    roundRect(ctx, x + 8, y + 8, badgeW, badgeH, 3);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Badge bloom when active.
    if (activeAmount > 0.05) {
      const bcx = x + 8 + badgeW / 2;
      const bcy = y + 8 + badgeH / 2;
      const halo = ctx.createRadialGradient(bcx, bcy, 0, bcx, bcy, 24);
      const alphaHex = Math.floor(40 + activeAmount * 40).toString(16).padStart(2, '0');
      halo.addColorStop(0, tone + alphaHex);
      halo.addColorStop(1, tone + '00');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(bcx, bcy, 24, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Badge text.
    ctx.fillStyle = '#0E0F12';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
    ctx.fillText(badgeText, x + 14, y + 18);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // Name.
    ctx.font = 'bold 13px ' + TYPE.sans;
    ctx.fillStyle = SURFACE.text;
    const namePad = 12;
    const nameStr = fitText(ctx, e.name, w - namePad * 2);
    ctx.fillText(nameStr, x + namePad, y + 40);

    // Compatibility line.
    ctx.font = '9px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.textDim;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.8px';
    const compatStr = fitText(ctx, e.compatibility || 'supported', w - namePad * 2);
    ctx.fillText(compatStr, x + namePad, y + 54);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    ctx.restore(); // unclip

    // Card border (drawn after clip restore so it sits on the edge).
    ctx.save();
    ctx.strokeStyle = tone;
    ctx.globalAlpha = 0.55 + activeAmount * 0.45;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 5);
    ctx.stroke();
    ctx.restore();
  }

  function drawReticle(ctx, coords, alpha) {
    if (alpha < 0.05) return;
    const { x, y, w, h } = coords;
    // Corner brackets extend from each corner inward.
    const armLength = 10;
    ctx.save();
    ctx.strokeStyle = SURFACE.text;
    ctx.globalAlpha = 0.4 + alpha * 0.5;
    ctx.lineWidth = 1.5;

    // Top-left
    line(ctx, x - 2, y + armLength + 1, x - 2, y - 2, x + armLength + 1, y - 2);
    // Top-right
    line(ctx, x + w + 2, y + armLength + 1, x + w + 2, y - 2, x + w - armLength - 1, y - 2);
    // Bottom-left
    line(ctx, x - 2, y + h - armLength - 1, x - 2, y + h + 2, x + armLength + 1, y + h + 2);
    // Bottom-right
    line(ctx, x + w + 2, y + h - armLength - 1, x + w + 2, y + h + 2, x + w - armLength - 1, y + h + 2);

    ctx.restore();
  }

  function line(ctx, x1, y1, x2, y2, x3, y3) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    if (typeof x3 === 'number') ctx.lineTo(x3, y3);
    ctx.stroke();
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

  function fitText(ctx, str, maxWidth) {
    if (ctx.measureText(str).width <= maxWidth) return str;
    let lo = 0, hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const candidate = str.slice(0, mid) + '…';
      if (ctx.measureText(candidate).width <= maxWidth) lo = mid + 1;
      else hi = mid;
    }
    return str.slice(0, Math.max(1, lo - 1)) + '…';
  }
}

module.exports = { renderExecutorListAnimated };
