"use strict";

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "eval-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const { listScamDecisionAudit } = require("../src/restricted-emoji-db");
const { classifyScamContextLocally } = require("../src/scam-local-classifier");

// TODO(human): --mode embeddings-only ablation requires the model to download on first run (~23 MB).
// When ready, wire classifyScamContextWithEmbeddings here after calling loadOrBuildCache().
const MODE_EMBEDDINGS_ONLY = process.argv.includes("--mode") &&
  process.argv[process.argv.indexOf("--mode") + 1] === "embeddings-only";

const DEFAULT_LIMIT = 250;
const POSITIVE_LABELS = new Set(["true_positive", "missed"]);
const NEGATIVE_LABELS = new Set(["false_positive", "safe"]);

function parseLimit(argv) {
  const raw = argv.find((arg) => /^\d+$/.test(arg));
  return Math.min(1000, Math.max(1, Number(raw || DEFAULT_LIMIT)));
}

function expectedVerdictForLabel(label) {
  if (POSITIVE_LABELS.has(label)) return true;
  if (NEGATIVE_LABELS.has(label)) return false;
  return null;
}

function buildContext(row) {
  const messages = Array.isArray(row.recentMessages) && row.recentMessages.length
    ? row.recentMessages
    : [row.messageContent].filter(Boolean);

  return {
    userId: row.userId,
    channelId: row.channelId,
    userMessages: messages,
    messageContexts: messages.map((content) => ({ content })),
    repliedToMessage: row.replyContent ? { content: row.replyContent } : null
  };
}

function verdictKey(value) {
  if (value === true) return "unsafe";
  if (value === false) return "safe";
  return "borderline";
}

async function main() {
  if (MODE_EMBEDDINGS_ONLY) {
    console.error("--mode embeddings-only: not yet implemented (see TODO in this file)");
    process.exit(1);
  }
  const limit = parseLimit(process.argv.slice(2));
  const rows = await listScamDecisionAudit({ limit, labeledOnly: true });
  const evaluated = rows
    .map((row) => ({
      row,
      expected: expectedVerdictForLabel(row.review?.label)
    }))
    .filter((entry) => entry.expected !== null);

  const matrix = {
    unsafe_unsafe: 0,
    unsafe_safe: 0,
    unsafe_borderline: 0,
    safe_unsafe: 0,
    safe_safe: 0,
    safe_borderline: 0
  };
  const misses = [];

  for (const entry of evaluated) {
    const result = classifyScamContextLocally(buildContext(entry.row));
    const expected = verdictKey(entry.expected);
    const actual = verdictKey(result.verdict);
    matrix[`${expected}_${actual}`] += 1;
    if (expected !== actual) {
      misses.push({
        id: entry.row.id,
        label: entry.row.review.label,
        expected,
        actual,
        confidence: result.confidence,
        reason: result.reason,
        text: entry.row.recentMessages.length
          ? entry.row.recentMessages.join(" | ")
          : entry.row.messageContent
      });
    }
  }

  const unsafeTotal = matrix.unsafe_unsafe + matrix.unsafe_safe + matrix.unsafe_borderline;
  const safeTotal = matrix.safe_unsafe + matrix.safe_safe + matrix.safe_borderline;
  const precisionDenominator = matrix.unsafe_unsafe + matrix.safe_unsafe;
  const recallDenominator = unsafeTotal;
  const precision = precisionDenominator ? matrix.unsafe_unsafe / precisionDenominator : null;
  const recall = recallDenominator ? matrix.unsafe_unsafe / recallDenominator : null;

  console.log(JSON.stringify({
    rowsRead: rows.length,
    evaluated: evaluated.length,
    unsafeTotal,
    safeTotal,
    precision,
    recall,
    matrix,
    misses: misses.slice(0, 25)
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
