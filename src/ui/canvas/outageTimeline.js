/**
 * Outage report timeline — used in the staff review embed only.
 * Plots cumulative distinct-reporter count over the 10-minute rolling window
 * with a threshold band; reports above the threshold trigger auto-actions.
 *
 * @param {Object} data
 * @param {Array<{t:number,user:string,conf:number}>} data.reports  t in minutes (0..windowMin)
 * @param {number} data.threshold      reports needed to trigger (default 4)
 * @param {number} data.windowMin      window in minutes (default 10)
 * @returns {Buffer} PNG buffer
 */
function renderOutageTimeline({ reports = [], threshold = 4, windowMin = 10 } = {}) {
  const { makeCanvas, toBuffer, gridBackground, text,
          EMBED_WIDTH, SURFACE, STATUS, ACCENT, TYPE } = require('./_theme');

  const W = EMBED_WIDTH, H = 180;
  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  const padL = 36, padR = 16, padT = 24, padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // Cumulative distinct-user series
  const seen = new Set();
  const series = reports.map((p) => {
    seen.add(p.user);
    return { t: p.t, n: seen.size, ...p };
  });

  const yMax = Math.max(threshold + 2, 6);
  const xFor = (t) => padL + (t / windowMin) * plotW;
  const yFor = (n) => padT + plotH - (n / yMax) * plotH;

  // Section label
  text(ctx, 'REPORT WINDOW · 10 MIN ROLLING', padL, 14, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });

  // Threshold band (above threshold = trigger zone)
  ctx.fillStyle = STATUS.down.hex + '14';
  ctx.fillRect(padL, padT, plotW, yFor(threshold) - padT);

  // Threshold line
  ctx.strokeStyle = STATUS.down.hex;
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, yFor(threshold));
  ctx.lineTo(W - padR, yFor(threshold));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  text(ctx, `TRIGGER ≥ ${threshold}`, W - padR - 4, yFor(threshold) - 4, {
    font: '9px ' + TYPE.mono, color: STATUS.down.hex, align: 'right',
  });

  // Y-axis labels
  for (const n of [0, 2, 4, 6]) {
    if (n > yMax) continue;
    text(ctx, String(n), padL - 6, yFor(n) + 3, {
      font: '9px ' + TYPE.mono, color: SURFACE.textDim, align: 'right',
    });
  }

  if (series.length > 0) {
    // Area under curve — use ACCENT for chart line (informational, not status)
    // Wait — we said graphs use status palette. The cumulative line conveys
    // "approach to trigger" — info color (blue) is the right call here.
    const lineColor = STATUS.info.hex;
    ctx.beginPath();
    series.forEach((p, i) => {
      const x = xFor(p.t), y = yFor(p.n);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    // Close to baseline for fill
    const last = series[series.length - 1];
    ctx.lineTo(xFor(last.t), padT + plotH);
    ctx.lineTo(xFor(series[0].t), padT + plotH);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    fill.addColorStop(0, lineColor + '66');
    fill.addColorStop(1, lineColor + '00');
    ctx.fillStyle = fill;
    ctx.fill();

    // Curve
    ctx.beginPath();
    series.forEach((p, i) => {
      const x = xFor(p.t), y = yFor(p.n);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Markers — turn red once threshold reached
    series.forEach((p, i) => {
      const triggered = p.n >= threshold;
      ctx.fillStyle = triggered ? STATUS.down.hex : lineColor;
      ctx.strokeStyle = '#0E0F12';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(xFor(p.t), yFor(p.n), 4, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();

      text(ctx, `u${i + 1}`, xFor(p.t), padT + plotH + 14, {
        font: '8px ' + TYPE.mono, color: SURFACE.textDim, align: 'center',
      });
      text(ctx, `${p.conf}%`, xFor(p.t), padT + plotH + 24, {
        font: '8px ' + TYPE.mono,
        color: triggered ? STATUS.down.hex : SURFACE.textDim,
        align: 'center',
      });
    });

    // Trigger callout
    const trig = series.find((p) => p.n >= threshold);
    if (trig) {
      const x = xFor(trig.t);
      ctx.strokeStyle = STATUS.down.hex;
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([2, 2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, padT); ctx.lineTo(x, yFor(trig.n));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = STATUS.down.hex + '26';
      ctx.fillRect(x + 6, padT + 4, 76, 16);
      text(ctx, '⚡ TRIGGERED', x + 10, padT + 15, {
        font: 'bold 9px ' + TYPE.mono, color: STATUS.down.hex,
      });
    }
  }

  return toBuffer(canvas);
}

module.exports = { renderOutageTimeline };
