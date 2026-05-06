const { buildNormalizedTextForms } = require("./text");

const MAX_BAD_WORD_RULE_LENGTH = 80;
const DEFAULT_CONTENT_FILTER_RULES = [
  { id: "default:hate_slur:nword-hard-r", term: "nigger", category: "hate_slur", matcher: "nword", confidence: 99 },
  { id: "default:hate_slur:nword-soft-a", term: "nigga", category: "hate_slur", matcher: "nword", confidence: 99 },
  { id: "default:hate_slur:f-slur-short", term: "fag", category: "hate_slur", matcher: "fslur", confidence: 98 },
  { id: "default:hate_slur:f-slur-hard", term: "faggot", category: "hate_slur", matcher: "fslur", confidence: 99 },
  { id: "default:adult_content:porn", term: "porn", category: "adult_content", matcher: "adult", confidence: 94 },
  { id: "default:adult_content:eporn", term: "eporn", category: "adult_content", matcher: "adult", confidence: 94 },
  { id: "default:adult_content:hentai", term: "hentai", category: "adult_content", matcher: "adult", confidence: 94 },
  { id: "default:adult_content:cum", term: "cum", category: "adult_content", matcher: "adult", confidence: 92 },
  { id: "default:adult_content:ass", term: "ass", category: "adult_content", matcher: "adult", confidence: 88 },
  { id: "default:adult_content:asshole", term: "asshole", category: "adult_content", matcher: "adult", confidence: 92 },
  { id: "default:adult_content:ass-hole", term: "ass hole", category: "adult_content", matcher: "adult_phrase", confidence: 92 },
  { id: "default:adult_promo:sex-cam", term: "sex cam", category: "adult_promo", matcher: "adult_promo", confidence: 96 },
  { id: "default:adult_promo:sex-cam-bio", term: "sex cam in bio", category: "adult_promo", matcher: "adult_promo", confidence: 97 },
  { id: "default:adult_promo:cam-in-bio", term: "cam in bio", category: "adult_promo", matcher: "adult_promo", confidence: 94 }
];

const KNOWN_BAD_WORD_CATEGORIES = new Set([
  "hate_slur",
  "adult_content",
  "adult_promo",
  "custom"
]);

const CATEGORY_LABELS = {
  hate_slur: "hate slur",
  adult_content: "adult content",
  adult_promo: "adult promo",
  custom: "custom rule"
};

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBadWordCategory(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return KNOWN_BAD_WORD_CATEGORIES.has(normalized) ? normalized : "custom";
}

function sanitizeBadWordRuleTerm(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildBadWordRuleKey(term) {
  const forms = buildNormalizedTextForms(term);
  return forms.compactCollapsed || forms.compact || forms.normalized.replace(/\s+/g, "_");
}

function validateBadWordRuleInput({ term, category = "custom" } = {}) {
  const sanitized = sanitizeBadWordRuleTerm(term);
  if (!sanitized) {
    return {
      ok: false,
      error: "bad-word rule must not be empty"
    };
  }
  if (sanitized.length > MAX_BAD_WORD_RULE_LENGTH) {
    return {
      ok: false,
      error: `bad-word rule must be ${MAX_BAD_WORD_RULE_LENGTH} characters or less`
    };
  }
  if (/^\/.*\/[a-z]*$/i.test(sanitized)) {
    return {
      ok: false,
      error: "bad-word rules are literal text only; regex is not accepted"
    };
  }

  const forms = buildNormalizedTextForms(sanitized);
  const normalizedKey = buildBadWordRuleKey(sanitized);
  if (!normalizedKey) {
    return {
      ok: false,
      error: "bad-word rule must include at least one letter or number"
    };
  }

  return {
    ok: true,
    term: sanitized,
    category: normalizeBadWordCategory(category),
    normalizedKey,
    forms
  };
}

function containsNormalizedPhrase(normalizedText, normalizedPhrase) {
  if (!normalizedText || !normalizedPhrase) return false;
  const re = new RegExp(`(?:^| )${escapeRegExp(normalizedPhrase)}(?:$| )`, "i");
  return re.test(normalizedText);
}

function getTokens(forms) {
  return String(forms?.normalized || "").split(/\s+/).filter(Boolean);
}

function matchesNWord(forms, term = "") {
  const tokens = [
    ...getTokens(forms),
    ...String(forms?.collapsed || "").split(/\s+/).filter(Boolean)
  ];
  const normalizedTerm = buildNormalizedTextForms(term).normalized;
  if (normalizedTerm === "nigger") {
    return tokens.some((token) => /^nig+g+e+r+s?$/.test(token));
  }
  if (normalizedTerm === "nigga") {
    return tokens.some((token) => /^nig+g+(?:a|as|az|ez|z)$/.test(token));
  }
  return tokens.some((token) => /^nig+g+(?:e+r+s?|a|as|az|ez|z)$/.test(token));
}

function matchesFSlur(forms, term = "") {
  const tokens = [
    ...getTokens(forms),
    ...String(forms?.collapsed || "").split(/\s+/).filter(Boolean)
  ];
  const normalizedTerm = buildNormalizedTextForms(term).normalized;
  if (normalizedTerm === "faggot") {
    return tokens.some((token) => /^fag+g?ots?$/.test(token));
  }
  return tokens.some((token) => /^fag+(?:s|gy|gys)?$/.test(token));
}

function matchesAdultPhrase(forms, termForms) {
  const phrase = termForms.normalized;
  if (!phrase) return false;
  if (containsNormalizedPhrase(forms.normalized, phrase)) return true;
  if (containsNormalizedPhrase(forms.collapsed, termForms.collapsed)) return true;
  if (phrase === "ass hole") return /\bass\s+holes?\b/i.test(forms.normalized);
  return false;
}

function matchesAdultPromo(forms, termForms) {
  if (matchesAdultPhrase(forms, termForms)) return true;
  const normalized = forms.normalized;
  return (
    /\bsex\s+cam(?:\s+(?:in|on)\s+bio)?\b/i.test(normalized) ||
    /\b(?:porn|hentai|eporn)\s+(?:in|on)\s+bio\b/i.test(normalized) ||
    /\b(?:sex|porn|hentai)\s+cam\b/i.test(normalized) ||
    /sexcam(?:inbio)?/i.test(forms.compactCollapsed)
  );
}

function matchesAdultTerm(forms, termForms) {
  const term = termForms.normalized;
  if (!term) return false;
  if (term.includes(" ")) return matchesAdultPhrase(forms, termForms);
  if (containsNormalizedPhrase(forms.normalized, term)) return true;
  if (containsNormalizedPhrase(forms.collapsed, termForms.collapsed)) return true;
  if (term.length >= 5 && forms.compactCollapsed.includes(termForms.compactCollapsed)) return true;
  return false;
}

function getCompactBlendTerms(compact) {
  const found = [];
  if (/nigg+[a-z]{0,4}/i.test(compact)) found.push("n-word variant");
  if (/fag+(?:got|gots|gy|gys)?/i.test(compact)) found.push("f-slur variant");
  if (/porn/i.test(compact)) found.push("porn");
  if (/eporn/i.test(compact)) found.push("eporn");
  if (/hentai/i.test(compact)) found.push("hentai");
  if (/sexcam/i.test(compact)) found.push("sex cam");
  if (/cum/i.test(compact)) found.push("cum");
  return [...new Set(found)];
}

function detectCompactAdultSlurBlend(forms) {
  const compact = forms.compactCollapsed || forms.compact;
  if (!compact || compact.length < 8) return null;
  const terms = getCompactBlendTerms(compact);
  if (terms.length < 2) return null;

  return {
    id: "default:compact:adult-slur-blend",
    term: terms.join(" + "),
    category: terms.some((term) => /slur|word/i.test(term)) ? "hate_slur" : "adult_content",
    confidence: terms.some((term) => /slur|word/i.test(term)) ? 99 : 95,
    reason: `compact chained ${terms.join(", ")} content`
  };
}

function normalizeRuleRecord(rule, fallbackId = null) {
  const validation = validateBadWordRuleInput(rule);
  if (!validation.ok) return null;
  return {
    id: rule.id || fallbackId || null,
    term: validation.term,
    category: validation.category,
    normalizedKey: rule.normalizedKey || validation.normalizedKey,
    enabled: rule.enabled !== false,
    createdAt: Number(rule.createdAt || rule.created_at || 0),
    createdBy: rule.createdBy || rule.created_by || null,
    confidence: Number(rule.confidence || 90),
    matcher: rule.matcher || "literal"
  };
}

function findRuleMatch(forms, rule) {
  const normalizedRule = normalizeRuleRecord(rule);
  if (!normalizedRule?.enabled) return null;
  const termForms = buildNormalizedTextForms(normalizedRule.term);

  if (normalizedRule.matcher === "nword" && matchesNWord(forms, normalizedRule.term)) {
    return { ...normalizedRule, matched: normalizedRule.term };
  }
  if (normalizedRule.matcher === "fslur" && matchesFSlur(forms, normalizedRule.term)) {
    return { ...normalizedRule, matched: normalizedRule.term };
  }
  if (normalizedRule.matcher === "adult_promo" && matchesAdultPromo(forms, termForms)) {
    return { ...normalizedRule, matched: normalizedRule.term };
  }
  if (normalizedRule.matcher === "adult_phrase" && matchesAdultPhrase(forms, termForms)) {
    return { ...normalizedRule, matched: normalizedRule.term };
  }
  if (normalizedRule.matcher === "adult" && matchesAdultTerm(forms, termForms)) {
    return { ...normalizedRule, matched: normalizedRule.term };
  }

  const term = termForms.normalized;
  if (!term) return null;
  if (term.includes(" ")) {
    if (containsNormalizedPhrase(forms.normalized, term) || containsNormalizedPhrase(forms.collapsed, termForms.collapsed)) {
      return { ...normalizedRule, matched: normalizedRule.term };
    }
    return null;
  }

  const exactBoundaryMatch =
    containsNormalizedPhrase(forms.normalized, term) ||
    containsNormalizedPhrase(forms.collapsed, termForms.collapsed);
  if (exactBoundaryMatch) return { ...normalizedRule, matched: normalizedRule.term };

  const compactTerm = termForms.compactCollapsed;
  if (compactTerm.length >= 4 && forms.compactCollapsed.includes(compactTerm)) {
    return { ...normalizedRule, matched: normalizedRule.term, compact: true };
  }

  return null;
}

function detectContentFilterSignal(content, { rules = [] } = {}) {
  const forms = buildNormalizedTextForms(content);
  if (!forms.normalized && !forms.compact) return null;

  const matches = [];
  const compactBlend = detectCompactAdultSlurBlend(forms);
  if (compactBlend) matches.push(compactBlend);

  const activeRules = [
    ...DEFAULT_CONTENT_FILTER_RULES,
    ...(Array.isArray(rules) ? rules : [])
  ];
  for (const rule of activeRules) {
    const match = findRuleMatch(forms, rule);
    if (match) matches.push(match);
  }

  const uniqueMatches = [...new Map(matches.map((match) => [
    `${match.category}:${match.normalizedKey || match.term}`,
    match
  ])).values()];
  if (!uniqueMatches.length) return null;

  const confidence = Math.max(...uniqueMatches.map((match) => Number(match.confidence || 90)));
  const categories = [...new Set(uniqueMatches.map((match) => match.category))];
  const primaryCategory = categories.includes("hate_slur")
    ? "hate_slur"
    : categories.includes("adult_promo")
      ? "adult_promo"
      : categories[0] || "custom";
  const reasons = uniqueMatches.map((match) =>
    `${CATEGORY_LABELS[match.category] || match.category} matched: ${match.term}`
  );

  return {
    type: "content_filter",
    subtype: primaryCategory,
    source: "unicode-content-filter-v3",
    action: "delete",
    mode: "enforce",
    confidence,
    reason: reasons[0],
    reasons,
    evidence: {
      matches: uniqueMatches.map((match) => ({
        id: match.id || null,
        term: match.term,
        category: match.category,
        compact: Boolean(match.compact)
      })),
      normalized: forms.normalized,
      compact: forms.compact,
      collapsed: forms.collapsed,
      scriptMix: forms.scriptMix
    }
  };
}

function shouldRunToxicityShadowReview(content, { contentFilterSignal = null } = {}) {
  const forms = buildNormalizedTextForms(content);
  return {
    shouldRun: Boolean(
      contentFilterSignal ||
      forms.scriptMix.hasMixedScripts ||
      forms.scriptMix.hadDefaultIgnorable
    ),
    forms
  };
}

function formatContentFilterMatches(signal) {
  const matches = signal?.evidence?.matches || [];
  if (!matches.length) return "none";
  return matches
    .slice(0, 10)
    .map((match) => `- ${CATEGORY_LABELS[match.category] || match.category}: ${match.term}`)
    .join("\n");
}

function listDefaultContentFilterRules() {
  return DEFAULT_CONTENT_FILTER_RULES.map((rule) => ({
    ...rule,
    enabled: true,
    createdAt: 0,
    createdBy: null,
    normalizedKey: buildBadWordRuleKey(rule.term)
  }));
}

module.exports = {
  MAX_BAD_WORD_RULE_LENGTH,
  DEFAULT_CONTENT_FILTER_RULES,
  KNOWN_BAD_WORD_CATEGORIES,
  buildBadWordRuleKey,
  detectContentFilterSignal,
  formatContentFilterMatches,
  listDefaultContentFilterRules,
  normalizeBadWordCategory,
  sanitizeBadWordRuleTerm,
  shouldRunToxicityShadowReview,
  validateBadWordRuleInput
};
