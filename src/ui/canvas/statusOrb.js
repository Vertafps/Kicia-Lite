/**
 * Status orb + 24h uptime ribbon.
 *
 * Renders a pulsing-orb rendition of the bot's current state plus a 96-cell
 * ribbon (15-min slots over 24h) showing per-slot status. Used by:
 *   - $status
 *   - outage public alert
 *   - false-alarm "all clear"
 *
 * @param {Object} data
 * @param {'UP'|'DOWN'|'UNAWARE'} data.status
 * @param {number} data.uptime           24h uptime % (e.g. 99.94)
 * @param {Array<'up'|'down'|'unaware'>} data.ribbon  length 96
 * @returns {Buffer} PNG buffer
 */
function renderStatusOrbRibbon({ status = 'UP', uptime = 99.94, ribbon } = {}) {
  const { makeCanvas, toBuffer, gridBackground, text, sectionLabel,
          EMBED_WIDTH, SURFACE, STATUS, TYPE } = require('./_theme');

  const W = EMBED_WIDTH, H = 200;
  const { canvas, ctx } = makeCanvas(W, H);

  // Background grid
  gridBackground(ctx, W, H);

  // Tone — orb color tracks status, NOT accent
  const tone =
    status === 'DOWN'    ? STATUS.down.hex :
    status === 'UNAWARE' ? STATUS.warn.hex :
                           STATUS.up.hex;

  // ── Pulsing rings + orb ────────────────────────────────────────────────
  const cx = 60, cy = 70;
  // Outer glow
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 50);
  glow.addColorStop(0, tone + '88');
  glow.addColorStop(1, tone + '00');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(cx, cy, 50, 0, Math.PI * 2); ctx.fill();

  // Concentric rings
  ctx.strokeStyle = tone;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.3;
  ctx.beginPath(); ctx.arc(cx, cy, 42, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 0.5;
  ctx.beginPath(); ctx.arc(cx, cy, 36, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;

  // Orb fill (radial gradient — bright top-left, falls off)
  const orbFill = ctx.createRadialGradient(cx - 8, cy - 10, 0, cx, cy, 28);
  orbFill.addColorStop(0,    '#FFFFFF');
  orbFill.addColorStop(0.4,  tone);
  orbFill.addColorStop(1,    tone + '4D');
  ctx.fillStyle = orbFill;
  ctx.beginPath(); ctx.arc(cx, cy, 28, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = tone;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, 28, 0, Math.PI * 2); ctx.stroke();

  // Crosshair ticks
  ctx.strokeStyle = tone;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.2;
  for (const a of [0, 90, 180, 270]) {
    const r = a * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(cx + 36 * Math.cos(r), cy + 36 * Math.sin(r));
    ctx.lineTo(cx + 44 * Math.cos(r), cy + 44 * Math.sin(r));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ── Status text block to right of orb ──────────────────────────────────
  text(ctx, 'CURRENT', 130, 50, {
    font: '600 10px ' + TYPE.mono,
    color: SURFACE.textDim,
    letterSpacing: 1.5,
  });
  text(ctx, status, 130, 84, {
    font: 'bold 32px ' + TYPE.sans,
    color: tone,
  });
  text(ctx, `uptime · ${uptime.toFixed(2)}% (24h)`, 130, 104, {
    font: '11px ' + TYPE.mono,
    color: SURFACE.text + 'B3',
  });

  // ── Ribbon ─────────────────────────────────────────────────────────────
  const data = ribbon && ribbon.length === 96 ? ribbon : Array(96).fill('up');
  const ribX = 16, ribY = 130, ribW = W - 32, ribH = 26;
  const cell = ribW / data.length;

  text(ctx, '24H UPTIME RIBBON', ribX, ribY - 8, {
    font: '600 9px ' + TYPE.mono,
    color: SURFACE.textDim,
    letterSpacing: 1.5,
  });
  text(ctx, '96 slots · 15m each', W - 16, ribY - 8, {
    font: '9px ' + TYPE.mono,
    color: SURFACE.textDim,
    align: 'right',
  });

  for (let i = 0; i < data.length; i++) {
    const s = data[i];
    ctx.fillStyle =
      s === 'down'    ? STATUS.down.hex :
      s === 'unaware' ? STATUS.warn.hex :
                        STATUS.up.hex;
    ctx.globalAlpha = s === 'up' ? 0.85 : 1;
    ctx.fillRect(ribX + i * cell, ribY, cell - 0.8, ribH);
  }
  ctx.globalAlpha = 1;

  // Hour ticks
  for (const h of [0, 6, 12, 18, 24]) {
    const x = ribX + (h / 24) * (data.length * cell);
    ctx.strokeStyle = SURFACE.textDim;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, ribY + ribH + 1); ctx.lineTo(x, ribY + ribH + 5); ctx.stroke();
    text(ctx, `${String(h).padStart(2, '0')}:00`, x, ribY + ribH + 16, {
      font: '9px ' + TYPE.mono,
      color: SURFACE.textDim,
      align: 'center',
    });
  }

  return toBuffer(canvas);
}

module.exports = { renderStatusOrbRibbon };
