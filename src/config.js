require("dotenv").config();

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing env var: ${name}`);
  return v.trim();
}

function normalizeKbUrl(input) {
  const raw = input.trim();
  if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(raw)) return raw;

  const blobMatch = raw.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i
  );
  if (blobMatch) {
    const [, owner, repo, ref, filePath] = blobMatch;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
  }

  return raw;
}

function requiredUrl(name) {
  const value = normalizeKbUrl(required(name));
  try {
    new URL(value);
  } catch {
    throw new Error(`Invalid URL in env var ${name}: ${value}`);
  }
  return value;
}

const BRAND = {
  NAME: "KiciaHook Director",
  DOCS_JUMP_URL: "https://discord.com/channels/1279483425002361003/1484218540499140891",
  TICKET_JUMP_URL: "https://discord.com/channels/1279483425002361003/1484218571478532147"
};

module.exports = {
  DISCORD_TOKEN: required("DISCORD_TOKEN"),
  KB_URL: requiredUrl("KB_URL"),
  BRAND,
  OWNER_USER_ID: "847703912932311091",
  DEFAULT_STATUS: "UP",
  USER_COOLDOWN_MS: 30 * 1000,
  GLOBAL_COOLDOWN_MS: 5 * 1000,
  USER_COOLDOWN_EMOJI: "🧊",
  GLOBAL_COOLDOWN_EMOJI: "🚧",
  RECENT_CHANNEL_MESSAGES_N: 20,
  TRANSCRIPT_N: 3
};
