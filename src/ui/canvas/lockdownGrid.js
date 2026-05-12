/**
 * Lockdown channel grid — visual "X of N channels locked" map.
 *
 * Each card shows a lock glyph and the channel mention, with state conveyed
 * through:
 *  - Cell border color (red = locked, green = unlocked, slate = untouched)
 *  - Glyph color
 *  - Channel name color
 *  - A small caption line ("access closed" / "access open" / "no change")
 *
 * v2 fix: per-cell clip mask + strict vertical stack — channel name and
 * caption never share an x-coordinate. The previous design overprinted a
 * state pill onto the channel name in dense 4-column layouts.
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
  // Cell height grew from 62 → 76 to give the vertical stack proper breathing
  // room. Name row + caption row + padding without compression.
  const cellH = 76;
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
    font: 'bold 9.5px ' + TYPE.mono,
    color: lockedCount === ch.length ? STATUS.down.hex
         : lockedCount > 0           ? STATUS.warn.hex
         :                             STATUS.up.hex,
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
    const caption =
      c.status === 'locked'   ? 'access closed' :
      c.status === 'unlocked' ? 'access open'   :
                                'no change';
    const stateTag =
      c.status === 'locked'   ? 'LOCKED'   :
      c.status === 'unlocked' ? 'UNLOCKED' :
                                'UNTOUCHED';

    // ── Card base (clipped so nothing inside escapes the cell) ──────────
    ctx.save();
    roundRect(ctx, x, y, cellW, cellH, 6);
    ctx.clip();

    ctx.fillStyle = SURFACE.panelBg;
    ctx.fillRect(x, y, cellW, cellH);

    if (c.status !== 'untouched') {
      // soft wash so the cell reads as state-active without overpowering
      ctx.fillStyle = tone + '14'; // ~8% alpha hex
      ctx.fillRect(x, y, cellW, cellH);
    }

    // ── Top-right state tag (mini pill, never collides with name) ───────
    {
      const tagFont = 'bold 8px ' + TYPE.mono;
      ctx.font = tagFont;
      const tagW = ctx.measureText(stateTag).width + 12;
      const tagH = 14;
      const tagX = x + cellW - tagW - 10;
      const tagY = y + 10;
      ctx.fillStyle = tone + '26';
      ctx.strokeStyle = tone + 'aa';
      ctx.lineWidth = 1;
      roundRect(ctx, tagX, tagY, tagW, tagH, 3);
      ctx.fill();
      ctx.stroke();
      text(ctx, stateTag, tagX + 6, tagY + 10, {
        font: tagFont, color: tone, letterSpacing: 1.0,
      });
    }

    // ── Lock glyph (left side, vertically centered with name) ───────────
    const glyphX = x + 14;
    const glyphY = y + 32;
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

    // ── Row 1: channel name (no horizontal collision with anything) ─────
    const nameFont = 'bold 13px ' + TYPE.mono;
    // Budget: cell width minus glyph (32px) minus right padding (12px)
    const nameBudget = cellW - 32 - 12;
    const nameStr = fitText('#' + c.name, nameBudget, nameFont);
    text(ctx, nameStr, x + 34, y + 42, {
      font: nameFont,
      color: c.status === 'untouched' ? SURFACE.text : tone,
    });

    // ── Row 2: caption (dim, below name with full clearance) ────────────
    const captionFont = '500 10px ' + TYPE.mono;
    const captionBudget = cellW - 34 - 12;
    const captionStr = fitText(caption, captionBudget, captionFont);
    text(ctx, captionStr, x + 34, y + 60, {
      font: captionFont,
      color: SURFACE.textDim,
      letterSpacing: 0.4,
    });

    ctx.restore();

    // ── Card border (drawn AFTER clip restore so it sits on the edge) ───
    ctx.strokeStyle = c.status === 'untouched' ? SURFACE.panelBorder : tone + '88';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, cellW, cellH, 6);
    ctx.stroke();
  });

  return toBuffer(canvas);
}

module.exports = { renderLockdownGrid };
