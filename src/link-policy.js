const { domainToASCII, domainToUnicode } = require("node:url");
const { BRAND, TRUSTED_LINK_URLS } = require("./config");
const { isEditDistanceAtMost, normalizeText } = require("./text");

const STATIC_ALLOWED_URLS = [
  BRAND.DOCS_JUMP_URL,
  BRAND.TICKET_JUMP_URL,
  BRAND.STATUS_JUMP_URL,
  ...TRUSTED_LINK_URLS
];
const URL_CANDIDATE_RE = /<?(?:hxxps?:\/\/[^\s<>"'`|]+|https?:\/\/[^\s<>"'`|]+|www\.[^\s<>"'`|]+|discord\.gg\/[^\s<>"'`|]+|discord(?:app)?\.com\/invite\/[^\s<>"'`|]+|(?:[\p{L}a-z0-9-]+\.)+(?:[\p{L}a-z]{2,}|xn--[a-z0-9-]{2,})\/[^\s<>"'`|]+)>?/giu;
const MARKDOWN_LINK_RE = /\[([^\]\n]{1,160})\]\((<?(?:hxxps?:\/\/|https?:\/\/|www\.|discord\.gg\/|discord(?:app)?\.com\/invite\/|(?:[\p{L}a-z0-9-]+\.)+(?:[\p{L}a-z]{2,}|xn--[a-z0-9-]{2,})\/)[^)>\s]+>?)\)/giu;
const TRAILING_PUNCTUATION_RE = /[),.!?;:\]>]+$/;
const INVISIBLE_URL_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const DOT_VARIANTS_RE = /[\u3002\uFF0E\uFF61]/g;
const EXACT_ONLY_HOSTS = new Set([
  "discord.com",
  "discord.gg",
  "discordapp.com",
  "raw.githubusercontent.com"
]);
const FILE_SHARING_HOSTS = [
  "gofile.io",
  "mega.nz",
  "mega.io",
  "mega.co.nz",
  "mediafire.com",
  "pixeldrain.com",
  "krakenfiles.com",
  "workupload.com",
  "file.io",
  "sendspace.com",
  "anonfiles.com",
  "bayfiles.com",
  "modsfire.com",
  "upload.ee",
  "terabox.com",
  "4shared.com"
];
const URL_SHORTENER_HOSTS = [
  "bit.ly",
  "tinyurl.com",
  "cutt.ly",
  "is.gd",
  "soo.gd",
  "s.id",
  "rebrand.ly",
  "shorturl.at",
  "t.ly",
  "rb.gy",
  "ow.ly",
  "buff.ly"
];
const PROTECTED_DOMAINS = [
  "discord.com",
  "discord.gg",
  "discordapp.com",
  "github.com",
  "google.com",
  "youtube.com",
  "roblox.com",
  "kiciahook.gitbook.io"
];
const DANGEROUS_EXTENSIONS = new Set([
  ".exe",
  ".scr",
  ".com",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".vbe",
  ".js",
  ".jse",
  ".msi",
  ".jar",
  ".apk",
  ".appx",
  ".hta",
  ".reg",
  ".zip",
  ".rar",
  ".7z",
  ".iso",
  ".img"
]);
const SAFE_SEARCH_HOSTS = [
  "bing.com",
  "duckduckgo.com",
  "yahoo.com",
  "brave.com",
  "search.brave.com",
  "ecosia.org",
  "startpage.com"
];
const RULE_CACHE = new WeakMap();

function stripInvisibleUrlText(value) {
  return String(value || "")
    .replace(INVISIBLE_URL_RE, "")
    .replace(DOT_VARIANTS_RE, ".");
}

function trimUrlCandidate(rawValue) {
  let candidate = stripInvisibleUrlText(rawValue).trim();
  if (!candidate) return "";

  if (candidate.startsWith("<") && candidate.endsWith(">")) {
    candidate = candidate.slice(1, -1).trim();
  }

  candidate = candidate.replace(/^hxxp/i, "http");

  while (candidate && TRAILING_PUNCTUATION_RE.test(candidate)) {
    candidate = candidate.replace(TRAILING_PUNCTUATION_RE, "");
  }

  return candidate;
}

function safeDomainToAscii(hostname) {
  try {
    return domainToASCII(hostname) || hostname;
  } catch {
    return hostname;
  }
}

function safeDomainToUnicode(hostname) {
  try {
    return domainToUnicode(hostname) || hostname;
  } catch {
    return hostname;
  }
}

function skeletonizeHostname(hostname) {
  return safeDomainToUnicode(hostname)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0430\u03B1]/g, "a")
    .replace(/[\u0184]/g, "b")
    .replace(/[\u0441\u0421\u03F2]/g, "c")
    .replace(/[\u0501]/g, "d")
    .replace(/[\u0435\u0451\u03B5]/g, "e")
    .replace(/[\u0261]/g, "g")
    .replace(/[\u04BB]/g, "h")
    .replace(/[\u0456\u0406\u03B9\u0131]/g, "i")
    .replace(/[\u0458]/g, "j")
    .replace(/[\u04CF\u217C]/g, "l")
    .replace(/[\u043C\u03BC]/g, "m")
    .replace(/[\u043E\u03BF]/g, "o")
    .replace(/[\u0440\u03C1]/g, "p")
    .replace(/[\u0455]/g, "s")
    .replace(/[\u0442]/g, "t")
    .replace(/[\u0445\u03C7]/g, "x")
    .replace(/[\u0443]/g, "y")
    .replace(/[0]/g, "o")
    .replace(/[1!|]/g, "l")
    .replace(/[3]/g, "e")
    .replace(/[5$]/g, "s");
}

function normalizePathname(pathname) {
  const cleanPath = pathname ? pathname.replace(/\/+$/g, "") || "/" : "/";
  return cleanPath;
}

function normalizeUrlCandidate(rawValue, { source = "direct", maskedLabel = null } = {}) {
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

  const rawHostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const hostname = safeDomainToAscii(rawHostname).toLowerCase().replace(/^www\./, "");
  const unicodeHostname = safeDomainToUnicode(hostname).toLowerCase();
  const pathname = normalizePathname(parsed.pathname);

  return {
    raw: trimmed,
    url: parsed.toString(),
    protocol: parsed.protocol,
    username: parsed.username,
    password: parsed.password,
    hostname,
    unicodeHostname,
    skeletonHostname: skeletonizeHostname(hostname),
    pathname,
    search: parsed.search || "",
    source,
    maskedLabel,
    isIdn: hostname.includes("xn--") || unicodeHostname !== hostname,
    key: `${hostname}${pathname}`
  };
}

function buildDeobfuscatedText(text) {
  return stripInvisibleUrlText(text)
    .replace(/\bhxxps?:\/\//gi, (match) => match.replace(/^hxxp/i, "http"))
    .replace(/\s*(?:\[\s*dot\s*\]|\(\s*dot\s*\)|\{\s*dot\s*\})\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".")
    .replace(/\s*(?:\[\s*(?:slash|\/)\s*\]|\(\s*slash\s*\)|\{\s*slash\s*\})\s*/gi, "/")
    .replace(/\s+slash\s+/gi, "/");
}

function sameSite(hostname, expectedHost) {
  return hostname === expectedHost || hostname.endsWith(`.${expectedHost}`);
}

function matchesAnyHost(hostname, hostList) {
  return hostList.some((host) => sameSite(hostname, host));
}

function getRegistrableDomain(hostname) {
  const labels = String(hostname || "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  return labels.slice(-2).join(".");
}

function isKnownHighRiskHost(hostname) {
  return matchesAnyHost(hostname, FILE_SHARING_HOSTS) || matchesAnyHost(hostname, URL_SHORTENER_HOSTS);
}

function shouldKeepObfuscatedUrl(url) {
  if (!url) return false;
  return isKnownHighRiskHost(url.hostname) || Boolean(getProtectedLookalikeReason(url));
}

function mergeUrl(target, candidate) {
  if (!target.maskedLabel && candidate.maskedLabel) {
    target.maskedLabel = candidate.maskedLabel;
  }
  if (target.source !== "direct" && candidate.source === "direct") {
    target.source = "direct";
    target.raw = candidate.raw;
    target.url = candidate.url;
  }
  return target;
}

function addNormalizedUrl(urls, byKey, candidate, { keepObfuscated = true } = {}) {
  if (!candidate) return;
  if (candidate.source === "obfuscated" && (!keepObfuscated || !shouldKeepObfuscatedUrl(candidate))) return;

  const existing = byKey.get(candidate.key);
  if (existing) {
    mergeUrl(existing, candidate);
    return;
  }

  byKey.set(candidate.key, candidate);
  urls.push(candidate);
}

function collectRegexUrls(text, urls, byKey, { source = "direct", keepObfuscated = true } = {}) {
  const matches = String(text || "").match(URL_CANDIDATE_RE) || [];
  for (const match of matches) {
    addNormalizedUrl(urls, byKey, normalizeUrlCandidate(match, { source }), { keepObfuscated });
  }
}

function collectMarkdownUrls(text, urls, byKey) {
  const content = String(text || "");
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const [, label, rawUrl] = match;
    addNormalizedUrl(
      urls,
      byKey,
      normalizeUrlCandidate(rawUrl, {
        source: "direct",
        maskedLabel: label.trim()
      })
    );
  }
}

function extractUrlsFromText(text, { includeMarkdown = true, includeObfuscated = true } = {}) {
  const urls = [];
  const byKey = new Map();
  const cleanText = stripInvisibleUrlText(text);

  if (includeMarkdown) {
    collectMarkdownUrls(cleanText, urls, byKey);
  }
  collectRegexUrls(cleanText, urls, byKey);

  if (includeObfuscated) {
    const deobfuscated = buildDeobfuscatedText(cleanText);
    if (deobfuscated !== cleanText) {
      collectRegexUrls(deobfuscated, urls, byKey, {
        source: "obfuscated",
        keepObfuscated: true
      });
    }
  }

  return urls;
}

function collectUrlsFromValue(value, target) {
  if (typeof value === "string") {
    for (const url of extractUrlsFromText(value, { includeObfuscated: false })) {
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

function buildAllowedLinkRules(kb, { trustedLinks = [] } = {}) {
  const hasDynamicTrustedLinks = Array.isArray(trustedLinks) && trustedLinks.length > 0;
  const trustedValues = Array.isArray(trustedLinks) ? trustedLinks.map((link) => link?.url || link) : [];

  if (!kb || typeof kb !== "object") {
    return {
      exactKeys: new Set([
        ...STATIC_ALLOWED_URLS,
        ...trustedValues
      ].map((url) => normalizeUrlCandidate(url)?.key).filter(Boolean)),
      rootHosts: new Set()
    };
  }

  const cached = hasDynamicTrustedLinks ? null : RULE_CACHE.get(kb);
  if (cached) return cached;

  const exactKeys = new Set();
  const rootHosts = new Set();
  const foundUrls = [];

  collectUrlsFromValue(STATIC_ALLOWED_URLS, foundUrls);
  collectUrlsFromValue(trustedValues, foundUrls);
  collectUrlsFromValue(kb, foundUrls);

  for (const url of foundUrls) {
    exactKeys.add(url.key);
    if (url.pathname === "/" && !EXACT_ONLY_HOSTS.has(url.hostname)) {
      rootHosts.add(url.hostname);
    }
  }

  const rules = { exactKeys, rootHosts };
  if (!hasDynamicTrustedLinks) {
    RULE_CACHE.set(kb, rules);
  }
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

function isYouTubeHost(hostname) {
  return (
    hostname === "youtu.be" ||
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "youtube-nocookie.com" ||
    hostname.endsWith(".youtube-nocookie.com")
  );
}

function isRobloxHost(hostname) {
  return hostname === "roblox.com" || hostname.endsWith(".roblox.com");
}

function isSearchHost(hostname) {
  return matchesAnyHost(hostname, SAFE_SEARCH_HOSTS);
}

function isKiciaDocsHost(hostname) {
  return hostname === "kiciahook.gitbook.io" || hostname.endsWith(".kiciahook.gitbook.io");
}

function isGifLikeUrl(url) {
  if (!url) return false;
  if (/\.gif$/i.test(url.pathname || "")) return true;
  if (isGifPageHost(url.hostname) && /\/gifs?\//i.test(url.pathname || "")) return true;
  return isGifHost(url.hostname);
}

function isRuleAllowedLink(url, rules) {
  if (!url || !rules) return false;
  if (rules.exactKeys.has(url.key)) return true;
  if (rules.rootHosts.has(url.hostname)) return true;
  return false;
}

function isGenericSafeLink(url) {
  if (!url) return false;
  return (
    isGithubLikeHost(url.hostname) ||
    isGoogleHost(url.hostname) ||
    isYouTubeHost(url.hostname) ||
    isRobloxHost(url.hostname) ||
    isSearchHost(url.hostname) ||
    isKiciaDocsHost(url.hostname)
  );
}

function isAllowedLink(url, rules) {
  if (!url) return false;
  if (isRuleAllowedLink(url, rules)) return true;
  if (isGifLikeUrl(url)) return true;
  if (hasDangerousFileExtension(url) || getProtectedLookalikeReason(url)) return false;
  return isGenericSafeLink(url);
}

function getPathExtension(url) {
  const pathOnly = String(url?.pathname || "").split(/[?#]/)[0].toLowerCase();
  const match = pathOnly.match(/(\.[a-z0-9]{1,6})$/i);
  return match ? match[1] : "";
}

function hasDangerousFileExtension(url) {
  return DANGEROUS_EXTENSIONS.has(getPathExtension(url));
}

function isDiscordInviteUrl(url) {
  return (
    url?.hostname === "discord.gg" ||
    url?.hostname === "discordapp.com" && url.pathname.startsWith("/invite") ||
    url?.hostname === "discord.com" && url.pathname.startsWith("/invite")
  );
}

function isIpAddressHost(hostname) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || /^\[[0-9a-f:]+\]$/i.test(hostname);
}

function getProtectedLookalikeReason(url) {
  if (!url?.hostname) return null;

  for (const protectedHost of PROTECTED_DOMAINS) {
    if (sameSite(url.hostname, protectedHost)) continue;

    const protectedSkeleton = skeletonizeHostname(protectedHost);
    const hostSkeleton = url.skeletonHostname || skeletonizeHostname(url.hostname);
    if (sameSite(hostSkeleton, protectedSkeleton)) {
      return `domain looks like ${protectedHost} but resolves to ${url.hostname}`;
    }

    const hostDomain = getRegistrableDomain(hostSkeleton);
    const protectedDomain = getRegistrableDomain(protectedSkeleton);
    const [hostLabel, hostTld] = hostDomain.split(".");
    const [protectedLabel, protectedTld] = protectedDomain.split(".");
    if (
      hostTld &&
      protectedTld &&
      hostTld === protectedTld &&
      hostLabel?.[0] === protectedLabel?.[0] &&
      isEditDistanceAtMost(hostLabel, protectedLabel, 1)
    ) {
      return `domain is one typo away from ${protectedHost}`;
    }
  }

  return null;
}

function getEmbeddedProtectedBrandReason(url) {
  if (!url?.hostname) return null;
  if (isGenericSafeLink(url)) return null;
  const hostLabels = String(url.skeletonHostname || skeletonizeHostname(url.hostname)).split(".").filter(Boolean);

  for (const protectedHost of PROTECTED_DOMAINS) {
    if (sameSite(url.hostname, protectedHost)) continue;

    const protectedLabels = skeletonizeHostname(protectedHost).split(".").filter(Boolean);
    for (let i = 0; i <= hostLabels.length - protectedLabels.length; i += 1) {
      const window = hostLabels.slice(i, i + protectedLabels.length);
      if (window.join(".") === protectedLabels.join(".")) {
        return `domain embeds ${protectedHost} inside another host`;
      }
    }

    const protectedBrand = protectedLabels[0];
    const firstLabel = hostLabels[0] || "";
    if (firstLabel.startsWith(`${protectedBrand}-`) || firstLabel.endsWith(`-${protectedBrand}`)) {
      return `domain uses the ${protectedBrand} brand outside the official host`;
    }
  }

  return null;
}

function getMaskedLinkReason(url) {
  const label = String(url?.maskedLabel || "").trim();
  if (!label) return null;

  const labelUrls = extractUrlsFromText(label, {
    includeMarkdown: false,
    includeObfuscated: false
  });
  const labelUrl = labelUrls[0] || null;
  if (labelUrl && getRegistrableDomain(labelUrl.hostname) !== getRegistrableDomain(url.hostname)) {
    return `masked link shows ${labelUrl.hostname} but opens ${url.hostname}`;
  }

  const normalizedLabel = normalizeText(label);
  const protectedBrand = [
    ["discord", "discord.com"],
    ["github", "github.com"],
    ["google", "google.com"],
    ["youtube", "youtube.com"],
    ["roblox", "roblox.com"],
    ["kicia", "kiciahook.gitbook.io"],
    ["docs", "kiciahook.gitbook.io"],
    ["status", "discord.com"]
  ].find(([brand]) => normalizedLabel.includes(brand));

  if (protectedBrand && !sameSite(url.hostname, protectedBrand[1])) {
    return `masked link label mentions ${protectedBrand[0]} but opens ${url.hostname}`;
  }

  return null;
}

function hasScamLinkContext(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return (
    /\b(?:free premium|free nitro|nitro gift|steam gift|robux generator|free robux)\b/.test(normalized) ||
    /\b(?:cracked|leaked|crack|stealer|token grabber|cookie logger)\b/.test(normalized) ||
    /\b(?:paste|run|download|open)\s+this\b/.test(normalized) ||
    /\b(?:disable|turn off)\s+(?:antivirus|defender|windows defender)\b/.test(normalized) ||
    /\b(?:login|verify|verification)\s+(?:here|now|account)\b/.test(normalized)
  );
}

function addRisk(risks, score, reason) {
  if (!reason) return;
  risks.push({ score, reason });
}

function getActionForScore(score) {
  if (score >= 85) return "timeout";
  if (score >= 55) return "warn";
  if (score >= 35) return "review";
  return null;
}

function getThreatLevelForAction(action) {
  if (action === "timeout") return "high";
  if (action === "warn") return "medium";
  if (action === "review") return "low";
  return "none";
}

function assessUrlRisk(url, rules, contextText) {
  if (!url) return null;
  if (isRuleAllowedLink(url, rules) || isGifLikeUrl(url)) return null;

  const risks = [];
  addRisk(risks, 95, matchesAnyHost(url.hostname, FILE_SHARING_HOSTS) ? "file-sharing host is blocked" : null);
  addRisk(risks, 95, getProtectedLookalikeReason(url));
  addRisk(risks, 88, getEmbeddedProtectedBrandReason(url));
  addRisk(risks, 92, getMaskedLinkReason(url));
  addRisk(risks, 90, hasDangerousFileExtension(url) ? `dangerous file extension ${getPathExtension(url)}` : null);
  addRisk(risks, 86, url.username || url.password ? "URL uses a misleading username/password segment" : null);
  addRisk(
    risks,
    82,
    url.source === "obfuscated" && isKnownHighRiskHost(url.hostname)
      ? "blocked host was written in an obfuscated form"
      : null
  );

  const structuralScore = risks.reduce((max, risk) => Math.max(max, risk.score), 0);
  if (!structuralScore && isGenericSafeLink(url)) return null;

  addRisk(risks, 80, hasScamLinkContext(contextText) ? "scam-like wording appears with a link" : null);
  addRisk(risks, 70, isDiscordInviteUrl(url) ? "unapproved Discord invite" : null);
  addRisk(risks, 68, matchesAnyHost(url.hostname, URL_SHORTENER_HOSTS) ? "URL shortener hides the destination" : null);
  addRisk(risks, 60, url.source === "obfuscated" ? "URL was written in an obfuscated form" : null);
  addRisk(risks, 55, isIpAddressHost(url.hostname) ? "raw IP address link" : null);
  addRisk(risks, 45, url.isIdn ? "internationalized domain needs staff review" : null);

  if (!risks.length) return null;

  const score = risks.reduce((max, risk) => Math.max(max, risk.score), 0);
  const action = getActionForScore(score);
  if (!action) return null;

  return {
    ...url,
    action,
    threatLevel: getThreatLevelForAction(action),
    confidence: score,
    reasons: [...new Set(risks.sort((a, b) => b.score - a.score).map((risk) => risk.reason))]
  };
}

function pickStrongestAction(signals) {
  if (signals.some((signal) => signal.action === "timeout")) return "timeout";
  if (signals.some((signal) => signal.action === "warn")) return "warn";
  return "review";
}

function detectBlockedLinkSignal(text, { kb, trustedLinks = [] } = {}) {
  if (!kb) return null;

  const urls = extractUrlsFromText(text);
  if (!urls.length) return null;

  const rules = buildAllowedLinkRules(kb, { trustedLinks });
  const blockedLinks = urls
    .map((url) => assessUrlRisk(url, rules, text))
    .filter(Boolean);
  if (!blockedLinks.length) return null;

  const action = pickStrongestAction(blockedLinks);
  const confidence = blockedLinks.reduce((max, url) => Math.max(max, url.confidence || 0), 0);
  const reasons = [...new Set(blockedLinks.flatMap((url) => url.reasons || []))];

  return {
    type: "blocked_link",
    action,
    threatLevel: getThreatLevelForAction(action),
    confidence,
    reason: reasons[0] || "risky link detected",
    reasons,
    blockedLinks,
    blockedCount: blockedLinks.length
  };
}

module.exports = {
  extractUrlsFromText,
  normalizeUrlCandidate,
  buildAllowedLinkRules,
  isAllowedLink,
  detectBlockedLinkSignal
};
