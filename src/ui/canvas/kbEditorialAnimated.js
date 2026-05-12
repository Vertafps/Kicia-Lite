/**
 * Animated KB editorial card — looping GIF for KB strong matches.
 *
 * Design rule: card is fully readable in every frame. Animation is a thin
 * shimmer band traveling across the card and a soft breathing glow on the
 * "open full guide" CTA. No slide-in, no fade-up — content sits at its final
 * position from frame 0 onwards.
 */

const { ACCENT, SURFACE, TYPE } = require('../colors');
const { renderGif, easeInOutSine, easeOutQuint } = require('./_animation');

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
    drawTitleReticle(ctx, t);
    drawShimmerBand(ctx, t);
  }

  // Title reticle — corner brackets that snap from a wide search box to a
  // tight hug around the title between t=0..0.55, then sit settled. Gives the
  // card a "scope locked on this answer" feel.
  function drawTitleReticle(ctx, t) {
    const panelW = 150;
    const rx = panelW + 24;
    const rRight = W - 16;
    const rW = rRight - rx;

    // Measure title for tight bounds.
    ctx.save();
    ctx.font = 'bold 16px ' + TYPE.sans;
    const titleText = fitText(ctx, title, rW);
    const titleW = Math.min(ctx.measureText(titleText).width, rW);
    ctx.restore();

    const tightX = rx - 4;
    const tightY = 50;
    const tightW = titleW + 8;
    const tightH = 22;

    const wideX = rx - 12;
    const wideY = 44;
    const wideW = rW + 8;
    const wideH = 34;

    // Lock-on progress 0..1 over t=[0, 0.55], settled afterwards.
    const lockT = Math.min(1, Math.max(0, t / 0.55));
    const eased = easeOutQuint(lockT);
    const x = wideX + (tightX - wideX) * eased;
    const y = wideY + (tightY - wideY) * eased;
    const w = wideW + (tightW - wideW) * eased;
    const h = wideH + (tightH - wideH) * eased;

    // Bracket arm length grows slightly as it locks.
    const arm = 6 + 4 * eased;
    const alpha = 0.35 + 0.45 * eased;

    ctx.save();
    ctx.strokeStyle = ACCENT.hex;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';

    // Top-left
    ctx.beginPath();
    ctx.moveTo(x, y + arm); ctx.lineTo(x, y); ctx.lineTo(x + arm, y);
    ctx.stroke();
    // Top-right
    ctx.beginPath();
    ctx.moveTo(x + w - arm, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + arm);
    ctx.stroke();
    // Bottom-left
    ctx.beginPath();
    ctx.moveTo(x, y + h - arm); ctx.lineTo(x, y + h); ctx.lineTo(x + arm, y + h);
    ctx.stroke();
    // Bottom-right
    ctx.beginPath();
    ctx.moveTo(x + w - arm, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y + h - arm);
    ctx.stroke();

    ctx.restore();
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
