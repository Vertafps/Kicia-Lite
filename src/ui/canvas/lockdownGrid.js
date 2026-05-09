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
  const cols = 4;
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

    // Channel name
    text(ctx, '#' + c.name, x + 32, y + 22, {
      font: 'bold 11px ' + TYPE.mono, color: SURFACE.text,
    });
    text(ctx, c.status.toUpperCase(), x + 32, y + 38, {
      font: '9px ' + TYPE.mono, color: tone, letterSpacing: 1.2,
    });
  });

  return toBuffer(canvas);
}

module.exports = { renderLockdownGrid };
