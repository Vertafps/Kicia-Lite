const {
  SCAM_REVIEW_TRUE_PREFIX,
  SCAM_REVIEW_FALSE_PREFIX,
  buildScamReviewButtonRows
} = require("../components");
const { buildPanel, DANGER, INFO, SUCCESS, WARN } = require("../embed");
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

async function replyEphemeral(interaction, panel) {
  const payload = {
    embeds: [buildPanel(panel)],
    flags: 1 << 6,
    allowedMentions: { parse: [] }
  };
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp?.(payload).catch(() => null);
    return;
  }
  await interaction.reply?.(payload).catch(() => null);
}

async function maybeHandleScamReviewInteraction(interaction) {
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

    await interaction.message.edit({
      components: updatedRows,
      embeds: interaction.message.embeds?.map((embed, index) => {
        if (index !== 0) return embed;
        const existing = embed?.data || embed?.toJSON?.() || embed;
        return {
          ...existing,
          footer: { text: footerLine }
        };
      }) || interaction.message.embeds || []
    }).catch(() => null);
  }

  const confirmBody = wasRelabeled
    ? `marked as **${labelDisplay}** (previously **${previousLabel.replace(/_/g, " ")}**).`
    : `marked as **${labelDisplay}**.`;

  await replyEphemeral(interaction, {
    header: "Review Saved",
    body: confirmBody,
    color: SUCCESS
  });

  return true;
}

module.exports = {
  isScamReviewInteraction,
  canReviewScamDecision,
  maybeHandleScamReviewInteraction
};
