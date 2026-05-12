/**
 * Animated lockdown grid — looping GIF for $lock / $unlock.
 *
 * Design rule: every cell is fully visible from frame 0. Animation = a soft
 * scan beam that travels across the grid (highlighting each cell as it passes)
 * and a gentle red bloom pulse on locked cells.
 *
 * v2 fix: matches the static lockdownGrid v2 layout — per-cell clip, vertical
 * stack (name on top, caption below, state tag in top-right corner). No more
 * horizontal text collision in dense layouts.
 */

const { SURFACE, STATUS, TYPE } = require('../colors');
const { renderGif } = require('./_animation');

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
  // Match static v2: 76px cell height for proper vertical stack breathing room.
  const cellH = 76;
  const rows = Math.ceil(ch.length / cols);
  const headerH = 36;
  const H = headerH + rows * (cellH + 12) + 8;

  const lockedCount = ch.filter((c) => c.status === 'locked').length;
  const unlockedCount = ch.filter((c) => c.status === 'unlocked').length;
  const untouchedCount = ch.length - lockedCount - unlockedCount;

  return renderGif((ctx, t) => drawFrame(ctx, t), { width: W, height: H });

  function drawFrame(ctx, t) {
    drawGrid(ctx);
    drawHeader(ctx);
    ch.forEach((c, i) => drawCell(ctx, t, c, i));
    drawScanBeam(ctx, t);
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
    ctx.font = '600 9.5px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.textMuted;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.6px';
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
    const caption =
      c.status === 'locked'   ? 'access closed' :
      c.status === 'unlocked' ? 'access open'   :
                                'no change';
    const stateTag =
      c.status === 'locked'   ? 'LOCKED'   :
      c.status === 'unlocked' ? 'UNLOCKED' :
                                'UNTOUCHED';

    // Per-cell clip so name + tag + bloom can never escape the cell.
    ctx.save();
    roundRect(ctx, x, y, cellW, cellH, 6);
    ctx.clip();

    // Card base
    ctx.fillStyle = SURFACE.panelBg;
    ctx.fillRect(x, y, cellW, cellH);
    if (c.status !== 'untouched') {
      ctx.fillStyle = tone + '14';
      ctx.fillRect(x, y, cellW, cellH);
    }

    // Locked cells get a continuous breathing bloom.
    if (c.status === 'locked') {
      const phase = t * Math.PI * 2 + i * 0.6;
      const pulse = (Math.sin(phase) + 1) / 2;
      const bloomR = 28 + pulse * 8;
      const bcx = x + cellW / 2;
      const bcy = y + cellH / 2;
      const halo = ctx.createRadialGradient(bcx, bcy, 0, bcx, bcy, bloomR);
      const alphaHex = Math.floor(36 + pulse * 36).toString(16).padStart(2, '0');
      halo.addColorStop(0, tone + alphaHex);
      halo.addColorStop(1, tone + '00');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(bcx, bcy, bloomR, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // Top-right state tag (mini pill, separate row from the name).
    {
      const tagFont = 'bold 8px ' + TYPE.mono;
      ctx.save();
      ctx.font = tagFont;
      ctx.textAlign = 'left';
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
      ctx.fillStyle = tone;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '1.0px';
      ctx.fillText(stateTag, tagX + 6, tagY + 10);
      ctx.restore();
    }

    // Lock glyph (vertically aligned with the name row, not the tag row).
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

    // Row 1: channel name.
    ctx.save();
    ctx.font = 'bold 13px ' + TYPE.mono;
    ctx.fillStyle = c.status === 'untouched' ? SURFACE.text : tone;
    ctx.textAlign = 'left';
    const nameBudget = cellW - 32 - 12;
    const nameStr = fitText(ctx, '#' + c.name, nameBudget);
    ctx.fillText(nameStr, x + 34, y + 42);
    ctx.restore();

    // Row 2: caption (dim, full clearance below the name).
    ctx.save();
    ctx.font = '500 10px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.textDim;
    ctx.textAlign = 'left';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.4px';
    const captionBudget = cellW - 34 - 12;
    const captionStr = fitText(ctx, caption, captionBudget);
    ctx.fillText(captionStr, x + 34, y + 60);
    ctx.restore();

    ctx.restore(); // unclip

    // Border on top of clip boundary.
    ctx.save();
    ctx.strokeStyle = c.status === 'untouched' ? SURFACE.panelBorder : tone + '88';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, cellW, cellH, 6);
    ctx.stroke();
    ctx.restore();
  }

  function drawScanBeam(ctx, t) {
    // A vertical band of light sweeps left-to-right across the whole canvas.
    const beamX = (t * (W + 80)) - 40;
    const grad = ctx.createLinearGradient(beamX - 40, 0, beamX + 40, 0);
    grad.addColorStop(0,   '#FFFFFF00');
    grad.addColorStop(0.5, '#FFFFFF18');
    grad.addColorStop(1,   '#FFFFFF00');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad;
    ctx.fillRect(0, headerH, W, H - headerH);
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
