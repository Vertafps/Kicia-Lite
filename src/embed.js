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

function safeInlineCode(value) {
  return `\`${String(value ?? "").replace(/`/g, "'") || "\u200b"}\``;
}

function isEmbedMediaUrl(value) {
  const url = String(value || "").trim();
  return /^https:\/\//i.test(url) || /^attachment:\/\//i.test(url);
}

function isTitleUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function applyAuthor(embed, author) {
  if (!author?.name) return;
  const payload = {
    name: String(author.name).slice(0, 256)
  };
  if (author.iconURL && isEmbedMediaUrl(author.iconURL)) payload.iconURL = String(author.iconURL);
  if (author.url && isTitleUrl(author.url)) payload.url = String(author.url);
  embed.setAuthor(payload);
}

function applyFooter(embed, { footer, footerIcon } = {}) {
  const payload = {
    text: footer && String(footer).trim() ? String(footer).slice(0, 2048) : BRAND.NAME
  };
  if (footerIcon && isEmbedMediaUrl(footerIcon)) payload.iconURL = String(footerIcon);
  embed.setFooter(payload);
}

function resolveAvatarURL(entity, { size = 128 } = {}) {
  const user = entity?.user || entity;
  if (typeof user?.displayAvatarURL !== "function") return null;
  return user.displayAvatarURL({
    size,
    extension: "png",
    forceStatic: true
  });
}

function colorBrightness(color) {
  const value = Number(color) || 0;
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function resolveColor(member, fallback = SURFACE) {
  const roleColor = Number(member?.roles?.highest?.color || 0);
  if (!roleColor || colorBrightness(roleColor) < 80) return fallback;
  return roleColor;
}

function buildRowFields(rows, { padRows = false } = {}) {
  const fields = (Array.isArray(rows) ? rows : [])
    .filter((row) => Array.isArray(row) && row[1] != null && String(row[1]).trim() !== "")
    .slice(0, 25)
    .map(([label, value]) => ({
      name: String(label || "\u200b").slice(0, 256),
      value: truncateFieldValue(safeInlineCode(value)),
      inline: true
    }));

  if (padRows) {
    while (fields.length && fields.length % 3 !== 0 && fields.length < 25) {
      fields.push({ name: "\u200b", value: "\u200b", inline: true });
    }
  }

  return fields;
}

function looksLikeAutoFieldLine(line) {
  return String(line || "").match(/^\s*\*\*([^*\n:][^*\n]{0,80}?):\*\*\s*(.*)$/);
}

function shouldInlineAutoField(name, value) {
  if (/\n/.test(value)) return false;
  if (String(value || "").length > 90) return false;
  return !/why|evidence|message|blocked|policy|trigger|stored|saved|visible|reason/i.test(name);
}

function parseAutoFields(body, maxFields = 18) {
  const lines = String(body || "").split(/\r?\n/);
  const description = [];
  const fields = [];
  let current = null;

  const pushCurrent = () => {
    if (!current || fields.length >= maxFields) {
      current = null;
      return;
    }
    const value = current.value.join("\n").trim() || "\u200b";
    fields.push({
      name: current.name,
      value: truncateFieldValue(value),
      inline: shouldInlineAutoField(current.name, value)
    });
    current = null;
  };

  for (const line of lines) {
    const match = looksLikeAutoFieldLine(line);
    if (match && fields.length < maxFields) {
      pushCurrent();
      current = {
        name: String(match[1]).trim().slice(0, 256),
        value: match[2] ? [String(match[2]).trim()] : []
      };
      continue;
    }

    if (current && line.trim()) {
      current.value.push(line);
      continue;
    }

    if (current && !line.trim()) {
      pushCurrent();
      continue;
    }

    description.push(line);
  }

  pushCurrent();

  return {
    description: description.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    fields
  };
}

function buildPanel({
  header,
  body,
  tip,
  tipStyle = "quote",
  tipLevel = "##",
  rows = [],
  padRows = false,
  extra,
  footer,
  footerIcon,
  author,
  thumbnail,
  image,
  url,
  titleUrl,
  color = SURFACE,
  headerLevel = "#",
  headerAsTitle = true,
  autoFields = false,
  fields,
  timestamp = true
} = {}) {
  const parts = [];
  if (header && !headerAsTitle) parts.push(`${headerLevel} ${header}`);
  const parsedBody = autoFields ? parseAutoFields(body) : { description: body, fields: [] };
  if (parsedBody.description) parts.push(parsedBody.description);
  if (tip) {
    if (tipStyle === "heading") {
      parts.push(`${tipLevel} ${tip}`);
    } else if (tipStyle === "plain") {
      parts.push(tip);
    } else {
      parts.push(`> *${tip}*`);
    }
  }
  if (extra) parts.push(`*${extra}*`);

  const e = new EmbedBuilder().setColor(color);
  applyAuthor(e, author);
  if (header && headerAsTitle) e.setTitle(String(header).slice(0, 256));
  const panelUrl = titleUrl || url;
  if (header && panelUrl && isTitleUrl(panelUrl)) e.setURL(String(panelUrl));
  if (parts.length) e.setDescription(truncate(parts.join("\n\n")));
  if (thumbnail && isEmbedMediaUrl(thumbnail)) e.setThumbnail(String(thumbnail));
  if (image && isEmbedMediaUrl(image)) e.setImage(String(image));
  const rowFields = buildRowFields(rows, { padRows });
  const extraFields = (Array.isArray(fields) ? fields : [])
    .filter((f) => f?.name)
    .map((f) => ({
      name: String(f.name).slice(0, 256),
      value: truncateFieldValue(f.value ?? "​"),
      inline: Boolean(f.inline)
    }));
  const panelFields = [...parsedBody.fields, ...rowFields, ...extraFields].slice(0, 25);
  if (panelFields.length) e.addFields(panelFields);
  applyFooter(e, { footer, footerIcon });
  if (timestamp !== false) e.setTimestamp();
  return e;
}

function buildRichPanel({
  title,
  color = SURFACE,
  description,
  fields = [],
  footer,
  footerIcon,
  author,
  thumbnail,
  image,
  url,
  titleUrl,
  timestamp = true
} = {}) {
  const e = new EmbedBuilder().setColor(color);
  applyAuthor(e, author);
  if (title) e.setTitle(String(title).slice(0, 256));
  const panelUrl = titleUrl || url;
  if (title && panelUrl && isTitleUrl(panelUrl)) e.setURL(String(panelUrl));
  if (description) e.setDescription(truncate(String(description)));
  if (thumbnail && isEmbedMediaUrl(thumbnail)) e.setThumbnail(String(thumbnail));
  if (image && isEmbedMediaUrl(image)) e.setImage(String(image));
  const safeFields = (Array.isArray(fields) ? fields : [])
    .slice(0, 25)
    .filter((field) => field?.name)
    .map((field) => ({
      name: String(field.name).slice(0, 256),
      value: truncateFieldValue(field.value),
      inline: Boolean(field.inline)
    }));
  if (safeFields.length) e.addFields(safeFields);
  applyFooter(e, { footer, footerIcon });
  if (timestamp !== false) e.setTimestamp();
  return e;
}

module.exports = {
  SURFACE,
  SUCCESS,
  DANGER,
  WARN,
  INFO,
  MUTED,
  PURPLE,
  TEAL,
  buildPanel,
  buildRichPanel,
  resolveAvatarURL,
  resolveColor
};
