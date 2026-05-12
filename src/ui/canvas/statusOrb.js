/**
 * Status orb + pulse strip — static PNG fallback for $status.
 *
 * v3 design (matches Design By Claude/Design/animations.jsx lines 36-160 and
 * the Status up/down/unaware screenshots):
 *
 *   - Big orb on the left (R=38, centred at 78,90).
 *   - "CURRENT STATE" + 44px state word + state-specific subtitle, right of orb.
 *   - 36-dot pulse strip below. No fake metrics, no uptime ribbon, no time
 *     markers — the design dropped those.
 *
 * Animated counterpart: statusOrbAnimated.js (loops the same composition).
 * This static variant renders one frame at t≈0.25 so the still still feels
 * alive when ANIMATED_HEROES is disabled.
 *
 * @param {Object} data
 * @param {'UP'|'DOWN'|'UNAWARE'} data.status
 * @returns {Buffer} PNG buffer
 */
function renderStatusOrbRibbon({ status = 'UP' } = {}) {
  const { makeCanvas, toBuffer, gridBackground, roundRect, text, bloom,
          EMBED_WIDTH, SURFACE, STATUS, TYPE } = require('./_theme');

  const W = EMBED_WIDTH;
  const H = 200;
  const tone =
    status === 'DOWN'    ? STATUS.down.hex :
    status === 'UNAWARE' ? STATUS.warn.hex :
                           STATUS.up.hex;

  const { canvas, ctx } = makeCanvas(W, H);
  gridBackground(ctx, W, H);

  // ── Orb ────────────────────────────────────────────────────────────────────
  const cx = 78, cy = 90, R = 38;

  // Halo — mid-pulse value for the still.
  const haloR = 64 + 8;
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
  halo.addColorStop(0, tone + (status === 'DOWN' ? '30' : '70'));
  halo.addColorStop(1, tone + '00');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

  // Disc — bright highlight top-left, fades to tone.
  const ofill = ctx.createRadialGradient(cx - 10, cy - 12, 0, cx, cy, R);
  ofill.addColorStop(0, '#FFFFFF');
  ofill.addColorStop(0.5, tone);
  ofill.addColorStop(1, tone + (status === 'DOWN' ? '22' : '55'));
  ctx.fillStyle = ofill;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = tone;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

  // Per-state overlay (static — single frame of the loop's mid-pose).
  if (status === 'UP') {
    // One sonar ring frozen mid-expand.
    const p = 0.5;
    const r = R + p * 28;
    ctx.save();
    ctx.strokeStyle = tone;
    ctx.globalAlpha = (1 - p) * 0.7;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  } else if (status === 'DOWN') {
    // Thick black X cross-out at 55% of orb radius.
    ctx.save();
    ctx.strokeStyle = '#0E0F12';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    const k = R * 0.55;
    ctx.beginPath();
    ctx.moveTo(cx - k, cy - k); ctx.lineTo(cx + k, cy + k);
    ctx.moveTo(cx + k, cy - k); ctx.lineTo(cx - k, cy + k);
    ctx.stroke();
    ctx.restore();
  } else {
    // UNAWARE: dashed ring (rotates in the animated variant).
    ctx.save();
    ctx.strokeStyle = tone;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.arc(cx, cy, R + 10, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // ── State block (right of orb) ─────────────────────────────────────────────
  const sx = 170;
  text(ctx, 'CURRENT STATE', sx, 50, {
    font: '600 9.5px ' + TYPE.mono, color: SURFACE.textDim, letterSpacing: 1.8,
  });
  text(ctx, status, sx, 96, {
    font: 'bold 44px ' + TYPE.sans, color: tone, letterSpacing: -0.5,
  });
  const subtitle = status === 'UP'      ? 'all systems nominal'
                 : status === 'DOWN'    ? 'service is offline'
                 :                         'state unconfirmed';
  text(ctx, subtitle, sx, 120, {
    font: '12px ' + TYPE.mono, color: SURFACE.textMuted, letterSpacing: 0.4,
  });

  // ── Pulse strip (36 dots, no fake metrics) ─────────────────────────────────
  const px = 16, py = 156, pw = W - 32, ph = 28;
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.globalAlpha = 0.4;
  roundRect(ctx, px, py, pw, ph, 4); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = SURFACE.panelBorder;
  ctx.lineWidth = 1;
  roundRect(ctx, px + 0.5, py + 0.5, pw - 1, ph - 1, 4); ctx.stroke();
  ctx.restore();

  const N = 36;
  const gap = (pw - 24) / (N - 1);
  const t = 0.25; // mid-loop pose
  for (let i = 0; i < N; i++) {
    const dx = px + 12 + i * gap;
    const dy = py + ph / 2;
    let a, rad;
    if (status === 'UP') {
      const p = (t * N) % N;
      const d = Math.abs(i - p);
      const dWrap = Math.min(d, N - d);
      a = Math.max(0.18, 1 - dWrap / 6);
      rad = 1.6 + (dWrap < 1 ? 1.4 : dWrap < 3 ? 0.6 : 0);
    } else if (status === 'DOWN') {
      a = 0.22;
      rad = 1.6;
    } else {
      const seed = (Math.sin(i * 1.7) + 1) / 2;
      a = 0.2 + 0.55 * (Math.sin(seed * 4) * 0.5 + 0.5);
      rad = 1.6;
    }
    ctx.save();
    ctx.fillStyle = tone;
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.arc(dx, dy, rad, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    if (status === 'UP' && rad > 2) {
      bloom(ctx, dx, dy, 8, tone, 0.5);
    }
  }

  return toBuffer(canvas);
}

module.exports = { renderStatusOrbRibbon };
