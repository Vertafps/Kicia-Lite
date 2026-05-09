/**
 * Lockdown embed — fired when a moderator runs $lock / $unlock / $lock status.
 *
 * @typedef {Object} LockdownData
 * @property {Array<{name:string,status:'locked'|'unlocked'|'untouched'}>} channels
 * @property {string} reason
 * @property {string} actor                moderator handle who triggered it
 * @property {'lock'|'unlock'|'status'} [intent]   action context (default 'lock')
 * @property {string} [title]              override embed title
 * @property {{changed:number, already:number, untouched:number}} [stats]
 * @property {string} [summaryLine]        e.g. "Triggered by @kernel · 3 channels updated, 1 already, 4 untouched"
 */

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { STATUS, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderLockdownGrid } = require('../canvas/lockdownGrid');

function buildLockdownEmbed({
  channels = [], reason = 'precautionary', actor = 'mod',
  intent = 'lock', title, stats, summaryLine,
} = {}) {
  const buf = renderLockdownGrid({ channels });
  const img = new AttachmentBuilder(buf, { name: 'lockdown-grid.png' });

  const lockedCount = channels.filter((c) => c.status === 'locked').length;
  const unlockedCount = channels.filter((c) => c.status === 'unlocked').length;
  const untouchedCount = channels.filter((c) => c.status === 'untouched').length;

  const verbLine = intent === 'unlock'
    ? line(A.okTag(),   A.boldGreen(`${unlockedCount}/${channels.length} channels unlocked`))
    : intent === 'status'
      ? line(A.warnTag(),A.boldYellow(`${lockedCount}/${channels.length} channels locked`))
      : line(A.failTag(),A.boldRed(`${lockedCount}/${channels.length} channels locked`));

  const verbCmd = intent === 'unlock' ? 'unlock' : intent === 'status' ? 'status' : 'apply';

  const lines = [
    line(A.dim('$'), A.cyan('lockdown'), A.white(verbCmd), A.dim('--reason=' + reason)),
    verbLine,
    line(A.dim('actor'), A.white(actor)),
  ];
  if (summaryLine) lines.push(line(A.dim('//'), A.dim(summaryLine)));

  const desc = block(lines);

  const accentColor = intent === 'unlock'
    ? STATUS.up.int
    : intent === 'status'
      ? STATUS.warn.int
      : STATUS.down.int;
  const resolvedTitle = title
    || (intent === 'unlock' ? 'Channels Unlocked'
      : intent === 'status' ? 'Channel Lock Status'
      : 'Channels Locked');

  const fields = stats
    ? [
        { name: 'Changed',   value: '`' + stats.changed + '`',   inline: true },
        { name: 'Already',   value: '`' + stats.already + '`',   inline: true },
        { name: 'Untouched', value: '`' + stats.untouched + '`', inline: true },
      ]
    : [
        { name: 'Reason', value: reason,             inline: true },
        { name: 'Actor',  value: '`' + actor + '`',  inline: true },
        { name: intent === 'unlock' ? 'Unlocked' : 'Locked',
          value: '`' + (intent === 'unlock' ? unlockedCount : lockedCount) + '/' + channels.length + '`',
          inline: true },
      ];

  const embed = new EmbedBuilder()
    .setColor(accentColor)
    .setAuthor({ name: `${BRAND.botName} · lockdown` })
    .setTitle(resolvedTitle)
    .setDescription(desc)
    .setImage('attachment://lockdown-grid.png')
    .addFields(...fields)
    .setFooter({ text: BRAND.footerLine })
    .setTimestamp(new Date());

  return { embeds: [embed], components: [], files: [img] };
}

module.exports = { buildLockdownEmbed };
