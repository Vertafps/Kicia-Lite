/**
 * Animated lockdown grid — APNG looping hero for $lock / $unlock.
 *
 * Animation:
 *  - Cells light up in a left-to-right + top-to-bottom wave (delay per cell
 *    based on its position).
 *  - Locked cells get a red bloom that pulses gently after settling.
 *  - The header summary fades in last so the eye lands on the grid first.
 *
 * Same data shape as renderLockdownGrid — drop-in replacement returning APNG.
 */

const { SURFACE, STATUS, TYPE } = require('../colors');
const { renderApng, easeOutQuint, smoothstep } = require('./_animation');

function renderLockdownGridAnimated({ channels } = {}) {
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

  const W = 480;
  const cols = ch.length <= 2 ? 2 : ch.length <= 4 ? 2 : ch.length <= 6 ? 3 : 4;
  const cellW = (W - 32 - 12 * (cols - 1)) / cols;
  const cellH = 62;
  const rows = Math.ceil(ch.length / cols);
  const headerH = 36;
  const H = headerH + rows * (cellH + 12) + 8;

  const lockedCount = ch.filter((c) => c.status === 'locked').length;
  const unlockedCount = ch.filter((c) => c.status === 'unlocked').length;
  const untouchedCount = ch.length - lockedCount - unlockedCount;

  return renderApng((ctx, t) => {
    drawFrame(ctx, t);
  }, { width: W, height: H });

  function drawFrame(ctx, t) {
    drawGrid(ctx);
    drawHeader(ctx, t);
    ch.forEach((c, i) => drawCell(ctx, t, c, i));
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

  function drawHeader(ctx, t) {
    const headerAlpha = smoothstep(Math.min(1, (t - 0.55) / 0.35));
    ctx.save();
    ctx.font = '600 9.5px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.textMuted;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.6px';
    ctx.globalAlpha = headerAlpha;
    ctx.fillText('LOCKDOWN STATE', 16, 18);

    const headerRight = `${lockedCount}/${ch.length} LOCKED · ${unlockedCount} UNLOCKED · ${untouchedCount} UNTOUCHED`;
    ctx.font = 'bold 9.5px ' + TYPE.mono;
    const tone = lockedCount === ch.length ? STATUS.down.hex : lockedCount > 0 ? STATUS.warn.hex : STATUS.up.hex;
    ctx.fillStyle = tone;
    ctx.textAlign = 'right';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
    ctx.fillText(headerRight, W - 16, 18);
    ctx.restore();
  }

  function drawCell(ctx, t, c, i) {
    const col = i % cols, row = Math.floor(i / cols);
    const x = 16 + col * (cellW + 12);
    const y = headerH + row * (cellH + 12);
    const tone =
      c.status === 'locked'   ? STATUS.down.hex :
      c.status === 'unlocked' ? STATUS.up.hex   :
                                SURFACE.textMuted;

    // Per-cell delay: wave in reading order (col by col, row by row)
    const cellDelay = (i / Math.max(1, ch.length - 1)) * 0.45;
    const cellLocal = Math.max(0, Math.min(1, (t - cellDelay) / 0.4));
    const intro = easeOutQuint(cellLocal);

    if (intro <= 0) return;

    // Card base
    ctx.save();
    ctx.globalAlpha = intro;
    ctx.fillStyle = SURFACE.panelBg;
    ctx.strokeStyle = c.status === 'untouched' ? SURFACE.panelBorder : tone + '88';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, cellW, cellH, 6); ctx.fill(); ctx.stroke();
    if (c.status !== 'untouched') {
      ctx.fillStyle = tone + '14';
      roundRect(ctx, x, y, cellW, cellH, 6); ctx.fill();
    }
    ctx.restore();

    // Pulse bloom on locked cells after settle
    if (c.status === 'locked' && cellLocal >= 1) {
      const pulse = (Math.sin((t - cellDelay) * Math.PI * 3.5) + 1) / 2;
      const bloomR = 28 + pulse * 8;
      const bcx = x + cellW / 2;
      const bcy = y + cellH / 2;
      ctx.save();
      const halo = ctx.createRadialGradient(bcx, bcy, 0, bcx, bcy, bloomR);
      halo.addColorStop(0, tone + Math.floor(40 + pulse * 40).toString(16).padStart(2, '0'));
      halo.addColorStop(1, tone + '00');
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(bcx, bcy, bloomR, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = intro;

    // Lock glyph
    const glyphX = x + 12, glyphY = y + 14;
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
      ctx.globalAlpha *= 0.55;
      ctx.beginPath(); ctx.arc(7, 12, 3, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();

    // Channel name + pill
    ctx.save();
    ctx.globalAlpha = intro;
    ctx.font = 'bold 12px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.text;
    const textBudget = cellW - 36 - 12;
    const nameStr = fitText(ctx, '#' + c.name, textBudget);
    ctx.fillText(nameStr, x + 36, y + 24);

    const pillText =
      c.status === 'locked'   ? 'LOCKED'   :
      c.status === 'unlocked' ? 'UNLOCKED' :
                                'UNTOUCHED';
    ctx.font = 'bold 8.5px ' + TYPE.mono;
    const pillW = ctx.measureText(pillText).width + 12;
    const pillH = 14;
    const pillX = x + 36;
    const pillY = y + 32;
    ctx.fillStyle = tone + '22';
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1;
    roundRect(ctx, pillX, pillY, pillW, pillH, 3); ctx.fill();

    ctx.fillStyle = tone;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
    ctx.fillText(pillText, pillX + 6, pillY + 10);
    ctx.restore();
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

module.exports = { renderLockdownGridAnimated };
