/**
 * Scam Detection embed.
 *
 * Two messages live in the flow:
 *   1) the public alert posted in the offending channel (auto-posted by the bot)
 *   2) the staff review thread with action buttons (this builder is for #2;
 *      the public alert is just a short notice — see scam.alertPublic())
 *
 * @typedef {Object} ScamData
 * @property {string} channel        e.g. "#help"
 * @property {string} userTag        e.g. "phantomgg#0001"
 * @property {string} userId         snowflake (used for moderator audit deeplink)
 * @property {string} message        offending message content
 * @property {number} score          0..100 confidence
 * @property {Array<string>} signals  signal names (Bayes, Keywords, …)
 * @property {string} action         e.g. "Message removed · user timed out 24h"
 * @property {string} caseId         e.g. "S-2401"
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderConfidenceDial } = require('../canvas/confidenceDial');

function buildScamEmbed(data) {
  const d = withDefaults(data);

  // Confidence dial image
  const dialBuf = renderConfidenceDial({
    score: d.score,
    signals: d.signals.map((s) => ({ name: s.name, weight: s.weight })),
  });
  const dialFile = new AttachmentBuilder(dialBuf, { name: 'scam-dial.png' });

  // Terminal block — explicit, scannable
  const term = block([
    line(A.dim('$'), A.cyan('scam'), A.white('detect'), A.dim('--target=' + d.userTag)),
    line(A.runTag(), A.white('parse · ' + truncate(d.message, 40))),
    line(A.okTag(), A.green('signals · ' + d.signals.length + ' fired')),
    line(A.okTag(), A.boldGreen(`score · ${d.score}/100 · ` + verdict(d.score))),
    line(A.dim('//'), A.dim('action · ' + d.action)),
  ]);

  const verdictTone =
    d.score >= 85 ? STATUS.down.int :
    d.score >= 65 ? STATUS.warn.int :
                    STATUS.up.int;

  const embed = new EmbedBuilder()
    .setColor(ACCENT.int)
    .setAuthor({ name: `${BRAND.botName} · scam review`, iconURL: undefined })
    .setTitle(`Suspect message · ${d.channel}`)
    .setDescription(term)
    .setImage('attachment://scam-dial.png')
    .addFields(
      { name: 'User',     value: '`' + d.userTag + '`',  inline: true },
      { name: 'Verdict',  value: verdictLabel(d.score),  inline: true },
      { name: 'Case',     value: '`' + d.caseId + '`',   inline: true },
    )
    .setFooter({ text: `${BRAND.footerLine} · ${d.caseId}` })
    .setTimestamp(d.timestamp || new Date());

  // 4 buttons in 2 rows. Row 1 = AI training (no side-effects).
  // Row 2 = moderator actions (mutating).
  const trainingRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`scam:correct:${d.caseId}`)
      .setLabel('Correct')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`scam:wrong:${d.caseId}`)
      .setLabel('Wrong')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`scam:revert:${d.caseId}`)
      .setLabel('Revert Action')
      .setEmoji('↺')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`scam:audit:${d.caseId}`)
      .setLabel('View Audit')
      .setEmoji('🗂️')
      .setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: [trainingRow, actionRow],
    files: [dialFile],
  };
}

/**
 * Public alert posted by the bot in the channel where the suspect message was
 * detected. Compact, no buttons, no signal disclosure.
 */
function buildScamPublicAlert({ caseId = 'S-0000', action = 'Message removed' } = {}) {
  const embed = new EmbedBuilder()
    .setColor(STATUS.down.int)
    .setDescription(
      `🛡️ **Scam removed.** ${action}. ` +
      `If this looks wrong, ping a moderator with case \`${caseId}\`.`
    )
    .setFooter({ text: BRAND.footerLine });
  return { embeds: [embed], components: [], files: [] };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function withDefaults(d = {}) {
  return {
    channel:  d.channel  || '#unknown',
    userTag:  d.userTag  || 'unknown#0000',
    userId:   d.userId   || '0',
    message:  d.message  || '',
    score:    typeof d.score === 'number' ? d.score : 50,
    signals:  d.signals  || [],
    action:   d.action   || 'flagged for review',
    caseId:   d.caseId   || 'S-0000',
    timestamp: d.timestamp,
  };
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function verdict(score) {
  if (score >= 85) return 'CONFIRMED';
  if (score >= 65) return 'BORDERLINE';
  return 'CLEAN';
}

function verdictLabel(score) {
  if (score >= 85) return '🔴 Confirmed';
  if (score >= 65) return '🟡 Borderline';
  return '🟢 Clean';
}

module.exports = { buildScamEmbed, buildScamPublicAlert };
