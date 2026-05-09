/**
 * Supported executor scorecard — used by the KB executor-list response.
 * Renders one card per executor with a type badge (free / paid) and a
 * compatibility tag. Stays compact: keeps to the embed width and prefers
 * dense 4-col layouts so the list reads at a glance.
 *
 * @param {Object} data
 * @param {Array<{name:string,type?:string,compatibility?:string}>} data.executors
 * @returns {Buffer} PNG buffer
 */
function renderExecutorList({ executors = [] } = {}) {
  const { makeCanvas, toBuffer, gridBackground, roundRect, text,
          EMBED_WIDTH, SURFACE, STATUS, ACCENT, TYPE } = require('./_theme');

  const list = executors.length ? executors : [
    { name: 'Isaeva',   type: 'paid', compatibility: 'fully compatible' },
    { name: 'Yub X',    type: 'free', compatibility: 'fully compatible' },
    { name: 'Volt',     type: 'paid', compatibility: 'fully compatible' },
    { name: 'Madium',   type: 'free', compatibility: 'fully compatible' },
  ];

  const W = EMBED_WIDTH;
  const cols = list.length <= 2 ? 2 : list.length <= 4 ? 2 : list.length <= 6 ? 3 : 4;
  const cellW = (W - 32 - 12 * (cols - 1)) / cols;
  const cellH = 64;
  const rows = Math.ceil(list.length / cols);
  const H = 32 + rows * (cellH + 12);

  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  const freeCount = list.filter((e) => e.type === 'free').length;
  const paidCount = list.length - freeCount;
  text(ctx, `SUPPORTED EXECUTORS · ${list.length} TOTAL · ${freeCount} FREE · ${paidCount} PAID`, 16, 18, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });

  function fitText(str, maxWidth, font) {
    ctx.save();
    ctx.font = font;
    if (ctx.measureText(str).width <= maxWidth) {
      ctx.restore();
      return str;
    }
    let lo = 0;
    let hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const candidate = str.slice(0, mid) + '…';
      if (ctx.measureText(candidate).width <= maxWidth) lo = mid + 1;
      else hi = mid;
    }
    ctx.restore();
    return str.slice(0, Math.max(1, lo - 1)) + '…';
  }

  list.forEach((e, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = 16 + col * (cellW + 12);
    const y = 32 + row * (cellH + 12);
    const isFree = (e.type || '').toLowerCase() === 'free';
    const tone = isFree ? STATUS.up.hex : ACCENT.hex;

    // Card
    ctx.fillStyle = SURFACE.panelBg;
    ctx.strokeStyle = tone;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, cellW, cellH, 5); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = tone + '12';
    roundRect(ctx, x, y, cellW, cellH, 5); ctx.fill();

    // Badge pill (top-left)
    const badgeText = (e.type || 'paid').toUpperCase();
    const badgeFont = 'bold 8px ' + TYPE.mono;
    ctx.save();
    ctx.font = badgeFont;
    const badgeW = ctx.measureText(badgeText).width + 12;
    ctx.fillStyle = tone;
    ctx.globalAlpha = 0.85;
    roundRect(ctx, x + 8, y + 8, badgeW, 14, 3); ctx.fill();
    ctx.restore();
    text(ctx, badgeText, x + 8 + 6, y + 18, {
      font: badgeFont, color: '#0E0F12', letterSpacing: 1.2,
    });

    // Name
    const nameFont = 'bold 13px ' + TYPE.sans;
    const namePad = 12;
    const nameStr = fitText(e.name, cellW - namePad * 2, nameFont);
    text(ctx, nameStr, x + namePad, y + 40, {
      font: nameFont, color: SURFACE.text,
    });

    // Compatibility line
    const compatStr = fitText(e.compatibility || 'supported', cellW - namePad * 2, '9px ' + TYPE.mono);
    text(ctx, compatStr, x + namePad, y + 54, {
      font: '9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 0.8,
    });
  });

  return toBuffer(canvas);
}

module.exports = { renderExecutorList };
