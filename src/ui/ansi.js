/**
 * ANSI escape helpers for Discord ```ansi code blocks.
 *
 * Discord renders a *subset* of ANSI inside ```ansi fenced blocks. Only the
 * codes below are honored — anything else is stripped or rendered literally.
 *
 * Usage:
 *   const { ansi: A, line, block } = require('./ansi');
 *   const s = block([
 *     line(A.dim('$'), A.cyan('status'), A.white('set'), A.yellow('UNAWARE')),
 *     line(A.dim('$'), A.cyan('lockdown'), A.white('apply'), A.green('3 changed')),
 *   ]);
 *   embed.setDescription(s);
 *
 * The output is wrapped in ```ansi … ``` so you can drop it directly into a
 * description, field value, or message content.
 *
 * Discord ANSI cheat-sheet (the only codes that work):
 *   0   reset            1   bold              4   underline
 *   30  gray             31  red               32  green
 *   33  yellow           34  blue              35  pink/magenta
 *   36  cyan             37  white
 *   40  bg dark-blue     41  bg orange         42  bg gray
 *   43  bg light-gray    44  bg gray           45  bg indigo
 *   46  bg light-gray    47  bg white
 *
 * Note: there's no "dim" code on Discord — we approximate with gray (30).
 */

const ESC = '\u001b[';
const RESET = ESC + '0m';

const wrap = (codes) => (s) => `${ESC}${codes}m${s}${RESET}`;

const ansi = {
  // Foreground
  gray:    wrap('30'),
  dim:     wrap('30'),       // alias — Discord has no true dim
  red:     wrap('31'),
  green:   wrap('32'),
  yellow:  wrap('33'),
  blue:    wrap('34'),
  magenta: wrap('35'),
  pink:    wrap('35'),
  cyan:    wrap('36'),
  white:   wrap('37'),

  // Style
  bold:       wrap('1'),
  underline:  wrap('4'),

  // Combos used heavily by the embeds
  okTag:      (s = 'OK')   => wrap('1;32')(`[${s}]`),
  warnTag:    (s = 'WARN') => wrap('1;33')(`[${s}]`),
  failTag:    (s = 'FAIL') => wrap('1;31')(`[${s}]`),
  runTag:     (s = 'RUN')  => wrap('1;33')(`[${s}]`),
  waitTag:    (s = 'WAIT') => wrap('30')(`[${s}]`),

  // Convenience: bold + color in one shot
  boldRed:    wrap('1;31'),
  boldGreen:  wrap('1;32'),
  boldYellow: wrap('1;33'),
  boldCyan:   wrap('1;36'),
};

/**
 * Join tokens with single spaces — matches the visual rhythm of the mockup
 * where prefix tags align before the message.
 */
function line(...tokens) {
  return tokens.filter((t) => t != null).join(' ');
}

/**
 * Pad a string to `width` columns (right-pads with spaces). Useful for
 * aligning columns in the sweep findings block.
 */
function pad(s, width, char = ' ') {
  // ANSI escapes don't count toward visible width — strip them for the calc.
  const visible = String(s).replace(/\u001b\[[0-9;]*m/g, '');
  if (visible.length >= width) return s;
  return s + char.repeat(width - visible.length);
}

/**
 * Wrap a list of lines (or a single string) in a ```ansi fenced block.
 */
function block(lines) {
  const body = Array.isArray(lines) ? lines.join('\n') : String(lines);
  return '```ansi\n' + body + '\n```';
}

/**
 * A pre-built progress bar token: e.g. progressBar(0.62) → "[############............]"
 * filled in green, empty in dim. 24 columns by default.
 */
function progressBar(ratio, width = 24) {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  const fillStr = '#'.repeat(filled);
  const emptyStr = '.'.repeat(width - filled);
  return ansi.green('[') + ansi.boldGreen(fillStr) + ansi.dim(emptyStr) + ansi.green(']');
}

module.exports = { ansi, line, pad, block, progressBar };
