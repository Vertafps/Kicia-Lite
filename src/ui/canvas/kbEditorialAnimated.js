/**
 * Animated KB editorial card — looping GIF for KB strong matches.
 *
 * Design rule: card is fully readable in every frame. Animation is a thin
 * shimmer band traveling across the card and a soft breathing glow on the
 * "open full guide" CTA. No slide-in, no fade-up — content sits at its final
 * position from frame 0 onwards.
 */

const { ACCENT, SURFACE, TYPE } = require('../colors');
const { renderGif, easeInOutSine } = require('./_animation');

function renderKbEditorialAnimated({
  title = 'Untitled', tag = 'KB', step = 1, total = 1, match = 0.9, preview,
} = {}) {
  const W = 480, H = 180;
  const matchPct = Math.round(Math.max(0, Math.min(1, match)) * 100);

  return renderGif((ctx, t) => drawFrame(ctx, t), { width: W, height: H });

  function drawFrame(ctx, t) {
    drawBackground(ctx);
    drawAccentPanel(ctx, t);
    drawRightColumn(ctx, t);
    drawShimmerBand(ctx, t);
  }

  function drawBackground(ctx) {
    const wash = ctx.createLinearGradient(0, 0, W, H);
    wash.addColorStop(0, ACCENT.hex + '24');
    wash.addColorStop(1, ACCENT.hex + '00');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);
  }

  function drawAccentPanel(ctx, t) {
    const panelW = 150;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, panelW, H); ctx.clip();

    // Solid panel wash — colored backdrop.
    ctx.fillStyle = ACCENT.hex;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(0, 0, panelW, H);

    // Diagonal stripes — drift slowly to add subtle motion.
    ctx.globalAlpha = 0.20;
    const drift = (t * 16) % 8; // 8px stride; one cycle per ~0.5s
    for (let s = -H + drift; s < W + H; s += 8) {
      ctx.fillRect(s, -10, 1.5, H + 20);
    }
    ctx.restore();

    ctx.strokeStyle = ACCENT.hex + '55';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, panelW - 1, H - 1);

    // KB mark + category caption — always visible.
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

  function drawRightColumn(ctx, t) {
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

    // Title — full text, readable from frame 0.
    ctx.save();
    ctx.font = 'bold 16px ' + TYPE.sans;
    ctx.fillStyle = SURFACE.text;
    ctx.fillText(fitText(ctx, title, rW), rx, 65);
    ctx.restore();

    // Solid accent rule under the title.
    ctx.save();
    const ruleGrad = ctx.createLinearGradient(rx, 0, rRight, 0);
    ruleGrad.addColorStop(0, ACCENT.hex);
    ruleGrad.addColorStop(1, ACCENT.hex + '20');
    ctx.fillStyle = ruleGrad;
    ctx.fillRect(rx, 71, rW, 1.5);
    ctx.restore();

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

    // Match meta — final value, no tween.
    ctx.save();
    ctx.font = '600 10px ' + TYPE.mono;
    ctx.fillStyle = SURFACE.text;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.6px';
    ctx.fillText(`match · ${matchPct}%`, rx, H - 30);
    ctx.fillStyle = SURFACE.textMuted;
    ctx.font = '10px ' + TYPE.mono;
    ctx.fillText('· source · kb.json', rx + 92, H - 30);
    ctx.restore();

    ctx.strokeStyle = SURFACE.panelBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx, H - 22); ctx.lineTo(rRight, H - 22); ctx.stroke();

    // CTA — gentle alpha breathe so it pulls the eye without flickering away.
    const breathe = (Math.sin(t * Math.PI * 2) + 1) / 2;
    const ctaAlpha = 0.78 + breathe * 0.22;
    ctx.save();
    ctx.font = 'bold 10px ' + TYPE.mono;
    ctx.fillStyle = ACCENT.hex;
    ctx.globalAlpha = ctaAlpha;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.5px';
    ctx.fillText('→ open full guide', rx, H - 8);
    ctx.restore();
  }

  function drawShimmerBand(ctx, t) {
    // A thin band of light slides L→R across the right column once per loop.
    const panelW = 150;
    const startX = panelW;
    const endX = W;
    const bandX = startX + (endX - startX) * easeInOutSine(t) - 30;
    const grad = ctx.createLinearGradient(bandX - 30, 0, bandX + 30, 0);
    grad.addColorStop(0,   '#FFFFFF00');
    grad.addColorStop(0.5, '#FFFFFF20');
    grad.addColorStop(1,   '#FFFFFF00');
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = grad;
    ctx.fillRect(panelW, 0, W - panelW, H);
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
