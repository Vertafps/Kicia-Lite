/**
 * Animated KB editorial card — APNG looping hero for KB strong matches.
 *
 * Animation:
 *  - First half of the loop: card slides in from below + fades up.
 *  - The accent rule beneath the title wipes left-to-right.
 *  - The match-score percentage tweens 0 → final value.
 *  - Steady state for the second half so readers can register the content.
 */

const { ACCENT, SURFACE, TYPE } = require('../colors');
const { renderApng, easeOutQuint, smoothstep } = require('./_animation');

function renderKbEditorialAnimated({
  title = 'Untitled', tag = 'KB', step = 1, total = 1, match = 0.9, preview,
} = {}) {
  const W = 480, H = 180;
  const matchPct = Math.round(Math.max(0, Math.min(1, match)) * 100);

  return renderApng((ctx, t) => {
    drawFrame(ctx, t);
  }, { width: W, height: H });

  function drawFrame(ctx, t) {
    // Front-loaded entrance: settles by t=0.55 and stays for the rest of the loop.
    const intro = easeOutQuint(Math.min(1, t / 0.55));
    const wipe = smoothstep(Math.min(1, (t - 0.15) / 0.45));
    const tween = easeOutQuint(Math.min(1, (t - 0.2) / 0.55));

    // Background wash (static)
    const wash = ctx.createLinearGradient(0, 0, W, H);
    wash.addColorStop(0, ACCENT.hex + '24');
    wash.addColorStop(1, ACCENT.hex + '00');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);

    // Card slides up + fades in
    const lift = (1 - intro) * 28;
    ctx.save();
    ctx.translate(0, lift);
    ctx.globalAlpha = intro;

    drawAccentPanel(ctx);
    drawRightColumn(ctx, wipe, tween);

    ctx.restore();
  }

  function drawAccentPanel(ctx) {
    const panelW = 150;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, panelW, H); ctx.clip();
    ctx.fillStyle = ACCENT.hex;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(0, 0, panelW, H);
    ctx.globalAlpha = 0.20;
    for (let s = -H; s < W + H; s += 8) ctx.fillRect(s, -10, 1.5, H + 20);
    ctx.restore();
    ctx.strokeStyle = ACCENT.hex + '55';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, panelW - 1, H - 1);

    ctx.save();
    ctx.font = 'bold 28px ' + TYPE.sans;
    ctx.fillStyle = ACCENT.hex;
    ctx.textAlign = 'center';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
    ctx.fillText('KB', panelW / 2, H / 2 - 4);

    const category = String(tag).split(/[· ]+/)[0].trim() || 'KB';
    ctx.font = '600 9px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.text;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
    ctx.fillText(category, panelW / 2, H / 2 + 14);
    ctx.restore();
  }

  function drawRightColumn(ctx, wipe, tween) {
    const panelW = 150;
    const rx = panelW + 24;
    const rRight = W - 16;
    const rW = rRight - rx;

    // Tag pill
    ctx.save();
    ctx.font = 'bold 9px ' + TYPE.mono;
    const tagW = Math.min(ctx.measureText(tag).width + 14, rW);
    ctx.fillStyle = ACCENT.hex + '2E';
    ctx.strokeStyle = ACCENT.hex + '88';
    ctx.lineWidth = 0.8;
    ctx.fillRect(rx, 22, tagW, 18);
    ctx.strokeRect(rx + 0.5, 22.5, tagW, 18);
    ctx.fillStyle = ACCENT.hex;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.4px';
    ctx.fillText(tag, rx + 7, 35);
    ctx.restore();

    // Title (truncated to fit)
    ctx.save();
    ctx.font = 'bold 16px ' + TYPE.sans;
    ctx.fillStyle = SURFACE.text;
    const fittedTitle = fitText(ctx, title, rW);
    ctx.fillText(fittedTitle, rx, 65);
    ctx.restore();

    // Accent rule wipes L→R underneath the title
    if (wipe > 0) {
      ctx.save();
      const wipeW = rW * wipe;
      const grad = ctx.createLinearGradient(rx, 0, rx + wipeW, 0);
      grad.addColorStop(0, ACCENT.hex + '00');
      grad.addColorStop(0.4, ACCENT.hex + 'AA');
      grad.addColorStop(1, ACCENT.hex);
      ctx.fillStyle = grad;
      ctx.fillRect(rx, 71, wipeW, 1.5);
      ctx.restore();
    }

    // Preview line
    if (preview) {
      ctx.save();
      ctx.font = '11px ' + TYPE.sans;
      ctx.fillStyle = SURFACE.textMuted;
      ctx.fillText(fitText(ctx, String(preview), rW), rx, 84);
      ctx.restore();
    }

    // Step indicator
    ctx.save();
    ctx.font = '600 9px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.textMuted;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1.6px';
    ctx.fillText(`STEP ${step} OF ${total}`, rx, 108);
    ctx.restore();

    const segmentMax = Math.min(total, 8);
    const segGap = 4;
    const segW = Math.min(20, (rW - segGap * (segmentMax - 1)) / segmentMax);
    for (let i = 0; i < segmentMax; i++) {
      ctx.fillStyle = i < step ? ACCENT.hex : SURFACE.panelBorder;
      ctx.fillRect(rx + i * (segW + segGap), 116, segW, 4);
    }

    // Match meta — number tweens up
    const livePct = Math.round(matchPct * tween);
    ctx.save();
    ctx.font = '600 10px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.text;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.6px';
    ctx.fillText(`match · ${livePct}%`, rx, H - 30);
    ctx.fillStyle = SURFACE.textMuted;
    ctx.font = '10px ' + TYPE.mono;
    ctx.fillText('· source · kb.json', rx + 92, H - 30);
    ctx.restore();

    ctx.strokeStyle = SURFACE.panelBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx, H - 22); ctx.lineTo(rRight, H - 22); ctx.stroke();

    ctx.save();
    ctx.font = 'bold 10px ' + TYPE.mono;
    ctx.fillStyle = ACCENT.hex;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.5px';
    ctx.fillText('→ open full guide', rx, H - 8);
    ctx.restore();
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

module.exports = { renderKbEditorialAnimated };
