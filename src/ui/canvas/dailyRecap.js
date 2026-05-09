/**
 * Daily recap — donut (event mix) + 24h activity bar chart.
 *
 * @param {Object} data
 * @param {Array<{label:string,value:number,color?:string}>} data.slices
 * @param {Array<number>} data.activity     length 24
 * @param {number?} data.outageHour          0..23 marker, optional
 * @returns {Buffer} PNG buffer
 */
function renderDailyRecap({ slices, activity, outageHour } = {}) {
  const { makeCanvas, toBuffer, gridBackground, text,
          EMBED_WIDTH, SURFACE, STATUS, TYPE } = require('./_theme');

  const sl = slices && slices.length ? slices : [
    { label: 'Help Replied',   value: 64 },
    { label: 'Scam Cleared',   value: 18 },
    { label: 'Scam Confirmed', value: 8  },
    { label: 'Status Pings',   value: 24 },
  ];
  // Default colors come from STATUS palette (data-viz, not accent)
  const palette = [STATUS.up.hex, STATUS.warn.hex, STATUS.down.hex, STATUS.info.hex];
  sl.forEach((s, i) => { if (!s.color) s.color = palette[i % palette.length]; });

  const a = activity && activity.length === 24
    ? activity
    : Array.from({ length: 24 }, (_, i) => Math.round(20 + 30 * Math.sin(i / 3) + 10));

  const W = EMBED_WIDTH, H = 200;
  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  // Section labels
  text(ctx, 'MIX', 20, 16, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });
  text(ctx, '24H ACTIVITY', 160, 16, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });

  // ── Donut ──────────────────────────────────────────────────────────────
  const cx = 70, cy = 100, R = 50, r = 32;
  const total = sl.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;

  sl.forEach((s) => {
    const start = acc / total * Math.PI * 2 - Math.PI / 2;
    acc += s.value;
    const end = acc / total * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, start, end);
    ctx.arc(cx, cy, r, end, start, true);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.globalAlpha = 0.92;
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // Center number
  text(ctx, String(total), cx, cy + 5, {
    font: 'bold 20px ' + TYPE.sans, color: SURFACE.text, align: 'center',
  });
  text(ctx, 'EVENTS', cx, cy + 18, {
    font: '9px ' + TYPE.mono, color: SURFACE.textDim, align: 'center', letterSpacing: 1.2,
  });

  // Legend (right of donut)
  sl.forEach((s, i) => {
    const ly = cy - 26 + i * 13;
    ctx.fillStyle = s.color;
    ctx.fillRect(cx + R + 6, ly, 8, 8);
    text(ctx, `${s.value} ${s.label.split(' ')[0]}`, cx + R + 18, ly + 7, {
      font: '8.5px ' + TYPE.mono, color: SURFACE.text,
    });
  });

  // ── Activity bars ──────────────────────────────────────────────────────
  const actX0 = 160, actY0 = 30, actW = W - actX0 - 16, actH = 130;
  const max = Math.max(...a, 1);
  const bw = actW / a.length;

  a.forEach((v, i) => {
    const isOutage = outageHour != null && i === outageHour;
    ctx.fillStyle = isOutage ? STATUS.down.hex : STATUS.info.hex;
    ctx.globalAlpha = isOutage ? 1 : 0.7;
    const bh = (v / max) * actH;
    ctx.fillRect(actX0 + i * bw, actY0 + actH - bh, bw - 1, bh);
  });
  ctx.globalAlpha = 1;

  // Outage marker
  if (outageHour != null) {
    const x = actX0 + outageHour * bw + bw / 2;
    ctx.strokeStyle = STATUS.down.hex;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([2, 2]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, actY0 - 8); ctx.lineTo(x, actY0 + actH); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    ctx.fillStyle = STATUS.down.hex + '2E';
    ctx.fillRect(x - 36, actY0 - 18, 72, 14);
    text(ctx, `⚠ OUTAGE ${String(outageHour).padStart(2, '0')}:00`, x, actY0 - 8, {
      font: 'bold 9px ' + TYPE.mono, color: STATUS.down.hex, align: 'center',
    });
  }

  // Hour axis
  for (const h of [0, 6, 12, 18]) {
    const x = actX0 + h * bw + bw / 2;
    text(ctx, `${String(h).padStart(2, '0')}h`, x, actY0 + actH + 12, {
      font: '8.5px ' + TYPE.mono, color: SURFACE.textDim, align: 'center',
    });
  }

  return toBuffer(canvas);
}

module.exports = { renderDailyRecap };
