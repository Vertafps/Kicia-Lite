/**
 * Scam Detection embed.
 *
 * Layout (scannable — readability first):
 *   - Title:        e.g. "Scam/Trade Timeout"
 *   - Top block:    short ANSI synopsis (`scam detect / [RUN] parse · "..." /
 *                   [OK] signals · N fired / [OK] score · X/100 · CONFIRMED`).
 *   - Identity row: User | Verdict | Case   (inline 3-up)
 *   - Fields:       Action / Trigger / Why / AI Scam Verdict / Evidence —
 *                   each on its own line so moderators can scan at a glance.
 *   - Image:        confidence dial + breakdown bars
 *   - Footer:       "{brand} · {caseId} · Confidence: {n}%"
 *
 * Two messages live in the flow: the public alert posted in-channel and the
 * staff review thread with action buttons. This builder is the staff review.
 *
 * @typedef {Object} ScamData
 * @property {string} channel        e.g. "#help"
 * @property {string} userTag        e.g. "phantomgg#0001"
 * @property {string} userId         snowflake (used for moderator audit deeplink)
 * @property {string} message        offending message content
 * @property {number} score          0..100 confidence
 * @property {Array<{name:string,weight:number}>} signals
 * @property {string} action         e.g. "Message removed · user timed out 24h"
 * @property {string} caseId         e.g. "S-2401"
 * @property {string} [trigger]      trigger rule string
 * @property {string} [aiVerdict]    AI verdict line (e.g. "local-kicia-intent-v3: TRUE")
 * @property {string} [aiReason]     classifier reason
 * @property {Array<string>} [evidence]  recent message snippets
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { ansi: A, line, block } = require('../ansi');
const { renderConfidenceDial } = require('../canvas/confidenceDial');

function buildScamEmbed(data) {
  const d = withDefaults(data);

  // Confidence dial image with breakdown bars
  const dialBuf = renderConfidenceDial({
    score: d.score,
    signals: d.signals.map((s) => ({ name: s.name, weight: s.weight })),
  });
  const dialFile = new AttachmentBuilder(dialBuf, { name: 'scam-dial.png' });

  // ── Top synopsis ──────────────────────────────────────────────────────
  const head = block([
    line(A.dim('$'), A.cyan('scam'), A.white('detect'), A.dim('--user=' + d.userTag)),
    line(A.runTag(), A.white('parse · ' + truncate(d.message, 56))),
    line(A.okTag(),  A.green(`signals · ${d.signals.length} fired`)),
    line(A.okTag(),  A.boldGreen(`score · ${d.score}/100 · ` + verdict(d.score))),
  ]);

  // ── Title ─────────────────────────────────────────────────────────────
  const title = d.title || `Scam ${verdict(d.score).toLowerCase()} · ${d.channel}`;

  // ── Identity row (inline 3-up) ────────────────────────────────────────
  const identityRow = [
    { name: 'User',    value: `<@${d.userId}>`,                      inline: true },
    { name: 'Verdict', value: verdictLabel(d.score),                 inline: true },
    { name: 'Case',    value: '`' + d.caseId + '`',                  inline: true },
  ];

  // ── Detail fields (full-width, scannable) ─────────────────────────────
  const detailFields = [];
  if (d.action) {
    detailFields.push({ name: 'Action', value: trim(d.action, 1000), inline: false });
  }
  if (d.trigger) {
    detailFields.push({ name: 'Trigger', value: trim(d.trigger, 1000), inline: false });
  }
  const whyLines = d.signals.slice(0, 6).map((s) => {
    const w = Math.round(Math.max(0, Math.min(100, Number(s.weight) || 0)));
    return `· **${w}%** — ${String(s.name || 'signal')}`;
  });
  if (whyLines.length) {
    detailFields.push({ name: 'Why', value: trim(whyLines.join('\n'), 1024), inline: false });
  }
  if (d.aiVerdict) {
    // aiVerdict can be a single line ("local-kicia-intent-v3: TRUE") or the
    // full multi-line block from formatAiVerdictLines() — either is rendered
    // as the field value as-is so callers don't have to massage it.
    const aiBody = d.aiReason
      ? (d.aiVerdict.includes('\n')
          ? `${d.aiVerdict}\n${d.aiReason}`
          : `**${d.aiVerdict}** — ${d.aiReason}`)
      : d.aiVerdict;
    detailFields.push({ name: 'AI Scam Verdict', value: trim(aiBody, 1024), inline: false });
  }
  if (d.evidence?.length) {
    const numbered = d.evidence.slice(0, 6)
      .map((e, i) => `${i + 1}. ${String(e || '').replace(/\n+/g, ' ')}`)
      .join('\n');
    detailFields.push({ name: 'Evidence', value: trim(numbered, 1024), inline: false });
  }

  const embed = new EmbedBuilder()
    .setColor(ACCENT.int) // chrome stays accent — verdict is conveyed by the dial + tag
    .setAuthor({ name: `${BRAND.botName} · scam review` })
    .setTitle(title)
    .setDescription(head)
    .setImage('attachment://scam-dial.png')
    .addFields(...identityRow, ...detailFields)
    .setFooter({ text: `${BRAND.footerLine} · ${d.caseId} · Confidence: ${d.score}%` })
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
    channel:    d.channel    || '#unknown',
    userTag:    d.userTag    || 'unknown#0000',
    userId:     d.userId     || '0',
    message:    d.message    || '',
    score:      typeof d.score === 'number' ? d.score : 50,
    signals:    Array.isArray(d.signals) ? d.signals : [],
    action:     d.action     || 'flagged for review',
    caseId:     d.caseId     || 'S-0000',
    trigger:    d.trigger    || null,
    aiVerdict:  d.aiVerdict  || null,
    aiReason:   d.aiReason   || null,
    evidence:   Array.isArray(d.evidence) ? d.evidence : [],
    summary:    d.summary    || null,
    title:      d.title      || null,
    timestamp:  d.timestamp,
  };
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function trim(value, max) {
  const s = String(value || '');
  if (s.length <= max) return s || '​';
  return s.slice(0, max - 12) + ' …(trimmed)';
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
