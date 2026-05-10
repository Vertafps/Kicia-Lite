/**
 * KB embeds — strong match (editorial) and no-match (human-handoff).
 *
 *   buildKbMatchEmbed     — confident hit; show numbered steps + editorial card.
 *   buildKbNoMatchEmbed   — no/weak hit; lead with "let's get a human" routing.
 *
 * Layout (matches Carrot design):
 *   - Title:   the article title or the no-match handoff line.
 *   - Header strip:  small ANSI tag line at the top of the description showing
 *                    `[OK] match · 0.97 · kb.json`. No more "$ kb lookup …"
 *                    redundancy — the question is already on screen above.
 *   - Steps:   numbered "**1. Title**\n   `code/inline samples`" list.
 *   - Image:   editorial card (left stripe + title + step indicator + CTA).
 *   - Footer:  brand line + source.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderKbEditorial } = require('../canvas/kbEditorial');
const { renderKbEditorialAnimated } = require('../canvas/kbEditorialAnimated');
const { renderConfidenceMeter } = require('../canvas/confidenceMeter');
const { renderKbNoMatchAnimated } = require('../canvas/kbNoMatchAnimated');
const { ANIMATED_HEROES } = require('../../config');
const { recordRuntimeEvent } = require('../../runtime-health');

function renderKbMatchHero(opts) {
  if (ANIMATED_HEROES) {
    try {
      return { buffer: renderKbEditorialAnimated(opts), animated: true };
    } catch (err) {
      recordRuntimeEvent('warn', 'animated-hero-kb-match', err?.message || err);
    }
  }
  return { buffer: renderKbEditorial(opts), animated: false };
}

function renderKbNoMatchHero(opts) {
  if (ANIMATED_HEROES) {
    try {
      return { buffer: renderKbNoMatchAnimated(opts), animated: true };
    } catch (err) {
      recordRuntimeEvent('warn', 'animated-hero-kb-nomatch', err?.message || err);
    }
  }
  return { buffer: renderConfidenceMeter(opts), animated: false };
}

// ── Strong match ────────────────────────────────────────────────────────────

function buildKbMatchEmbed({
  question = '', title = 'Untitled',
  tag = 'EXECUTOR · FIX',
  steps = [], step = 1,
  match = 0.92,
  source = 'kb.json',
  url, // optional canonical link
  body, // optional intro paragraph that sits above the steps
} = {}) {

  const total = Math.max(steps.length, 1);
  const previewLine = pickPreviewLine(steps, body);
  const hero = renderKbMatchHero({ title, tag, step, total, match, preview: previewLine });
  const ext = hero.animated ? 'gif' : 'png';
  const filename = `kb-card.${ext}`;
  const img = new AttachmentBuilder(hero.buffer, { name: filename });

  const headerStrip = block([
    line(A.okTag(), A.boldGreen(`match · ${match.toFixed(2)}`), A.dim('· source ' + source)),
  ]);

  // Numbered steps. If a step contains a `code` snippet we render it on a
  // second indented line so the eye can pick it out. Otherwise the step text
  // sits inline with the number.
  const stepsList = steps.length
    ? steps.map((s, i) => formatStep(i + 1, s)).join('\n\n')
    : '_no steps provided_';

  const introBlock = body && body.trim() ? body.trim() : null;

  const description = [
    headerStrip,
    introBlock,
    stepsList,
  ].filter(Boolean).join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(ACCENT.int)
    .setAuthor({ name: `${BRAND.botName} · KB` })
    .setTitle(title)
    .setURL(url || null)
    .setDescription(description)
    .setImage(`attachment://${filename}`)
    .setFooter({ text: `${BRAND.footerLine} · source ${source}` });

  const components = [];
  if (url) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Open full guide')
        .setEmoji('📖')
        .setStyle(ButtonStyle.Link)
        .setURL(url),
    );
    components.push(row);
  }

  return { embeds: [embed], components, files: [img] };
}

// ── No-match · "let's get a human" ──────────────────────────────────────────

function buildKbNoMatchEmbed({
  question = '',
  score = 38,
  supportInviteUrl,        // discord.gg/...
  ticketUrl,               // forms link / portal
  closestArticles = [],    // [{title, match}]
} = {}) {

  const hero = renderKbNoMatchHero({ score, label: 'no-match' });
  const ext = hero.animated ? 'gif' : 'png';
  const filename = `kb-meter.${ext}`;
  const img = new AttachmentBuilder(hero.buffer, { name: filename });

  const intro =
    "I couldn't find anything in the knowledge base that matches your message confidently.";
  const nextStep = '**Best next step:** open a ticket — staff will pick it up there.';

  const route = [
    '**→ Step 1**\nOpen a ticket — a moderator will pick it up directly.',
    '**→ Step 2**\nMention this question and include any error messages.',
    '**→ Step 3**\nDrop a screenshot of the screen when it sits there.',
  ].join('\n\n');

  const closestBlock = closestArticles.length
    ? '**Closest KB guess**\n' +
      closestArticles.slice(0, 3).map((a) =>
        `· _${a.title}_ — ${(a.match * 100).toFixed(0)}% · below threshold`
      ).join('\n')
    : null;

  const description = [intro, nextStep, route, closestBlock].filter(Boolean).join('\n\n');

  const embed = new EmbedBuilder()
    .setColor(STATUS.warn.int)
    .setAuthor({ name: `${BRAND.botName} · KB · no match` })
    .setTitle("Let's get a human on it.")
    .setDescription(description)
    .setImage(`attachment://${filename}`)
    .setFooter({ text: BRAND.footerLine });

  const buttons = [];
  if (supportInviteUrl) buttons.push(
    new ButtonBuilder()
      .setLabel('Join support server')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Link)
      .setURL(supportInviteUrl),
  );
  if (ticketUrl) buttons.push(
    new ButtonBuilder()
      .setLabel('Open ticket')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Link)
      .setURL(ticketUrl),
  );
  const components = buttons.length
    ? [new ActionRowBuilder().addComponents(...buttons)]
    : [];

  return { embeds: [embed], components, files: [img] };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format a single step. If the step text contains an inline-code span (`...`),
 * keep it; otherwise leave plain. We also pull a leading short "Title:" or
 * **Bold:** prefix into the bold line and let the rest become the body.
 */
function formatStep(number, step) {
  const text = String(step || '').trim();
  if (!text) return `**${number}.** _(no detail)_`;

  // Step shape: "Bold heading: rest of explanation"
  const colonMatch = text.match(/^\*\*([^*]{2,80})\*\*\s*[:\-]\s*([\s\S]+)$/);
  if (colonMatch) {
    return `**${number}. ${colonMatch[1].trim()}**\n${colonMatch[2].trim()}`;
  }

  // Step shape: "**Heading**\nbody" or "Heading\nbody"
  const splitNL = text.indexOf('\n');
  if (splitNL > 0 && splitNL < 80) {
    const heading = text.slice(0, splitNL).replace(/^\*\*|\*\*$/g, '').trim();
    const rest = text.slice(splitNL + 1).trim();
    if (heading && rest) return `**${number}. ${heading}**\n${rest}`;
  }

  return `**${number}.** ${text}`;
}

/**
 * Pick a short preview line for the editorial card. Prefer the first concise
 * step; fall back to the body intro if present.
 */
function pickPreviewLine(steps, body) {
  for (const s of steps || []) {
    const stripped = String(s || '').replace(/\*+/g, '').replace(/[\r\n]+/g, ' ').trim();
    if (stripped && stripped.length <= 70) return stripped;
    if (stripped) return stripped.slice(0, 67) + '…';
  }
  if (body) {
    const stripped = String(body).replace(/\*+/g, '').replace(/[\r\n]+/g, ' ').trim();
    if (stripped) return stripped.slice(0, 70);
  }
  return null;
}

module.exports = { buildKbMatchEmbed, buildKbNoMatchEmbed };
