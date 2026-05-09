/**
 * System Sweep ($jarvis) embeds.
 *
 *   buildSweepProgressEmbed(data) — live-updating embed during the sweep.
 *                                   Edit the same message with new data each tick.
 *   buildSweepReportEmbed(data)   — final scorecard with diagnostics.
 *
 * @typedef {Object} SweepProgressData
 * @property {Array<{name:string,status:'queued'|'running'|'ok'|'warn'|'fail',ms?:number,note?:string}>} stages
 * @property {number} ratio                0..1 overall progress
 *
 * @typedef {Object} SweepReportData
 * @property {Array<{key:string,score:number,status:'ok'|'warn'|'fail',detail:string}>} systems
 * @property {Array<{key:string,severity:'warn'|'fail',line:string}>} findings
 * @property {string} runId
 */

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
        AttachmentBuilder } = require('discord.js');
const { ACCENT, STATUS, BRAND } = require('../colors');
const { ansi: A, line, pad, block, progressBar } = require('../ansi');
const { renderScorecard } = require('../canvas/scorecard');

// ── Progress embed ──────────────────────────────────────────────────────────

function buildSweepProgressEmbed({ stages = [], ratio = 0 } = {}) {
  const lines = stages.map((s) => {
    const tag =
      s.status === 'ok'      ? A.okTag()
    : s.status === 'warn'    ? A.warnTag()
    : s.status === 'fail'    ? A.failTag()
    : s.status === 'running' ? A.runTag()
    :                          A.waitTag();
    const name = pad(A.white(s.name), 16 + 9); // +9 = ANSI overhead
    const note = s.note ? A.dim('· ' + s.note) : '';
    const ms = s.ms != null ? A.dim(`(${s.ms}ms)`) : '';
    return line(tag, name, ms, note);
  });
  const desc = block([
    line(A.dim('$'), A.cyan('jarvis'), A.white('sweep'), A.dim('--all')),
    '',
    ...lines,
    '',
    line(A.dim('progress'), progressBar(ratio), A.dim(`${Math.round(ratio * 100)}%`)),
  ]);

  const embed = new EmbedBuilder()
    .setColor(ACCENT.int)
    .setAuthor({ name: `${BRAND.botName} · system sweep` })
    .setTitle('Sweep in progress')
    .setDescription(desc)
    .setFooter({ text: `${BRAND.footerLine} · live` });

  return { embeds: [embed], components: [], files: [] };
}

// ── Final report embed ─────────────────────────────────────────────────────

function buildSweepReportEmbed({ systems = [], findings = [], runId = 'J-0000' } = {}) {
  const overall = systems.length
    ? Math.round(systems.reduce((a, b) => a + b.score, 0) / systems.length)
    : 0;

  const cardBuf = renderScorecard({ systems });
  const cardFile = new AttachmentBuilder(cardBuf, { name: 'sweep-card.png' });

  const findingLines = findings.length
    ? findings.map((f) => {
        const tag = f.severity === 'fail' ? A.failTag() : A.warnTag();
        return line(tag, A.white(f.key + ' ·'), A.dim(f.line));
      })
    : [line(A.okTag(), A.green('no findings · all systems within tolerance'))];

  const desc = block([
    line(A.dim('$'), A.cyan('jarvis'), A.white('report'), A.dim('--run=' + runId)),
    line(A.okTag(), A.boldGreen(`overall · ${overall}%`)),
    '',
    A.dim('// findings'),
    ...findingLines,
  ]);

  const embed = new EmbedBuilder()
    .setColor(overall >= 90 ? STATUS.up.int : overall >= 70 ? STATUS.warn.int : STATUS.down.int)
    .setAuthor({ name: `${BRAND.botName} · sweep report` })
    .setTitle('Diagnostic scorecard')
    .setDescription(desc)
    .setImage('attachment://sweep-card.png')
    .setFooter({ text: `${BRAND.footerLine} · run ${runId}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sweep:rerun:${runId}`)
      .setLabel('Re-run')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`sweep:logs:${runId}`)
      .setLabel('Open log')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row], files: [cardFile] };
}

module.exports = { buildSweepProgressEmbed, buildSweepReportEmbed };
