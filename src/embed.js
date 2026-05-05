const { EmbedBuilder } = require("discord.js");
const { BRAND } = require("./config");

const SURFACE = 0x2B2D31;
const SUCCESS = 0x57F287;
const DANGER = 0xED4245;
const WARN = 0xFAA61A;
const INFO = 0x5865F2;
const MUTED = 0x4F545C;
const PURPLE = 0x9B59B6;
const TEAL = 0x1ABC9C;

const MAX_DESC = 4090;
function truncate(s) {
  if (!s || s.length <= MAX_DESC) return s;
  const cut = s.lastIndexOf("\n", MAX_DESC - 50);
  return `${s.slice(0, cut > 0 ? cut : MAX_DESC - 50)}\n\n*(trimmed)*`;
}

function truncateFieldValue(value) {
  const text = String(value ?? "");
  if (text.length <= 1024) return text || "\u200b";
  return `${text.slice(0, 1011)}...(trimmed)`;
}

function buildPanel({
  header,
  body,
  tip,
  tipStyle = "quote",
  tipLevel = "##",
  rows = [],
  extra,
  footer,
  color = SURFACE,
  headerLevel = "#"
} = {}) {
  const parts = [];
  if (header) parts.push(`${headerLevel} ${header}`);
  if (body) parts.push(body);
  if (tip) {
    if (tipStyle === "heading") {
      parts.push(`${tipLevel} ${tip}`);
    } else if (tipStyle === "plain") {
      parts.push(tip);
    } else {
      parts.push(`> *${tip}*`);
    }
  }
  if (rows.length) {
    const bullets = rows
      .filter(([, v]) => v != null && String(v).trim() !== "")
      .map(([label, v]) => `**${label}**\n\`${v}\``)
      .join("\n");
    if (bullets) parts.push(bullets);
  }
  if (extra) parts.push(`*${extra}*`);

  const e = new EmbedBuilder().setColor(color);
  if (parts.length) e.setDescription(truncate(parts.join("\n\n")));
  e.setFooter({ text: footer && String(footer).trim() ? footer : BRAND.NAME });
  e.setTimestamp();
  return e;
}

function buildRichPanel({
  title,
  color = SURFACE,
  description,
  fields = [],
  footer,
  thumbnail,
  timestamp = true
} = {}) {
  const e = new EmbedBuilder().setColor(color);
  if (title) e.setTitle(String(title).slice(0, 256));
  if (description) e.setDescription(truncate(String(description)));
  if (thumbnail) e.setThumbnail(String(thumbnail));
  const safeFields = (Array.isArray(fields) ? fields : [])
    .slice(0, 25)
    .filter((field) => field?.name)
    .map((field) => ({
      name: String(field.name).slice(0, 256),
      value: truncateFieldValue(field.value),
      inline: Boolean(field.inline)
    }));
  if (safeFields.length) e.addFields(safeFields);
  e.setFooter({ text: footer && String(footer).trim() ? footer : BRAND.NAME });
  if (timestamp !== false) e.setTimestamp();
  return e;
}

module.exports = { SURFACE, SUCCESS, DANGER, WARN, INFO, MUTED, PURPLE, TEAL, buildPanel, buildRichPanel };
