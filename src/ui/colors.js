/**
 * Carrot UI — design tokens.
 *
 * Two color systems live side by side:
 *  - ACCENT      : chrome only (embed stripe, author icon, KB editorial card).
 *                  Default Indigo. Pick from ACCENT_VARIANTS or override per-call.
 *  - STATUS/VIZ  : data-viz palette. Always green/red/yellow/blue/slate, NEVER tinted by accent.
 *                  Errors and warnings stay red/yellow regardless of accent choice.
 *
 * Discord's embed `.setColor()` accepts ints. Every color here exposes both `hex`
 * and `int` so you can pass either. Embed builders default to ACCENT.indigo.int.
 */

// ── Accent (chrome) ──────────────────────────────────────────────────────────

const ACCENT_VARIANTS = {
  indigo:  { hex: '#6E7AF6', deepHex: '#3D4CD8', int: 0x6E7AF6, deepInt: 0x3D4CD8 },
  iris:    { hex: '#9C7AF0', deepHex: '#6E4CD8', int: 0x9C7AF0, deepInt: 0x6E4CD8 },
  mint:    { hex: '#4FD1A7', deepHex: '#1E9B72', int: 0x4FD1A7, deepInt: 0x1E9B72 },
  azure:   { hex: '#5AB6F0', deepHex: '#2884C5', int: 0x5AB6F0, deepInt: 0x2884C5 },
};

const ACCENT = ACCENT_VARIANTS.indigo;

// ── Status / data-viz palette (independent of accent) ────────────────────────

const STATUS = {
  up:    { hex: '#57F287', int: 0x57F287 }, // green   — operational, success, "Correct"
  down:  { hex: '#ED4245', int: 0xED4245 }, // red     — outage, scam confirmed, danger
  warn:  { hex: '#FEE75C', int: 0xFEE75C }, // yellow  — UNAWARE, warning, low-confidence
  info:  { hex: '#5AB6F0', int: 0x5AB6F0 }, // blue    — info pings, neutral signal
  mute:  { hex: '#949BA4', int: 0x949BA4 }, // slate   — muted/untouched
};

// ── Surface colors (canvas backgrounds, terminal chrome) ─────────────────────

const SURFACE = {
  embedBg:        '#2B2D31', // matches Discord embed background — canvas blends in
  terminalBg:     '#0C0D10',
  terminalBorder: '#1F2126',
  panelBg:        '#15171B',
  panelBorder:    '#24262C',
  gridLine:       'rgba(255,255,255,0.04)',
  text:           '#DBDEE1',
  textMuted:      '#949BA4',
  textDim:        '#6D6F78',
};

// ── Typography (canvas font stack) ───────────────────────────────────────────

const TYPE = {
  // The bundle works without registered fonts (system fallback). To get Geist
  // exactly as designed, drop the .ttf files into src/ui/canvas/fonts/ and call
  // registerFonts() — see canvas/_theme.js.
  sans:   '"Geist", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono:   '"Geist Mono", ui-monospace, "SFMono-Regular", "Menlo", "Consolas", monospace',
};

// ── Brand strings (used in footers + author lines) ───────────────────────────

const BRAND = {
  botName:     'Carrot',
  productName: 'KiciaHook',
  footerLine:  'Carrot · KiciaHook ops',
};

module.exports = {
  ACCENT, ACCENT_VARIANTS, STATUS, SURFACE, TYPE, BRAND,
};
