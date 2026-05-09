/**
 * KB embeds — strong match (editorial) and no-match (human-handoff).
 *
 *   buildKbMatchEmbed     — confident hit; show editorial card with article link.
 *   buildKbNoMatchEmbed   — no/weak hit; lead with "let's get a human" routing.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderKbEditorial } = require('../canvas/kbEditorial');
const { renderConfidenceMeter } = require('../canvas/confidenceMeter');

// ── Strong match ────────────────────────────────────────────────────────────

function buildKbMatchEmbed({
  question = '', title = 'Untitled',
  tag = 'EXECUTOR · FIX',
  steps = [], step = 1,
  match = 0.92,
  source = 'kb.json',
  url, // optional canonical link
} = {}) {

  const total = Math.max(steps.length, 1);
  const buf = renderKbEditorial({ title, tag, step, total, match });
  const img = new AttachmentBuilder(buf, { name: 'kb-card.png' });

  const head = block([
    line(A.dim('$'), A.cyan('kb'), A.white('lookup'), A.dim(`"${truncate(question, 40)}"`)),
    line(A.okTag(), A.boldGreen(`match · ${match.toFixed(2)}`), A.dim('· ' + source)),
  ]);

  // Format steps as numbered list
  const stepsList = steps.length
    ? steps.map((s, i) => `**${i + 1}.** ${s}`).join('\n')
    : '_no steps provided_';

  const embed = new EmbedBuilder()
    .setColor(ACCENT.int)
    .setAuthor({ name: `${BRAND.botName} · KB` })
    .setTitle(title)
    .setURL(url || null)
    .setDescription(head + '\n\n' + stepsList)
    .setImage('attachment://kb-card.png')
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

  const buf = renderConfidenceMeter({ score, label: 'no-match' });
  const img = new AttachmentBuilder(buf, { name: 'kb-meter.png' });

  const head = block([
    line(A.dim('$'), A.cyan('kb'), A.white('lookup'), A.dim(`"${truncate(question, 40)}"`)),
    line(A.warnTag(), A.boldYellow(`no strong match · ${score}% confidence`)),
    line(A.dim('//'), A.dim('escalating to human support')),
  ]);

  const route = [
    '**1.** Join the KiciaHook support server and post in `#help`.',
    '**2.** Or open a ticket — a moderator will pick it up directly.',
    '**3.** Mention this question and we\'ll get you sorted.',
  ].join('\n');

  const closestBlock = closestArticles.length
    ? closestArticles.slice(0, 3).map((a) =>
        `· *${a.title}* · ${(a.match * 100).toFixed(0)}%`
      ).join('\n')
    : null;

  const embed = new EmbedBuilder()
    .setColor(STATUS.warn.int)
    .setAuthor({ name: `${BRAND.botName} · KB · no match` })
    .setTitle('Let\'s get a human on it.')
    .setDescription(head + '\n\n' + route)
    .setImage('attachment://kb-meter.png')
    .setFooter({ text: BRAND.footerLine });

  if (closestBlock) {
    embed.addFields({ name: 'Closest articles (low confidence)', value: closestBlock });
  }

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

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { buildKbMatchEmbed, buildKbNoMatchEmbed };
