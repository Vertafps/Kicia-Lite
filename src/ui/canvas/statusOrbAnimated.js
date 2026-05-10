/**
 * Animated status orb + ribbon — APNG looping hero for $status.
 *
 * Animation:
 *  - Orb radius breathes (sine, ±8% over the loop).
 *  - Outer bloom intensity follows a steeper sine (more pronounced halo).
 *  - When status is UP, the 24h ribbon gets a faint shimmer that travels L→R.
 *  - Concentric rings rotate slowly via shifted dash offsets.
 *
 * Same data shape as renderStatusOrbRibbon — drop-in replacement that
 * returns an APNG Buffer instead of a static PNG.
 */

const { SURFACE, STATUS, TYPE } = require('../colors');
const { renderApng, easeInOutSine } = require('./_animation');

function renderStatusOrbRibbonAnimated({
  status = 'UP', uptime = 99.94, ribbon,
} = {}) {
  const W = 480, H = 200;
  const data = ribbon && ribbon.length === 96 ? ribbon : Array(96).fill('up');
  const tone =
    status === 'DOWN'    ? STATUS.down.hex :
    status === 'UNAWARE' ? STATUS.warn.hex :
                           STATUS.up.hex;
  const allGreen = status === 'UP' && data.every((s) => s === 'up');

  return renderApng((ctx, t) => {
    drawFrame(ctx, t);
  }, { width: W, height: H });

  function drawFrame(ctx, t) {
    drawGrid(ctx);

    const breathe = easeInOutSine((Math.sin(t * Math.PI * 2) + 1) / 2);
    const radius = 28 + breathe * 2.4;
    const bloomAlpha = 0.55 + breathe * 0.35;

    drawOrb(ctx, 60, 70, radius, tone, bloomAlpha, t);
    drawStatusText(ctx);

    drawRibbon(ctx, t);
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

  function drawOrb(ctx, cx, cy, r, color, bloomA, t) {
    // Outer halo
    const haloR = 50 + (r - 28) * 1.6;
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
    halo.addColorStop(0, color + Math.floor(bloomA * 240).toString(16).padStart(2, '0'));
    halo.addColorStop(1, color + '00');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

    // Concentric rotating rings
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.6;
    const rotate = t * Math.PI * 2;
    for (let i = 0; i < 2; i++) {
      const ringR = 36 + i * 6;
      const arcSpan = Math.PI * 1.2;
      const arcStart = rotate * (i % 2 === 0 ? 1 : -1) + i * 0.7;
      ctx.globalAlpha = 0.3 + i * 0.18;
      ctx.beginPath(); ctx.arc(cx, cy, ringR, arcStart, arcStart + arcSpan); ctx.stroke();
    }
    ctx.restore();

    // Orb body
    const orbFill = ctx.createRadialGradient(cx - 8, cy - 10, 0, cx, cy, r);
    orbFill.addColorStop(0,    '#FFFFFF');
    orbFill.addColorStop(0.4,  color);
    orbFill.addColorStop(1,    color + '4D');
    ctx.fillStyle = orbFill;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

    // Crosshair ticks
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.2;
    for (const a of [0, 90, 180, 270]) {
      const rad = a * Math.PI / 180;
      ctx.beginPath();
      ctx.moveTo(cx + (r + 8) * Math.cos(rad), cy + (r + 8) * Math.sin(rad));
      ctx.lineTo(cx + (r + 16) * Math.cos(rad), cy + (r + 16) * Math.sin(rad));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStatusText(ctx) {
    ctx.save();
    ctx.font = '600 10px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.textDim;
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
    ctx.fillText('CURRENT', 130, 50);

    ctx.font = 'bold 32px ' + TYPE.sans;
    ctx.fillStyle = tone;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillText(status, 130, 84);

    ctx.font = '11px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.text + 'B3';
    ctx.fillText(`uptime · ${uptime.toFixed(2)}% (24h)`, 130, 104);
    ctx.restore();
  }

  function drawRibbon(ctx, t) {
    const ribX = 16, ribY = 130, ribW = W - 32, ribH = 26;
    const cell = ribW / data.length;

    ctx.save();
    ctx.font = '600 9px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.textDim;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.5px';
    ctx.fillText('24H UPTIME RIBBON', ribX, ribY - 8);

    ctx.textAlign = 'right';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.fillText('96 slots · 15m each', W - 16, ribY - 8);
    ctx.restore();

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

    if (allGreen) {
      // Shimmer band traveling L→R
      const shimmerCenter = (t * (ribW + 60)) - 30;
      const grad = ctx.createLinearGradient(shimmerCenter - 30, 0, shimmerCenter + 30, 0);
      grad.addColorStop(0, '#FFFFFF00');
      grad.addColorStop(0.5, '#FFFFFF40');
      grad.addColorStop(1, '#FFFFFF00');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = grad;
      ctx.fillRect(ribX, ribY, ribW, ribH);
      ctx.restore();
    }

    // Hour ticks
    ctx.save();
    ctx.font = '9px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.textDim;
    ctx.textAlign = 'center';
    for (const h of [0, 6, 12, 18, 24]) {
      const x = ribX + (h / 24) * (data.length * cell);
      ctx.strokeStyle = SURFACE.textDim;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, ribY + ribH + 1); ctx.lineTo(x, ribY + ribH + 5); ctx.stroke();
      ctx.fillText(`${String(h).padStart(2, '0')}:00`, x, ribY + ribH + 16);
    }
    ctx.restore();
  }
}

module.exports = { renderStatusOrbRibbonAnimated };
