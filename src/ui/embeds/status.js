/**
 * $status command embed — orb + key metrics.
 *
 * Note: uptime metric was intentionally dropped from the user-visible
 * surface — showing "uptime 99.4%" reads as a self-report of bad uptime
 * even when KiciaHook is healthy. Internal status-metrics still tracks
 * uptime for diagnostics, but it never lands in the embed.
 *
 * @typedef {Object} StatusData
 * @property {'UP'|'DOWN'|'UNAWARE'} status
 * @property {number} latencyMs            current gateway latency
 * @property {string} lastDown
 * @property {string} incidents7d
 */

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderStatusOrbRibbon } = require('../canvas/statusOrb');
const { renderStatusOrbRibbonAnimated } = require('../canvas/statusOrbAnimated');
const { ANIMATED_HEROES } = require('../../config');
const { recordRuntimeEvent } = require('../../runtime-health');

function renderStatusHero(opts) {
  if (ANIMATED_HEROES) {
    try {
      return { buffer: renderStatusOrbRibbonAnimated(opts), animated: true };
    } catch (err) {
      recordRuntimeEvent('warn', 'animated-hero-status', err?.message || err);
    }
  }
  return { buffer: renderStatusOrbRibbon(opts), animated: false };
}

function buildStatusEmbed({
  status = 'UP', latencyMs = 0,
  lastDown = '—', incidents7d = '0',
} = {}) {

  const hero = renderStatusHero({ status });
  const ext = hero.animated ? 'gif' : 'png';
  const filename = `status-orb.${ext}`;
  const img = new AttachmentBuilder(hero.buffer, { name: filename });

  const tone =
    status === 'DOWN'    ? STATUS.down :
    status === 'UNAWARE' ? STATUS.warn :
                           STATUS.up;
  const tag =
    status === 'DOWN'    ? A.failTag('STATUS') :
    status === 'UNAWARE' ? A.warnTag('STATUS') :
                           A.okTag('STATUS');
  const lblFn =
    status === 'DOWN'    ? A.boldRed :
    status === 'UNAWARE' ? A.boldYellow :
                           A.boldGreen;

  const desc = block([
    line(A.dim('$'), A.cyan('status'), A.white('show')),
    line(tag, lblFn(status)),
    line(A.dim('latency'),    A.white(latencyMs + 'ms')),
    line(A.dim('last down'),  A.white(lastDown)),
    line(A.dim('incidents'),  A.white(incidents7d + ' (7d)')),
  ]);

  const embed = new EmbedBuilder()
    .setColor(ACCENT.int) // chrome stays accent — status is conveyed by orb + tag
    .setAuthor({ name: `${BRAND.botName} · ${BRAND.productName} watch` })
    .setTitle('Service status')
    .setDescription(desc)
    .setImage(`attachment://${filename}`)
    .addFields(
      { name: 'Status',  value: tone.hex === STATUS.down.hex ? '🔴 Down' :
                                tone.hex === STATUS.warn.hex ? '🟡 Unaware' :
                                                               '🟢 Up',
        inline: true },
      { name: 'Latency', value: '`' + latencyMs + 'ms`', inline: true },
    )
    .setFooter({ text: BRAND.footerLine })
    .setTimestamp(new Date());

  return { embeds: [embed], components: [], files: [img] };
}

module.exports = { buildStatusEmbed };
