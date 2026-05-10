const {
  OUTAGE_CONFIRM_PREFIX,
  OUTAGE_DISMISS_PREFIX,
  buildOutageReviewButtonRows
} = require("../components");
const { buildPanel, DANGER, INFO, SUCCESS, WARN } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const { hasHigherStaffRole, hasAnyRole, isKernelUserId } = require("../permissions");
const { STAFF_ROLE_IDS } = require("../config");
const { getReview, resolveOutageReview } = require("../outage-detector");
const { recordRuntimeEvent } = require("../runtime-health");

function isOutageReviewInteraction(customId) {
  const id = String(customId || "");
  if (id.startsWith(OUTAGE_CONFIRM_PREFIX)) {
    return { resolution: "confirmed", reviewId: id.slice(OUTAGE_CONFIRM_PREFIX.length) };
  }
  if (id.startsWith(OUTAGE_DISMISS_PREFIX)) {
    return { resolution: "false_alarm", reviewId: id.slice(OUTAGE_DISMISS_PREFIX.length) };
  }
  return null;
}

function canReviewOutage(member, userId) {
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
    flags: 1 << 6, // Ephemeral
    allowedMentions: { parse: [] }
  };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp?.(payload);
    } else {
      await interaction.reply?.(payload);
    }
  } catch (err) {
    recordRuntimeEvent("warn", "outage-review-ephemeral", err?.message || err);
  }
}

async function disableSourceButtons(interaction, message) {
  if (!message?.edit) return;
  const reviewIdMatch =
    interaction.customId?.replace(OUTAGE_CONFIRM_PREFIX, "").replace(OUTAGE_DISMISS_PREFIX, "") ||
    "";
  try {
    await message.edit({
      components: buildOutageReviewButtonRows(reviewIdMatch, { disabled: true })
    });
  } catch (err) {
    recordRuntimeEvent("warn", "outage-review-disable-buttons", err?.message || err);
  }
}

async function maybeHandleOutageReviewInteraction(interaction, deps = {}) {
  const parsed = isOutageReviewInteraction(interaction?.customId);
  if (!parsed) return false;
  if (!interaction?.isButton?.()) return true;

  if (!interaction.inGuild?.()) {
    await replyEphemeral(interaction, {
      header: "Server Only",
      body: "outage review buttons only work inside the server",
      color: WARN
    });
    return true;
  }

  if (!canReviewOutage(interaction.member, interaction.user?.id)) {
    await replyEphemeral(interaction, {
      header: "Staff Only",
      body: "only staff and above can resolve outage auto-detection.",
      color: WARN
    });
    return true;
  }

  const review = getReview(parsed.reviewId);
  if (!review) {
    await replyEphemeral(interaction, {
      header: "Review Expired",
      body: "this outage review is no longer pending — it expired or was already resolved.",
      color: INFO
    });
    await disableSourceButtons(interaction, interaction.message).catch(() => null);
    return true;
  }

  if (review.status !== "pending") {
    await replyEphemeral(interaction, {
      header: "Already Resolved",
      body: `this outage review was already resolved as **${review.status === "confirmed" ? "confirmed outage" : "false alarm"}**.`,
      color: INFO
    });
    await disableSourceButtons(interaction, interaction.message).catch(() => null);
    return true;
  }

  await interaction.deferReply?.({ flags: 1 << 6 }).catch(() => null);

  const actor = {
    id: interaction.user?.id || null,
    label: getActorLabel(interaction)
  };

  const result = await resolveOutageReview(parsed.reviewId, {
    resolution: parsed.resolution,
    actor,
    guild: interaction.guild,
    unlockChannels: deps.unlockChannels,
    sendLog: deps.sendLog || sendLogPanel
  }).catch((err) => {
    recordRuntimeEvent("warn", "outage-review", err?.message || err);
    return { ok: false, reason: err?.message || String(err) };
  });

  if (!result?.ok) {
    await interaction.editReply?.({
      embeds: [buildPanel({
        header: "Review Failed",
        body: `couldn't apply review: ${result?.reason || "unknown error"}`,
        color: DANGER
      })],
      allowedMentions: { parse: [] }
    }).catch(() => null);
    return true;
  }

  await interaction.editReply?.({
    embeds: [buildPanel({
      header: parsed.resolution === "confirmed" ? "Outage Confirmed" : "Marked As False Alarm",
      body: parsed.resolution === "confirmed"
        ? "Status set to **Down** — channels stay locked. Posted update in general."
        : `Status set to **Up**, channels unlocked. Posted all-clear in general.`,
      color: parsed.resolution === "confirmed" ? DANGER : SUCCESS
    })],
    allowedMentions: { parse: [] }
  }).catch(() => null);

  await disableSourceButtons(interaction, interaction.message).catch(() => null);

  return true;
}

module.exports = {
  isOutageReviewInteraction,
  canReviewOutage,
  maybeHandleOutageReviewInteraction
};
