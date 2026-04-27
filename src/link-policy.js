const { BRAND, TRUSTED_LINK_URLS } = require("./config");

const STATIC_ALLOWED_URLS = [
  BRAND.DOCS_JUMP_URL,
  BRAND.TICKET_JUMP_URL,
  BRAND.STATUS_JUMP_URL,
  ...TRUSTED_LINK_URLS
];
const URL_CANDIDATE_RE = /<?(?:https?:\/\/[^\s<>"'`|]+|www\.[^\s<>"'`|]+|discord\.gg\/[^\s<>"'`|]+|discord(?:app)?\.com\/invite\/[^\s<>"'`|]+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'`|]+)>?/gi;
const TRAILING_PUNCTUATION_RE = /[),.!?;:\]>]+$/;
const EXACT_ONLY_HOSTS = new Set([
  "discord.com",
  "discord.gg",
  "discordapp.com",
  "raw.githubusercontent.com"
]);
const RULE_CACHE = new WeakMap();

function trimUrlCandidate(rawValue) {
  let candidate = String(rawValue || "").trim();
  if (!candidate) return "";

  if (candidate.startsWith("<") && candidate.endsWith(">")) {
    candidate = candidate.slice(1, -1).trim();
  }

  while (candidate && TRAILING_PUNCTUATION_RE.test(candidate)) {
    candidate = candidate.replace(TRAILING_PUNCTUATION_RE, "");
  }

  return candidate;
}

function normalizeUrlCandidate(rawValue) {
  const trimmed = trimUrlCandidate(rawValue);
  if (!trimmed) return null;

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    return null;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) return null;

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const pathname = parsed.pathname ? parsed.pathname.replace(/\/+$/g, "") || "/" : "/";

  return {
    raw: trimmed,
    url: parsed.toString(),
    hostname,
    pathname,
    key: `${hostname}${pathname}`
  };
}

function extractUrlsFromText(text) {
  const matches = String(text || "").match(URL_CANDIDATE_RE) || [];
  const seen = new Set();
  const urls = [];

  for (const match of matches) {
    const normalized = normalizeUrlCandidate(match);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    urls.push(normalized);
  }

  return urls;
}

function collectUrlsFromValue(value, target) {
  if (typeof value === "string") {
    for (const url of extractUrlsFromText(value)) {
      target.push(url);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlsFromValue(item, target);
    }
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const nested of Object.values(value)) {
    collectUrlsFromValue(nested, target);
  }
}

function buildAllowedLinkRules(kb) {
  if (!kb || typeof kb !== "object") {
    return {
      exactKeys: new Set(STATIC_ALLOWED_URLS.map((url) => normalizeUrlCandidate(url)?.key).filter(Boolean)),
      rootHosts: new Set()
    };
  }

  const cached = RULE_CACHE.get(kb);
  if (cached) return cached;

  const exactKeys = new Set();
  const rootHosts = new Set();
  const foundUrls = [];

  collectUrlsFromValue(STATIC_ALLOWED_URLS, foundUrls);
  collectUrlsFromValue(kb, foundUrls);

  for (const url of foundUrls) {
    exactKeys.add(url.key);
    if (url.pathname === "/" && !EXACT_ONLY_HOSTS.has(url.hostname)) {
      rootHosts.add(url.hostname);
    }
  }

  const rules = { exactKeys, rootHosts };
  RULE_CACHE.set(kb, rules);
  return rules;
}

function isGifHost(hostname) {
  return (
    hostname === "tenor.com" ||
    hostname.endsWith(".tenor.com") ||
    hostname === "giphy.com" ||
    hostname.endsWith(".giphy.com") ||
    hostname === "gph.is" ||
    hostname.endsWith(".gph.is")
  );
}

function isGifPageHost(hostname) {
  return hostname === "klipy.com" || hostname.endsWith(".klipy.com");
}

function isGithubLikeHost(hostname) {
  return (
    hostname === "github.com" ||
    hostname.endsWith(".github.com") ||
    hostname === "githubusercontent.com" ||
    hostname.endsWith(".githubusercontent.com")
  );
}

function isGoogleHost(hostname) {
  return (
    hostname === "g.co" ||
    hostname.endsWith(".g.co") ||
    /^google\.[a-z.]+$/i.test(hostname) ||
    /\.google\.[a-z.]+$/i.test(hostname)
  );
}

function isGifLikeUrl(url) {
  if (!url) return false;
  if (/\.gif$/i.test(url.pathname || "")) return true;
  if (isGifPageHost(url.hostname) && /\/gifs?\//i.test(url.pathname || "")) return true;
  return isGifHost(url.hostname);
}

function isAllowedLink(url, rules) {
  if (!url) return false;
  if (isGifLikeUrl(url)) return true;
  if (isGithubLikeHost(url.hostname)) return true;
  if (isGoogleHost(url.hostname)) return true;
  if (rules.exactKeys.has(url.key)) return true;
  if (rules.rootHosts.has(url.hostname)) return true;
  return false;
}

function detectBlockedLinkSignal(text, { kb } = {}) {
  if (!kb) return null;

  const urls = extractUrlsFromText(text);
  if (!urls.length) return null;

  const rules = buildAllowedLinkRules(kb);
  const blockedLinks = urls.filter((url) => !isAllowedLink(url, rules));
  if (!blockedLinks.length) return null;

  return {
    type: "blocked_link",
    reason: "posted link that is not on the docs allowlist",
    blockedLinks,
    blockedCount: blockedLinks.length
  };
}

module.exports = {
  extractUrlsFromText,
  buildAllowedLinkRules,
  detectBlockedLinkSignal
};
