/**
 * Lockdown embed — fired when a moderator runs $lock / $unlock / $lock status.
 *
 * Layout (matches Carrot design):
 *   - Title:        e.g. "Channels locked — manual"
 *   - Subtitle:     plain summary line
 *                   "Triggered by @kernel · 3 channels updated, 1 already, 4 untouched"
 *   - Stat row:     CHANGED | ALREADY | UNTOUCHED  (inline 3-up)
 *   - Image:        lockdown grid showing every configured channel
 *   - Footer:       "{brand} · run $unlock to revert"
 *
 * @typedef {Object} LockdownData
 * @property {Array<{name:string,status:'locked'|'unlocked'|'untouched'}>} channels
 * @property {string} reason
 * @property {string} actor
 * @property {'lock'|'unlock'|'status'} [intent]
 * @property {string} [title]
 * @property {{changed:number, already:number, untouched:number}} [stats]
 * @property {string} [summaryLine]
 * @property {string} [hint]   optional extra hint (e.g. "run $unlock to revert")
 */

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { renderLockdownGrid } = require('../canvas/lockdownGrid');
const { renderLockdownGridAnimated } = require('../canvas/lockdownGridAnimated');
const { ANIMATED_HEROES } = require('../../config');
const { recordRuntimeEvent } = require('../../runtime-health');

function renderLockdownHero(opts) {
  if (ANIMATED_HEROES) {
    try {
      return { buffer: renderLockdownGridAnimated(opts), animated: true };
    } catch (err) {
      recordRuntimeEvent('warn', 'animated-hero-lockdown', err?.message || err);
    }
  }
  return { buffer: renderLockdownGrid(opts), animated: false };
}

function buildLockdownEmbed({
  channels = [], reason = 'precautionary', actor = 'mod',
  intent = 'lock', title, stats, summaryLine, hint,
} = {}) {
  const hero = renderLockdownHero({ channels });
  const ext = hero.animated ? 'gif' : 'png';
  const filename = `lockdown-grid.${ext}`;
  const img = new AttachmentBuilder(hero.buffer, { name: filename });

  const lockedCount = channels.filter((c) => c.status === 'locked').length;
  const unlockedCount = channels.filter((c) => c.status === 'unlocked').length;
  const untouchedCount = channels.filter((c) => c.status === 'untouched').length;

  const resolvedStats = stats || {
    changed: intent === 'unlock' ? unlockedCount : lockedCount,
    already: 0,
    untouched: untouchedCount,
  };

  const accentColor =
    intent === 'unlock' ? STATUS.up.int :
    intent === 'status' ? STATUS.warn.int :
    intent === 'lock' && resolvedStats.changed === 0 ? STATUS.warn.int :
                          STATUS.down.int;

  const resolvedTitle = title
    || (intent === 'unlock' ? 'Channels Unlocked'
      : intent === 'status' ? 'Channel Lock Status'
      : 'Channels Locked');

  const verb =
    intent === 'unlock' ? 'unlocked' :
    intent === 'status' ? 'reviewed' :
                          'updated';
  const subtitle = summaryLine
    || `Triggered by **${actor}** · ${resolvedStats.changed} channel${resolvedStats.changed === 1 ? '' : 's'} ${verb}, ${resolvedStats.already} already, ${resolvedStats.untouched} untouched.`;

  const reasonLine = reason && reason !== 'precautionary'
    ? `**Reason:** ${reason}`
    : null;

  const description = [subtitle, reasonLine].filter(Boolean).join('\n');

  const embed = new EmbedBuilder()
    .setColor(accentColor)
    .setAuthor({ name: `${BRAND.botName} · lockdown` })
    .setTitle(resolvedTitle)
    .setDescription(description)
    .setImage(`attachment://${filename}`)
    .addFields(
      { name: 'Changed',   value: '`' + resolvedStats.changed + '`',   inline: true },
      { name: 'Already',   value: '`' + resolvedStats.already + '`',   inline: true },
      { name: 'Untouched', value: '`' + resolvedStats.untouched + '`', inline: true },
    )
    .setFooter({
      text: hint
        ? `${BRAND.footerLine} · ${hint}`
        : intent === 'lock'
          ? `${BRAND.footerLine} · run $unlock to revert`
          : intent === 'unlock'
            ? `${BRAND.footerLine} · run $lock to re-engage`
            : BRAND.footerLine,
    })
    .setTimestamp(new Date());

  return { embeds: [embed], components: [], files: [img] };
}

module.exports = { buildLockdownEmbed };
