process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionsBitField } = require("discord.js");
const os = require("os");
const path = require("path");

const {
  isScamReviewInteraction,
  canReviewScamDecision,
  maybeHandleScamReviewInteraction
} = require("../src/handlers/scam-review");
const {
  SCAM_REVIEW_TRUE_PREFIX,
  SCAM_REVIEW_FALSE_PREFIX
} = require("../src/components");
const {
  recordScamDecisionAudit,
  labelScamDecisionAudit,
  listScamDecisionAudit,
  clearScamDecisionAuditForTests,
  resetRestrictedEmojiDatabaseForTests
} = require("../src/restricted-emoji-db");
const {
  buildSellingDmPayload,
  buildSuspiciousDmPayload,
  buildSellingLogPanel,
  buildSuspiciousLogPanel,
  detectSellingSignal
} = require("../src/handlers/moderation");

const testDbPath = path.join(os.tmpdir(), `kicialite-scam-review-test-${process.pid}.sqlite`);

const STAFF_ROLE_ID = "1298767464678559794";

function buildMember({ roleIds = [], permissions = [] } = {}) {
  return {
    displayName: "Test Staff",
    roles: {
      cache: {
        has: (id) => roleIds.includes(id)
      }
    },
    permissions: new PermissionsBitField(permissions)
  };
}

function buildInteraction(customId, {
  userId = "staff-123",
  roleIds = [STAFF_ROLE_ID],
  inGuild = true,
  existingEmbeds = [{ data: { description: "original body" } }]
} = {}) {
  const replies = [];
  const edits = [];

  const interaction = {
    customId,
    deferred: false,
    replied: false,
    member: buildMember({ roleIds }),
    user: {
      id: userId,
      username: "staffuser",
      tag: "staffuser#0001"
    },
    message: {
      embeds: existingEmbeds,
      edit: async (payload) => {
        edits.push(payload);
      }
    },
    isButton: () => true,
    inGuild: () => inGuild,
    reply: async (payload) => {
      interaction.replied = true;
      replies.push(payload);
    },
    followUp: async (payload) => {
      replies.push(payload);
    }
  };

  return { interaction, replies, edits };
}

function buildMinimalMessage(content = "selling config cheap") {
  return {
    id: "msg-1",
    content,
    guildId: "guild-1",
    channelId: "channel-1",
    url: "https://discord.com/channels/guild-1/channel-1/msg-1",
    author: {
      id: "user-1",
      bot: false,
      username: "baduser",
      displayAvatarURL: () => null
    },
    member: {
      roles: { cache: { has: () => false } },
      permissions: new PermissionsBitField([]),
      moderatable: true,
      timeout: async () => {}
    }
  };
}

test.before(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
});

test.after(async () => {
  await resetRestrictedEmojiDatabaseForTests(testDbPath);
});

test.afterEach(async () => {
  await clearScamDecisionAuditForTests();
});

// ---- isScamReviewInteraction ----

test("isScamReviewInteraction recognises true_positive prefix", () => {
  const result = isScamReviewInteraction(`${SCAM_REVIEW_TRUE_PREFIX}42`);
  assert.deepEqual(result, { label: "true_positive", auditId: "42" });
});

test("isScamReviewInteraction recognises false_positive prefix", () => {
  const result = isScamReviewInteraction(`${SCAM_REVIEW_FALSE_PREFIX}7`);
  assert.deepEqual(result, { label: "false_positive", auditId: "7" });
});

test("isScamReviewInteraction returns null for unrelated customId", () => {
  assert.equal(isScamReviewInteraction("outage:confirm:99"), null);
  assert.equal(isScamReviewInteraction(""), null);
  assert.equal(isScamReviewInteraction(null), null);
});

// ---- canReviewScamDecision ----

test("canReviewScamDecision allows staff role", () => {
  const member = buildMember({ roleIds: [STAFF_ROLE_ID] });
  assert.equal(canReviewScamDecision(member, "someone"), true);
});

test("canReviewScamDecision denies user with no staff role", () => {
  const member = buildMember({ roleIds: [] });
  assert.equal(canReviewScamDecision(member, "someone"), false);
});

// ---- permission denial ----

test("maybeHandleScamReviewInteraction — non-staff gets Staff Only ephemeral", async () => {
  const { interaction, replies } = buildInteraction(`${SCAM_REVIEW_TRUE_PREFIX}1`, {
    userId: "random-user",
    roleIds: []
  });

  const handled = await maybeHandleScamReviewInteraction(interaction);
  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  const embed = replies[0].embeds?.[0];
  assert.ok(embed, "should have embed");
  const panelJson = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
  assert.match(panelJson.title || panelJson.author?.name || "", /Staff Only/i);
});

// ---- not a button ----

test("maybeHandleScamReviewInteraction — non-button interaction returns true without replying", async () => {
  const { interaction, replies } = buildInteraction(`${SCAM_REVIEW_TRUE_PREFIX}1`, {
    roleIds: [STAFF_ROLE_ID]
  });
  interaction.isButton = () => false;

  const handled = await maybeHandleScamReviewInteraction(interaction);
  assert.equal(handled, true);
  assert.equal(replies.length, 0);
});

// ---- successful Correct click ----

test("maybeHandleScamReviewInteraction — Correct click sets true_positive and disables buttons", async () => {
  const inserted = await recordScamDecisionAudit({
    action: "test_action",
    handled: true,
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "msg-1",
    userId: "user-1",
    messageContent: "selling config"
  });
  const auditId = inserted.id;
  assert.ok(auditId > 0, "should have valid auditId");

  const { interaction, replies, edits } = buildInteraction(`${SCAM_REVIEW_TRUE_PREFIX}${auditId}`, {
    roleIds: [STAFF_ROLE_ID]
  });

  const handled = await maybeHandleScamReviewInteraction(interaction);
  assert.equal(handled, true);

  assert.equal(edits.length, 1, "source message should be edited");
  const editedComponents = edits[0].components || [];
  assert.ok(editedComponents.length > 0, "should have disabled button row");
  const buttonJson = editedComponents[0].toJSON?.() || editedComponents[0];
  assert.ok(
    (buttonJson.components || []).every((b) => b.disabled),
    "all buttons should be disabled"
  );

  assert.equal(replies.length, 1, "should reply ephemerally");
  const replyEmbed = replies[0].embeds?.[0];
  const replyPanelJson = typeof replyEmbed?.toJSON === "function" ? replyEmbed.toJSON() : replyEmbed;
  assert.match(replyPanelJson.title || replyPanelJson.author?.name || "", /Review Saved/i);
  assert.match(replyPanelJson.description || "", /Correct/i);

  const rows = await listScamDecisionAudit({ limit: 1 });
  assert.equal(rows[0].review.label, "true_positive");
});

// ---- successful False Positive click ----

test("maybeHandleScamReviewInteraction — False Positive click sets false_positive", async () => {
  const inserted = await recordScamDecisionAudit({
    action: "test_fp",
    handled: true,
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "msg-2",
    userId: "user-2",
    messageContent: "asking about prices"
  });
  const auditId = inserted.id;

  const { interaction, replies } = buildInteraction(`${SCAM_REVIEW_FALSE_PREFIX}${auditId}`, {
    roleIds: [STAFF_ROLE_ID]
  });

  await maybeHandleScamReviewInteraction(interaction);

  const rows = await listScamDecisionAudit({ limit: 1 });
  assert.equal(rows[0].review.label, "false_positive");
  assert.equal(replies.length, 1);
  const replyEmbed = replies[0].embeds?.[0];
  const replyJson = typeof replyEmbed?.toJSON === "function" ? replyEmbed.toJSON() : replyEmbed;
  assert.match(replyJson.description || "", /False Positive/i);
});

// ---- re-labeling mentions previous label ----

test("maybeHandleScamReviewInteraction — re-labeling mentions previous label in reply", async () => {
  const inserted = await recordScamDecisionAudit({
    action: "test_relabel",
    handled: true,
    guildId: "guild-1",
    channelId: "channel-1",
    messageId: "msg-3",
    userId: "user-3",
    messageContent: "buy accounts here"
  });
  const auditId = inserted.id;

  await labelScamDecisionAudit({ id: auditId, label: "true_positive", reviewedBy: "staff-1" });

  const { interaction, replies } = buildInteraction(`${SCAM_REVIEW_FALSE_PREFIX}${auditId}`, {
    roleIds: [STAFF_ROLE_ID]
  });

  await maybeHandleScamReviewInteraction(interaction);

  assert.equal(replies.length, 1);
  const replyEmbed = replies[0].embeds?.[0];
  const replyJson = typeof replyEmbed?.toJSON === "function" ? replyEmbed.toJSON() : replyEmbed;
  assert.match(replyJson.description || "", /previously/i);
  assert.match(replyJson.description || "", /true positive/i);
});

// ---- recordScamDecisionAudit returns { id } ----

test("recordScamDecisionAudit returns object with numeric id", async () => {
  const result = await recordScamDecisionAudit({
    action: "audit_id_test",
    handled: true,
    guildId: "guild-1",
    channelId: "ch-1",
    messageId: "m-1",
    userId: "u-1",
    messageContent: "test"
  });

  assert.ok(result && typeof result === "object", "should return object");
  assert.ok(typeof result.id === "number", "id should be a number");
  assert.ok(result.id > 0, "id should be positive");
});

// ---- user DM payloads do not contain internals ----

test("buildSellingDmPayload does not contain Confidence, Trigger, Why, or Message fields", () => {
  const message = buildMinimalMessage("selling kicia config");
  const signals = detectSellingSignal("selling kicia config") ? [detectSellingSignal("selling kicia config")] : [{ reason: "selling config", confidence: 80 }];
  const state = { confidence: 80, trigger: "sell_context", action: "timeout", count: 1, repeatThreshold: 3, durationMs: 3600000 };

  const payload = buildSellingDmPayload({ message, signals, state, durationMs: 3600000 });
  const body = payload.embeds[0].toJSON?.()?.description || payload.embeds[0]?.data?.description || "";

  assert.ok(!body.includes("**Confidence:**"), "should not include Confidence");
  assert.ok(!body.includes("**Trigger:**"), "should not include Trigger");
  assert.ok(!body.includes("**Why:**"), "should not include Why");
  assert.ok(!body.includes("**Message:**"), "should not include Message");
  assert.match(body, /scam\/trade|prohibited-goods/i, "should contain friendly explanation");
});

test("buildSuspiciousDmPayload does not contain Confidence, Trigger, Why, or Message fields", () => {
  const message = buildMinimalMessage("dm me for the file");
  const signals = [{ reason: "dm steering", confidence: 70 }];

  const timeoutPayload = buildSuspiciousDmPayload({
    message, signals, action: "timeout", durationMs: 3600000, count: 2, confidence: 70
  });
  const timeoutBody = timeoutPayload.embeds[0].toJSON?.()?.description || timeoutPayload.embeds[0]?.data?.description || "";

  assert.ok(!timeoutBody.includes("**Confidence:**"), "should not include Confidence");
  assert.ok(!timeoutBody.includes("**Trigger:**"), "should not include Trigger");
  assert.ok(!timeoutBody.includes("**Why:**"), "should not include Why");
  assert.ok(!timeoutBody.includes("**Message:**"), "should not include Message");
  assert.match(timeoutBody, /flagged as suspicious/i);

  const warnPayload = buildSuspiciousDmPayload({
    message, signals, action: "warn", durationMs: 600000, count: 1, confidence: 60
  });
  const warnBody = warnPayload.embeds[0].toJSON?.()?.description || warnPayload.embeds[0]?.data?.description || "";
  assert.ok(!warnBody.includes("**Confidence:**"), "should not include Confidence");
  assert.ok(!warnBody.includes("**Why:**"), "should not include Why");
  assert.match(warnBody, /flagged as suspicious/i);
});

// ---- log panels attach components when auditId is present ----

test("buildSellingLogPanel includes components array when auditId is provided", () => {
  const message = buildMinimalMessage("selling kicia config");
  const signals = [{ reason: "selling config", confidence: 80, type: "selling" }];
  const state = { confidence: 80, trigger: "sell_context", action: "timeout", count: 1, repeatThreshold: 3, durationMs: 3600000 };
  const timeoutResult = { applied: true, reason: "" };
  const deleteResult = { queued: false, deleted: false };

  const panelWithAudit = buildSellingLogPanel({
    message, signals, state, deleteResult, timeoutResult,
    dmSent: true, durationMs: 3600000, recentMessages: [], auditId: 42
  });

  assert.ok(Array.isArray(panelWithAudit.components), "should have components array");
  assert.ok(panelWithAudit.components.length > 0, "components should not be empty");

  const panelWithoutAudit = buildSellingLogPanel({
    message, signals, state, deleteResult, timeoutResult,
    dmSent: true, durationMs: 3600000, recentMessages: []
  });
  assert.ok(!panelWithoutAudit.components, "should not have components when no auditId");
});

test("buildSuspiciousLogPanel includes components array when auditId is provided", () => {
  const message = buildMinimalMessage("dm me for the file");
  const signals = [{ reason: "dm steering", confidence: 70 }];
  const state = { action: "timeout", confidence: 70, trigger: "dm_steering", count: 2, highConfidence: false };
  const timeoutResult = { applied: true, reason: "" };

  const panel = buildSuspiciousLogPanel({
    message, signals, state, timeoutResult, dmSent: true, durationMs: 600000, auditId: 99
  });

  assert.ok(Array.isArray(panel.components), "should have components array");
  assert.ok(panel.components.length > 0, "components should not be empty");
  const buttonRow = panel.components[0].toJSON?.() || panel.components[0];
  const buttonIds = (buttonRow.components || []).map((b) => b.custom_id).filter(Boolean);
  assert.ok(buttonIds.some((id) => id.startsWith(SCAM_REVIEW_TRUE_PREFIX)), "should have true_positive button");
  assert.ok(buttonIds.some((id) => id.startsWith(SCAM_REVIEW_FALSE_PREFIX)), "should have false_positive button");
});
