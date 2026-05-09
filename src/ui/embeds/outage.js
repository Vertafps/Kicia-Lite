/**
 * Outage Watch — four embeds in one module.
 *
 *   buildOutagePublic       — short alert posted in #general (no PII / no count)
 *   buildOutageStaffReview  — full review w/ timeline graph (#staff only)
 *   buildOutageConfirmed    — staff has confirmed outage; bot status switches DOWN
 *   buildOutageCleared      — false-alarm "all clear" w/ orb + green ribbon
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderOutageTimeline } = require('../canvas/outageTimeline');
const { renderStatusOrbRibbon } = require('../canvas/statusOrb');

// ── Public alert (in #general) ───────────────────────────────────────────────

function buildOutagePublic({ since = 'a few minutes ago' } = {}) {
  // No counts, no reporter handles. Just signal + next-step.
  const desc = block([
    line(A.warnTag('STATUS'), A.boldYellow('UNAWARE'), A.dim('· investigating user reports')),
    line(A.dim('since'),  A.white(since)),
    line(A.dim('next'),   A.white('staff review in progress · update soon')),
  ]);

  const embed = new EmbedBuilder()
    .setColor(STATUS.warn.int)
    .setAuthor({ name: `${BRAND.botName} · outage watch` })
    .setTitle('Investigating ' + BRAND.productName + ' status')
    .setDescription(desc)
    .addFields(
      { name: '⚠️ Heads up', value:
        'We\'re looking into it. Hold off on bug reports until we post an update — ' +
        'this conserves attention for the staff actively triaging.' },
    )
    .setFooter({ text: `${BRAND.footerLine}` })
    .setTimestamp(new Date());

  return { embeds: [embed], components: [], files: [] };
}

// ── Staff review (in #staff) ────────────────────────────────────────────────

function buildOutageStaffReview({
  reports = [],     // [{t, user, conf}]  t in minutes
  threshold = 4,
  windowMin = 10,
  caseId = 'O-0000',
} = {}) {
  const distinct = new Set(reports.map((r) => r.user)).size;
  const buf = renderOutageTimeline({ reports, threshold, windowMin });
  const img = new AttachmentBuilder(buf, { name: 'outage-timeline.png' });

  // Sample lines — first 3 named so staff can DM the right people
  const sample = reports.slice(0, 3).map((r) =>
    line(A.dim('·'), A.white(r.user), A.dim(`@ +${r.t}m · ${r.conf}% conf`))
  );

  const desc = block([
    line(A.dim('$'), A.cyan('outage'), A.white('review'), A.dim('--case=' + caseId)),
    line(A.warnTag(), A.boldYellow(`distinct reporters · ${distinct}`),
                      A.dim(`(threshold ${threshold} / ${windowMin}m)`)),
    line(A.runTag(),  A.white('window · rolling 10m')),
    '',
    A.dim('// sample reports'),
    ...sample,
  ]);

  const embed = new EmbedBuilder()
    .setColor(STATUS.warn.int)
    .setAuthor({ name: `${BRAND.botName} · staff review` })
    .setTitle('Outage review · ' + caseId)
    .setDescription(desc)
    .setImage('attachment://outage-timeline.png')
    .addFields(
      { name: 'Distinct reporters', value: '`' + distinct + '`',  inline: true },
      { name: 'Threshold',          value: '`' + threshold + '`', inline: true },
      { name: 'Window',             value: `\`${windowMin}m rolling\``, inline: true },
    )
    .setFooter({ text: `${BRAND.footerLine} · ${caseId}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`outage:confirm:${caseId}`)
      .setLabel('Confirm outage')
      .setEmoji('🚨')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`outage:clear:${caseId}`)
      .setLabel('False alarm')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`outage:lockdown:${caseId}`)
      .setLabel('Lockdown')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row], files: [img] };
}

// ── Confirmed outage (auto-posted to #general after staff confirm) ──────────

function buildOutageConfirmed({ since = 'a few minutes ago' } = {}) {
  const buf = renderStatusOrbRibbon({
    status: 'DOWN', uptime: 0,
    ribbon: Array(96).fill('up').map((v, i) => i >= 92 ? 'down' : v),
  });
  const img = new AttachmentBuilder(buf, { name: 'orb-down.png' });

  const desc = block([
    line(A.failTag('STATUS'), A.boldRed('DOWN'), A.dim('· staff has confirmed an outage')),
    line(A.dim('since'),  A.white(since)),
    line(A.dim('action'), A.white('hold off on bug reports until cleared')),
  ]);

  const embed = new EmbedBuilder()
    .setColor(STATUS.down.int)
    .setAuthor({ name: `${BRAND.botName} · outage watch` })
    .setTitle(BRAND.productName + ' is currently DOWN')
    .setDescription(desc)
    .setImage('attachment://orb-down.png')
    .setFooter({ text: BRAND.footerLine })
    .setTimestamp(new Date());

  return { embeds: [embed], components: [], files: [img] };
}

// ── False-alarm "all clear" (#general) ──────────────────────────────────────

function buildOutageCleared({ uptime = 99.97 } = {}) {
  const buf = renderStatusOrbRibbon({
    status: 'UP', uptime, ribbon: Array(96).fill('up'),
  });
  const img = new AttachmentBuilder(buf, { name: 'orb-up.png' });

  const desc = block([
    line(A.okTag('STATUS'), A.boldGreen('UP'), A.dim('· no outage detected')),
    line(A.okTag(), A.green('staff reviewed reports · all green'))
  ]);

  const embed = new EmbedBuilder()
    .setColor(STATUS.up.int)
    .setAuthor({ name: `${BRAND.botName} · outage watch` })
    .setTitle('All clear · ' + BRAND.productName + ' is operational')
    .setDescription(desc)
    .setImage('attachment://orb-up.png')
    .setFooter({ text: BRAND.footerLine })
    .setTimestamp(new Date());

  return { embeds: [embed], components: [], files: [img] };
}

module.exports = {
  buildOutagePublic,
  buildOutageStaffReview,
  buildOutageConfirmed,
  buildOutageCleared,
};
