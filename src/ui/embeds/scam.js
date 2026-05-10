/**
 * Scam Detection embed.
 *
 * Layout (matches Carrot design):
 *   - Title:        "{header} — {actor}"
 *   - Subtitle:     plain summary line in the description (no code wrapper)
 *   - Code block:   `signals.log` style — fired signals, two columns, then the
 *                   action / trigger / ai verdict / evidence as `// …` notes.
 *   - Stat row:     ACTION | MESSAGE | AUDIT ID  (inline 3-up)
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
 * @property {string} [trigger]      trigger rule string (e.g. "confidence 97% > 90% => timeout 1d")
 * @property {string} [aiVerdict]    AI verdict line (e.g. "local-kicia-intent-v3: TRUE")
 * @property {string} [aiReason]     classifier reason
 * @property {Array<string>} [evidence]  recent message snippets
 * @property {string} [summary]      one-line subtitle. If absent we synthesize.
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { ansi: A, line, block, pad } = require('../ansi');
const { renderConfidenceDial } = require('../canvas/confidenceDial');

function buildScamEmbed(data) {
  const d = withDefaults(data);

  // Confidence dial image with breakdown bars
  const dialBuf = renderConfidenceDial({
    score: d.score,
    signals: d.signals.map((s) => ({ name: s.name, weight: s.weight })),
  });
  const dialFile = new AttachmentBuilder(dialBuf, { name: 'scam-dial.png' });

  // ── Description (signals.log style) ─────────────────────────────────────
  // Top: short command synopsis
  const head = block([
    line(A.dim('$'), A.cyan('scam'), A.white('detect'), A.dim('--user=' + d.userTag)),
    line(A.runTag(), A.white('parse · ' + truncate(d.message, 56))),
    line(A.okTag(),  A.green(`signals · ${d.signals.length} fired`)),
    line(A.okTag(),  A.boldGreen(`score · ${d.score}/100 · ` + verdict(d.score))),
  ]);

  // signals.log — one row per fired signal. Reason runs full width, weight
  // appears below as a `· N%` tail so long reasons don't get clipped.
  const signalLines = d.signals.length
    ? d.signals.slice(0, 6).flatMap((s) => {
        const reasonStr = String(s.name || 'signal');
        const right = `${Math.round(Math.max(0, Math.min(100, Number(s.weight) || 0)))}%`;
        const tone = (Number(s.weight) || 0) >= 80 ? A.boldGreen : A.green;
        return [
          line(tone('+ ' + reasonStr), A.dim('· ' + right)),
        ];
      })
    : [line(A.dim('// no signals fired'))];

  const noteLines = [];
  if (d.trigger) noteLines.push(line(A.dim('// trigger ·'), A.white(d.trigger)));
  if (d.action)  noteLines.push(line(A.dim('// action  ·'), A.white(d.action)));
  if (d.aiVerdict) {
    const verdictLine = d.aiReason
      ? `${d.aiVerdict} — ${truncate(d.aiReason, 100)}`
      : d.aiVerdict;
    noteLines.push(line(A.dim('// ai      ·'), A.white(verdictLine)));
  }

  const why = block([
    line(A.dim('signals.log')),
    ...signalLines,
    ...(noteLines.length ? ['', ...noteLines] : []),
  ]);

  const evidence = d.evidence?.length
    ? block([
        line(A.dim('// evidence')),
        ...d.evidence.slice(0, 4).map((e, i) =>
          line(A.dim(String(i + 1) + '.'), A.white(truncate(String(e || ''), 70)))
        ),
      ])
    : null;

  // ── Title + subtitle ───────────────────────────────────────────────────
  const title = d.title || `Scam ${verdict(d.score).toLowerCase()} · ${d.channel}`;
  const subtitle = d.summary
    || `User \`${d.userTag}\` in ${d.channel} · ${d.action || 'flagged for review'}`;

  // ── Stat row ───────────────────────────────────────────────────────────
  const statRow = [
    { name: 'Action',   value: '`' + truncate(d.action || '—', 80) + '`',  inline: true },
    { name: 'Message',  value: messageStateLabel(d.action),                inline: true },
    { name: 'Audit ID', value: '`' + d.caseId + '`',                       inline: true },
  ];

  const embed = new EmbedBuilder()
    .setColor(ACCENT.int) // chrome stays accent — verdict is conveyed by the dial + tag
    .setAuthor({ name: `${BRAND.botName} · scam review` })
    .setTitle(title)
    .setDescription([subtitle, head, why, evidence].filter(Boolean).join('\n'))
    .setImage('attachment://scam-dial.png')
    .addFields(...statRow)
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

function verdict(score) {
  if (score >= 85) return 'CONFIRMED';
  if (score >= 65) return 'BORDERLINE';
  return 'CLEAN';
}

function messageStateLabel(action) {
  const lc = String(action || '').toLowerCase();
  if (/delet/.test(lc) || /remov/.test(lc)) return '🗑️ deleted';
  if (/log/.test(lc)) return '📋 logged';
  return '👁️ flagged';
}

module.exports = { buildScamEmbed, buildScamPublicAlert };
