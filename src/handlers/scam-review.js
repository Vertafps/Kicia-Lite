const { EmbedBuilder } = require("discord.js");
const {
  SCAM_REVIEW_TRUE_PREFIX,
  SCAM_REVIEW_FALSE_PREFIX,
  SCAM_FEEDBACK_PREFIX,
  SCAM_FEEDBACK_CATEGORIES,
  buildScamReviewButtonRows,
  buildScamFeedbackSelectRows
} = require("../components");
const { buildPanel, DANGER, INFO, SUCCESS, WARN, brandAuthor } = require("../embed");
const { hasHigherStaffRole, hasAnyRole, isKernelUserId } = require("../permissions");
const { STAFF_ROLE_IDS } = require("../config");
const { labelScamDecisionAudit } = require("../restricted-emoji-db");
const { recordRuntimeEvent } = require("../runtime-health");

function isScamReviewInteraction(customId) {
  const id = String(customId || "");
  if (id.startsWith(SCAM_REVIEW_TRUE_PREFIX)) {
    return { label: "true_positive", auditId: id.slice(SCAM_REVIEW_TRUE_PREFIX.length) };
  }
  if (id.startsWith(SCAM_REVIEW_FALSE_PREFIX)) {
    return { label: "false_positive", auditId: id.slice(SCAM_REVIEW_FALSE_PREFIX.length) };
  }
  return null;
}

function isScamFeedbackInteraction(customId) {
  const id = String(customId || "");
  if (id.startsWith(SCAM_FEEDBACK_PREFIX)) {
    return { auditId: id.slice(SCAM_FEEDBACK_PREFIX.length) };
  }
  return null;
}

function canReviewScamDecision(member, userId) {
  if (isKernelUserId(userId)) return true;
  if (hasHigherStaffRole(member)) return true;
  return hasAnyRole(member, STAFF_ROLE_IDS);
}

function getActorLabel(interaction) {
  return (
    interaction?.member?.displayName ||
    interaction?.user?.tag ||
    interaction?.user?.username ||
    interaction?.user?.id ||
    "staff"
  );
}

async function replyEphemeral(interaction, panel, { components } = {}) {
  const payload = {
    embeds: [buildPanel({ author: brandAuthor("SCAM AI · REVIEW"), ...panel })],
    flags: 1 << 6,
    allowedMentions: { parse: [] }
  };
  if (Array.isArray(components) && components.length) payload.components = components;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp?.(payload);
    } else {
      await interaction.reply?.(payload);
    }
  } catch (err) {
    recordRuntimeEvent("warn", "scam-review-ephemeral", err?.message || err);
  }
}

async function maybeHandleScamFeedbackInteraction(interaction) {
  const parsed = isScamFeedbackInteraction(interaction?.customId);
  if (!parsed) return false;
  if (!interaction?.isStringSelectMenu?.()) return true;

  if (!interaction.inGuild?.()) {
    await replyEphemeral(interaction, {
      header: "Server Only",
      body: "scam feedback only works inside the server",
      color: WARN
    });
    return true;
  }
  if (!canReviewScamDecision(interaction.member, interaction.user?.id)) {
    await replyEphemeral(interaction, {
      header: "Staff Only",
      body: "only staff and above can label scam decisions.",
      color: WARN
    });
    return true;
  }

  const auditId = Number(parsed.auditId);
  const category = String(interaction.values?.[0] || "").trim();
  const valid = SCAM_FEEDBACK_CATEGORIES.find((opt) => opt.value === category);

  if (!auditId || !valid) {
    await replyEphemeral(interaction, {
      header: "Feedback Not Saved",
      body: "could not parse the feedback selection.",
      color: WARN
    });
    return true;
  }

  // Persist as a runtime-health log line so the cache rebuild step can grep
  // for it later. No DB schema change needed for this iteration.
  recordRuntimeEvent(
    "info",
    "scam-review-feedback",
    `auditId=${auditId} category=${category} reviewer=${interaction.user?.id || "unknown"}`
  );

  // Disable the select on the original ephemeral so it can't be re-submitted.
  if (interaction.message?.edit) {
    try {
      const disabledRows = buildScamFeedbackSelectRows(auditId, { disabled: true });
      await interaction.message.edit({ components: disabledRows });
    } catch (err) {
      recordRuntimeEvent("warn", "scam-feedback-edit", err?.message || err);
    }
  }

  await replyEphemeral(interaction, {
    header: "Thanks — Feedback Saved",
    body: `recorded as **${valid.label}**. this helps the model learn what was wrong.`,
    color: SUCCESS
  });
  return true;
}

async function maybeHandleScamReviewInteraction(interaction) {
  const feedbackHandled = await maybeHandleScamFeedbackInteraction(interaction);
  if (feedbackHandled) return true;

  const parsed = isScamReviewInteraction(interaction?.customId);
  if (!parsed) return false;
  if (!interaction?.isButton?.()) return true;

  if (!interaction.inGuild?.()) {
    await replyEphemeral(interaction, {
      header: "Server Only",
      body: "scam review buttons only work inside the server",
      color: WARN
    });
    return true;
  }

  if (!canReviewScamDecision(interaction.member, interaction.user?.id)) {
    await replyEphemeral(interaction, {
      header: "Staff Only",
      body: "only staff and above can label scam decisions.",
      color: WARN
    });
    return true;
  }

  const auditId = Number(parsed.auditId);
  if (!auditId) {
    await replyEphemeral(interaction, {
      header: "Invalid Review",
      body: "could not parse the audit ID from this button.",
      color: WARN
    });
    return true;
  }

  const actorLabel = getActorLabel(interaction);
  const labelDisplay = parsed.label === "true_positive" ? "Correct" : "False Positive";

  const result = await labelScamDecisionAudit({
    id: auditId,
    label: parsed.label,
    reviewedBy: interaction.user?.id || null
  }).catch((err) => {
    recordRuntimeEvent("warn", "scam-review", err?.message || err);
    return { updated: false, reason: err?.message || String(err), record: null };
  });

  if (!result?.updated && result?.reason === "not_found") {
    await replyEphemeral(interaction, {
      header: "Audit Not Found",
      body: "this audit record no longer exists.",
      color: INFO
    });
    return true;
  }

  if (!result?.updated) {
    await replyEphemeral(interaction, {
      header: "Review Failed",
      body: `could not apply label: ${result?.reason || "unknown error"}`,
      color: DANGER
    });
    return true;
  }

  const previousLabel = result.previousLabel || null;
  const wasRelabeled = previousLabel && previousLabel !== parsed.label;

  const footerLine = `Reviewed by ${actorLabel} — marked ${labelDisplay}`;

  if (interaction.message?.edit) {
    const disabledScamRow = buildScamReviewButtonRows(auditId, { disabled: true })[0];
    const existingRows = Array.isArray(interaction.message.components) ? interaction.message.components : [];
    const updatedRows = existingRows.map((row) => {
      const buttons = row?.components || [];
      const isScamRow = buttons.some((btn) => {
        const id = btn?.customId || btn?.custom_id || btn?.data?.custom_id || "";
        return id.startsWith(SCAM_REVIEW_TRUE_PREFIX) || id.startsWith(SCAM_REVIEW_FALSE_PREFIX);
      });
      return isScamRow && disabledScamRow ? disabledScamRow : row;
    });

    const updatedEmbeds = (interaction.message.embeds || []).map((embed, index) => {
      const builder = EmbedBuilder.from(embed);
      if (index === 0) builder.setFooter({ text: footerLine });
      return builder;
    });

    // Preserve existing attachments (e.g. scam-dial.png) so the dial stays
    // inside the embed instead of detaching to a banner above it.
    const keepAttachments = (interaction.message.attachments?.values
      ? [...interaction.message.attachments.values()]
      : []);

    try {
      await interaction.message.edit({
        components: updatedRows,
        embeds: updatedEmbeds,
        attachments: keepAttachments
      });
    } catch (err) {
      recordRuntimeEvent("warn", "scam-review-edit", err?.message || err);
    }
  }

  const confirmBody = wasRelabeled
    ? `marked as **${labelDisplay}** (previously **${previousLabel.replace(/_/g, " ")}**).`
    : `marked as **${labelDisplay}**.`;

  // For false-positive labels, follow up with a category select so staff can
  // signal *why* it was wrong. The select submits to `scam_review_feedback:{auditId}`.
  const followUpComponents = parsed.label === "false_positive"
    ? buildScamFeedbackSelectRows(auditId)
    : undefined;

  await replyEphemeral(interaction, {
    header: "Review Saved",
    body: parsed.label === "false_positive"
      ? `${confirmBody}\n\nIf you have a sec, pick the category below — it helps tune the model.`
      : confirmBody,
    color: SUCCESS
  }, { components: followUpComponents });

  return true;
}

module.exports = {
  isScamReviewInteraction,
  isScamFeedbackInteraction,
  canReviewScamDecision,
  maybeHandleScamReviewInteraction,
  maybeHandleScamFeedbackInteraction
};
