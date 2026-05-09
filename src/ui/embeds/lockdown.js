/**
 * Lockdown embed — fired when a moderator runs $lockdown apply.
 *
 * @typedef {Object} LockdownData
 * @property {Array<{name:string,status:'locked'|'unlocked'|'untouched'}>} channels
 * @property {string} reason
 * @property {string} actor      moderator handle who triggered it
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        AttachmentBuilder } = require('discord.js');
const { STATUS, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderLockdownGrid } = require('../canvas/lockdownGrid');

function buildLockdownEmbed({
  channels = [], reason = 'precautionary', actor = 'mod',
} = {}) {
  const buf = renderLockdownGrid({ channels });
  const img = new AttachmentBuilder(buf, { name: 'lockdown-grid.png' });

  const lockedCount = channels.filter((c) => c.status === 'locked').length;

  const desc = block([
    line(A.dim('$'), A.cyan('lockdown'), A.white('apply'), A.dim('--reason=' + reason)),
    line(A.failTag(), A.boldRed(`${lockedCount}/${channels.length} channels locked`)),
    line(A.dim('actor'), A.white(actor)),
  ]);

  const embed = new EmbedBuilder()
    .setColor(STATUS.down.int)
    .setAuthor({ name: `${BRAND.botName} · lockdown` })
    .setTitle('Server lockdown active')
    .setDescription(desc)
    .setImage('attachment://lockdown-grid.png')
    .addFields(
      { name: 'Reason', value: reason,         inline: true },
      { name: 'Actor',  value: '`' + actor + '`', inline: true },
      { name: 'Locked', value: '`' + lockedCount + '/' + channels.length + '`', inline: true },
    )
    .setFooter({ text: BRAND.footerLine })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('lockdown:lift')
      .setLabel('Lift lockdown')
      .setEmoji('🔓')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('lockdown:audit')
      .setLabel('View audit')
      .setEmoji('🗂️')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row], files: [img] };
}

module.exports = { buildLockdownEmbed };
