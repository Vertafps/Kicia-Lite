/**
 * Daily Recap embed — donut + 24h activity bars.
 *
 * @typedef {Object} DailyData
 * @property {string} date                                 e.g. "Tue, 9 May 2026"
 * @property {Array<{label:string,value:number}>} slices   donut slices
 * @property {Array<number>} activity                      length 24
 * @property {number?} outageHour                          0..23, optional
 * @property {Array<{label:string,value:string}>} highlights  badge row at bottom
 */

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { ACCENT, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderDailyRecap } = require('../canvas/dailyRecap');

function buildDailyRecapEmbed({
  date = new Date().toDateString(),
  slices, activity, outageHour,
  highlights = [],
} = {}) {

  const buf = renderDailyRecap({ slices, activity, outageHour });
  const img = new AttachmentBuilder(buf, { name: 'daily-recap.png' });

  const total = (slices || []).reduce((s, x) => s + x.value, 0);

  const desc = block([
    line(A.dim('$'), A.cyan('daily'), A.white('recap'), A.dim('--date=' + date)),
    line(A.okTag(), A.boldCyan(`${total} events`), A.dim('logged today')),
    outageHour != null
      ? line(A.warnTag(), A.boldYellow(`outage @ ${String(outageHour).padStart(2, '0')}:00 UTC`),
                          A.dim('· cleared'))
      : line(A.okTag(), A.green('no outages')),
  ]);

  const embed = new EmbedBuilder()
    .setColor(ACCENT.int)
    .setAuthor({ name: `${BRAND.botName} · daily recap` })
    .setTitle(date)
    .setDescription(desc)
    .setImage('attachment://daily-recap.png')
    .setFooter({ text: BRAND.footerLine })
    .setTimestamp(new Date());

  if (highlights.length) {
    embed.addFields(
      ...highlights.map((h) => ({ name: h.label, value: '`' + h.value + '`', inline: true }))
    );
  }

  return { embeds: [embed], components: [], files: [img] };
}

module.exports = { buildDailyRecapEmbed };
