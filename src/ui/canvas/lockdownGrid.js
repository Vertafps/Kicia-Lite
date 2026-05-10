/**
 * Lockdown channel grid — visual "X of N channels locked" map.
 *
 * Each card shows a lock glyph, the channel mention, and a state pill:
 *   - LOCKED    (red)
 *   - UNLOCKED  (green)
 *   - UNTOUCHED (slate)
 *
 * The grid is adaptive — fewer channels means wider cards so longer custom
 * labels (e.g. "community support chat") fit without truncating.
 *
 * @param {Object} data
 * @param {Array<{name:string,status:'locked'|'unlocked'|'untouched'}>} data.channels
 * @returns {Buffer} PNG buffer
 */
function renderLockdownGrid({ channels } = {}) {
  const { makeCanvas, toBuffer, gridBackground, roundRect, text,
          EMBED_WIDTH, SURFACE, STATUS, TYPE } = require('./_theme');

  const ch = channels && channels.length ? channels : [
    { name: 'general',       status: 'locked' },
    { name: 'help',          status: 'locked' },
    { name: 'support',       status: 'locked' },
    { name: 'showcase',      status: 'unlocked' },
    { name: 'announcements', status: 'untouched' },
    { name: 'staff',         status: 'untouched' },
    { name: 'logs',          status: 'untouched' },
    { name: 'releases',      status: 'untouched' },
  ];

  const W = EMBED_WIDTH;
  // Wider cards when there are fewer entries so labels read clearly.
  const cols = ch.length <= 2 ? 2 : ch.length <= 4 ? 2 : ch.length <= 6 ? 3 : 4;
  const cellW = (W - 32 - 12 * (cols - 1)) / cols;
  const cellH = 62;
  const rows = Math.ceil(ch.length / cols);
  const headerH = 36;
  const H = headerH + rows * (cellH + 12) + 8;

  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  const lockedCount = ch.filter((c) => c.status === 'locked').length;
  const unlockedCount = ch.filter((c) => c.status === 'unlocked').length;
  const untouchedCount = ch.length - lockedCount - unlockedCount;

  // ── Header ───────────────────────────────────────────────────────────
  text(ctx, 'LOCKDOWN STATE', 16, 18, {
    font: '600 9.5px ' + TYPE.mono, color: SURFACE.textMuted, letterSpacing: 1.6,
  });
  const headerRight = `${lockedCount}/${ch.length} LOCKED · ${unlockedCount} UNLOCKED · ${untouchedCount} UNTOUCHED`;
  text(ctx, headerRight, W - 16, 18, {
    font: 'bold 9.5px ' + TYPE.mono, color: lockedCount === ch.length ? STATUS.down.hex : lockedCount > 0 ? STATUS.warn.hex : STATUS.up.hex,
    align: 'right', letterSpacing: 1.2,
  });

  // Truncate text to fit a target pixel width.
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
    const y = headerH + row * (cellH + 12);
    const tone =
      c.status === 'locked'   ? STATUS.down.hex :
      c.status === 'unlocked' ? STATUS.up.hex   :
                                SURFACE.textMuted;
    const pillText =
      c.status === 'locked'   ? 'LOCKED'   :
      c.status === 'unlocked' ? 'UNLOCKED' :
                                'UNTOUCHED';

    // Card base
    ctx.fillStyle = SURFACE.panelBg;
    ctx.strokeStyle = c.status === 'untouched' ? SURFACE.panelBorder : tone + '88';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, cellW, cellH, 6); ctx.fill(); ctx.stroke();
    if (c.status !== 'untouched') {
      ctx.fillStyle = tone + '14'; // 8% wash
      roundRect(ctx, x, y, cellW, cellH, 6); ctx.fill();
    }

    // Lock glyph
    const glyphX = x + 12;
    const glyphY = y + 14;
    ctx.save();
    ctx.translate(glyphX, glyphY);
    ctx.fillStyle = tone;
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1.6;
    if (c.status === 'locked') {
      ctx.fillRect(0, 7, 14, 11);
      ctx.beginPath();
      ctx.moveTo(3, 7); ctx.lineTo(3, 4);
      ctx.arc(7, 4, 4, Math.PI, 0, false);
      ctx.lineTo(11, 7);
      ctx.stroke();
    } else if (c.status === 'unlocked') {
      ctx.fillRect(0, 7, 14, 11);
      ctx.beginPath();
      ctx.moveTo(3, 7); ctx.lineTo(3, 2);
      ctx.arc(8, 2, 4, Math.PI, 0, false);
      ctx.stroke();
    } else {
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(7, 12, 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // Channel name
    const nameFont = 'bold 12px ' + TYPE.mono;
    const textBudget = cellW - 36 - 12;
    const nameStr = fitText('#' + c.name, textBudget, nameFont);
    text(ctx, nameStr, x + 36, y + 24, {
      font: nameFont, color: SURFACE.text,
    });

    // State pill (small, right of name)
    const pillFont = 'bold 8.5px ' + TYPE.mono;
    ctx.save();
    ctx.font = pillFont;
    const pillW = ctx.measureText(pillText).width + 12;
    const pillH = 14;
    const pillX = x + 36;
    const pillY = y + 32;
    ctx.fillStyle = tone + '22';
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.95;
    roundRect(ctx, pillX, pillY, pillW, pillH, 3); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
    text(ctx, pillText, pillX + 6, pillY + 10, {
      font: pillFont, color: tone, letterSpacing: 1.2,
    });
  });

  return toBuffer(canvas);
}

module.exports = { renderLockdownGrid };
