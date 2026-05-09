/**
 * Lockdown channel grid — visual "X of N channels locked" map.
 *
 * @param {Object} data
 * @param {Array<{name:string,status:'locked'|'unlocked'|'untouched'}>} data.channels
 * @returns {Buffer} PNG buffer
 */
function renderLockdownGrid({ channels } = {}) {
  const { makeCanvas, toBuffer, gridBackground, roundRect, text,
          EMBED_WIDTH, SURFACE, STATUS, TYPE } = require('./_theme');

  const ch = channels && channels.length ? channels : [
    { name: 'general', status: 'locked' },
    { name: 'help',    status: 'locked' },
    { name: 'support', status: 'locked' },
    { name: 'showcase', status: 'unlocked' },
    { name: 'announcements', status: 'untouched' },
    { name: 'staff',         status: 'untouched' },
    { name: 'logs',          status: 'untouched' },
    { name: 'releases',      status: 'untouched' },
  ];

  const W = EMBED_WIDTH;
  // Pick a column count that suits the channel count and label widths.
  // Fewer channels → wider cards so longer custom labels (e.g. "community
  // support chat") have room without truncation.
  const cols = ch.length <= 2 ? 2 : ch.length <= 4 ? 2 : ch.length <= 6 ? 3 : 4;
  const cellW = (W - 32 - 12 * (cols - 1)) / cols;
  const cellH = 56;
  const rows = Math.ceil(ch.length / cols);
  const H = 28 + rows * (cellH + 12);

  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  const lockedCount = ch.filter((c) => c.status === 'locked').length;
  text(ctx, `LOCKDOWN STATE · ${lockedCount}/${ch.length} CHANNELS LOCKED`, 16, 16, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });

  // Truncate text to fit a target pixel width by progressively dropping characters.
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

  ch.forEach((c, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = 16 + col * (cellW + 12);
    const y = 28 + row * (cellH + 12);
    const tone =
      c.status === 'locked'   ? STATUS.down.hex :
      c.status === 'unlocked' ? STATUS.up.hex   :
                                SURFACE.textMuted;

    // Card
    ctx.fillStyle = SURFACE.panelBg;
    ctx.strokeStyle = c.status === 'untouched' ? SURFACE.panelBorder : tone;
    ctx.globalAlpha = c.status === 'untouched' ? 1 : 0.5;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, cellW, cellH, 4); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
    if (c.status === 'locked') {
      ctx.fillStyle = tone + '14';
      roundRect(ctx, x, y, cellW, cellH, 4); ctx.fill();
    }

    // Lock glyph
    ctx.save();
    ctx.translate(x + 10, y + 12);
    ctx.fillStyle = tone;
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1.5;
    if (c.status === 'locked') {
      // closed lock body + arch
      ctx.fillRect(0, 6, 14, 10);
      ctx.beginPath();
      ctx.moveTo(3, 6); ctx.lineTo(3, 4);
      ctx.arc(7, 4, 4, Math.PI, 0, false);
      ctx.lineTo(11, 6);
      ctx.stroke();
    } else if (c.status === 'unlocked') {
      ctx.fillRect(0, 6, 14, 10);
      ctx.beginPath();
      ctx.moveTo(3, 6); ctx.lineTo(3, 4);
      ctx.arc(7, 4, 4, Math.PI, 0, false);
      ctx.stroke();
    } else {
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.arc(7, 11, 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // Channel name — truncate to fit card minus the icon column and right pad.
    const nameFont = 'bold 11px ' + TYPE.mono;
    const stateFont = '9px ' + TYPE.mono;
    const textBudget = cellW - 32 - 8;
    const nameStr = fitText('#' + c.name, textBudget, nameFont);
    text(ctx, nameStr, x + 32, y + 22, {
      font: nameFont, color: SURFACE.text,
    });
    const stateStr = fitText(c.status.toUpperCase(), textBudget, stateFont);
    text(ctx, stateStr, x + 32, y + 38, {
      font: stateFont, color: tone, letterSpacing: 1.2,
    });
  });

  return toBuffer(canvas);
}

module.exports = { renderLockdownGrid };
