/**
 * 5-system Jarvis scorecard. Vertical bars per system, color by status.
 *
 * @param {Object} data
 * @param {Array<{key:string,score:number,status:'ok'|'warn'|'fail',detail:string}>} data.systems
 * @returns {Buffer} PNG buffer
 */
function renderScorecard({ systems } = {}) {
  const { makeCanvas, toBuffer, gridBackground, roundRect, text,
          EMBED_WIDTH, SURFACE, STATUS, TYPE } = require('./_theme');

  const s = systems && systems.length ? systems : [
    { key: 'RUNTIME',    score: 100, status: 'ok',   detail: 'gateway 42ms · 0 errors' },
    { key: 'KB',         score: 100, status: 'ok',   detail: 'v2.1.4 · 84 issues' },
    { key: 'MODERATION', score: 95,  status: 'ok',   detail: 'all guards armed' },
    { key: 'SECURITY',   score: 78,  status: 'warn', detail: 'ignorelogs missing' },
    { key: 'INTEL',      score: 100, status: 'ok',   detail: 'gemini · pulse · vt' },
  ];

  const W = EMBED_WIDTH, H = 220;
  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  const cell = (W - 32) / s.length;
  const overall = Math.round(s.reduce((a, b) => a + b.score, 0) / s.length);

  // Header
  text(ctx, 'SYSTEMS SWEEP · DIAGNOSTIC SCORECARD', 16, 16, {
    font: '600 9px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.5,
  });
  text(ctx, `OVERALL ${overall}%`, W - 16, 16, {
    font: 'bold 11px ' + TYPE.mono, color: STATUS.up.hex, align: 'right',
  });

  s.forEach((sys, i) => {
    const x = 16 + i * cell;
    const cx = x + cell / 2;
    const barH = (sys.score / 100) * 110;
    const tone = sys.status === 'fail' ? STATUS.down.hex
               : sys.status === 'warn' ? STATUS.warn.hex
               :                          STATUS.up.hex;

    // Track
    ctx.fillStyle = SURFACE.panelBg;
    ctx.strokeStyle = SURFACE.panelBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, cx - 18, 40, 36, 110, 3); ctx.fill(); ctx.stroke();

    // Fill (gradient when ok, flat when warn/fail)
    if (sys.status === 'ok') {
      const grad = ctx.createLinearGradient(0, 40 + 110, 0, 40);
      grad.addColorStop(0, tone + '33');
      grad.addColorStop(1, tone);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = tone;
      ctx.globalAlpha = 0.85;
    }
    roundRect(ctx, cx - 18, 40 + 110 - barH, 36, barH, 3); ctx.fill();
    ctx.globalAlpha = 1;

    // Score
    text(ctx, String(sys.score), cx, 40 + 110 - barH - 6, {
      font: 'bold 11px ' + TYPE.mono, color: tone, align: 'center',
    });

    // Status dot
    ctx.fillStyle = tone;
    ctx.beginPath(); ctx.arc(cx, 166, 3, 0, Math.PI * 2); ctx.fill();

    // Label
    text(ctx, sys.key, cx, 184, {
      font: 'bold 10px ' + TYPE.mono, color: SURFACE.text, align: 'center',
    });
    const trimmed = (sys.detail || '').length > 22 ? sys.detail.slice(0, 22) + '…' : (sys.detail || '');
    text(ctx, trimmed, cx, 200, {
      font: '8.5px ' + TYPE.mono, color: SURFACE.textDim, align: 'center',
    });
  });

  return toBuffer(canvas);
}

module.exports = { renderScorecard };
