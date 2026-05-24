"use strict";

/**
 * handlers/training-feedback.js
 *
 * Button + modal interaction router for the training channel.
 *
 * Public surface:
 *   - maybeHandleTrainingFeedbackInteraction(interaction) -> Promise<boolean>
 *       Returns true if this handler claimed the interaction.
 *
 * Wiring: invoked from src/index.js Events.InteractionCreate chain before the
 * unrouted fallback, mirroring outage-review.js.
 *
 * customId grammar (kept in sync with src/components.js):
 *   train:neg:<id>                              label as negative
 *   train:scam:{light|medium|severe}:<id>       positive scam label + retroactive timeout
 *   train:respect:{warn|light|medium|severe}:<id>
 *                                               positive respect label (+ retro timeout for non-warn)
 *   train:note:<id>                             open staff-note modal
 *   train:note-submit:<id>                      modal submit
 *   train:undo:<id>                             revert label within 30s window
 *   train:lift:<id>                             revert wrongful auto-timeout
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} = require("discord.js");

const {
  TRAIN_LABEL_NEG_PREFIX,
  TRAIN_SCAM_LIGHT_PREFIX,
  TRAIN_SCAM_MEDIUM_PREFIX,
  TRAIN_SCAM_SEVERE_PREFIX,
  TRAIN_RESPECT_LIGHT_PREFIX,
  TRAIN_RESPECT_SEVERE_PREFIX,
  TRAIN_RESPECT_WARN_PREFIX,
  TRAIN_NOTE_PREFIX,
  TRAIN_NOTE_MODAL_PREFIX,
  TRAIN_NOTE_INPUT_ID,
  TRAIN_UNDO_PREFIX,
  TRAIN_LIFT_PREFIX,
  buildTrainingFeedbackButtonRows,
  buildTrainingNoteModal
} = require("../components");

const {
  updateTrainingSampleLabel,
  getTrainingSampleById,
  bumpRespectTier
} = require("../training-db");

const { getSetting } = require("../settings");
const {
  hasAnyRole,
  isKernelUserId
} = require("../permissions");
const {
  STAFF_ROLE_IDS,
  MOD_ROLE_IDS,
  ADMIN_ROLE_IDS,
  OWNER_ROLE_IDS
} = require("../config");
const { sendLogPanel } = require("../log-channel");
const { buildPanel, WARN, SUCCESS, DANGER, INFO } = require("../embed");
const { recordRuntimeEvent } = require("../runtime-health");
const { formatDuration } = require("../duration");

// ---------------------------------------------------------------------------
// CustomId parser
// ---------------------------------------------------------------------------

/**
 * Parse a training: customId into a structured action.
 * @param {string} customId
 * @returns {object|null}
 */
function parseTrainingInteraction(customId) {
  const raw = String(customId || "");
  if (!raw.startsWith("train:")) return null;

  const parts = raw.split(":");
  if (parts[0] !== "train") return null;

  const last = parts[parts.length - 1];
  const sampleId = Number(last);
  if (!Number.isFinite(sampleId)) return null;

  const kind = parts[1];
  if (kind === "neg") return { type: "label-neg", sampleId };
  if (kind === "undo") return { type: "undo", sampleId };
  if (kind === "lift") return { type: "lift", sampleId };
  if (kind === "note") return { type: "note-open", sampleId };
  if (kind === "note-submit") return { type: "note-submit", sampleId };
  if (kind === "scam" || kind === "respect") {
    const severity = parts[2];
    return {
      type: "label-positive",
      sampleId,
      classifier: kind,
      severity
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Permission gate
// ---------------------------------------------------------------------------

/**
 * Decide whether the interactor is allowed to label training samples.
 * Reads `training.label.role` (default "staff") from settings.
 *   - "owner" → owner only
 *   - "mod"   → mod/admin/owner roles
 *   - "staff" → staff/mod/admin/owner roles
 * Kernel users (OWNER_USER_IDS) always bypass.
 * @param {import('discord.js').Interaction} interaction
 * @returns {boolean}
 */
function canLabelTraining(interaction) {
  const member = interaction?.member;
  const userId = interaction?.user?.id || member?.user?.id;
  if (isKernelUserId(userId)) return true;

  const roleSetting = getSetting("training.label.role") ?? "staff";
  let allowed;
  if (roleSetting === "owner") {
    allowed = [...OWNER_ROLE_IDS];
  } else if (roleSetting === "mod") {
    allowed = [...OWNER_ROLE_IDS, ...ADMIN_ROLE_IDS, ...MOD_ROLE_IDS];
  } else {
    allowed = [
      ...OWNER_ROLE_IDS,
      ...ADMIN_ROLE_IDS,
      ...MOD_ROLE_IDS,
      ...STAFF_ROLE_IDS
    ];
  }
  return hasAnyRole(member, allowed);
}

// ---------------------------------------------------------------------------
// Ephemeral reply helper
// ---------------------------------------------------------------------------

async function ephemeralReply(interaction, content, components = []) {
  const payload = {
    content: typeof content === "string" ? content : String(content ?? ""),
    components,
    flags: 1 << 6,
    allowedMentions: { parse: [] }
  };
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp?.(payload);
    } else {
      await interaction.reply?.(payload);
    }
  } catch (err) {
    recordRuntimeEvent("warn", "training-feedback-reply", err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Severity → duration resolver
// ---------------------------------------------------------------------------

function resolveSeverityDurationMs(classifier, severity) {
  if (classifier === "scam") {
    const setting = getSetting(`scam.severity.${severity}.timeout`);
    if (Number.isFinite(setting) && setting > 0) return Number(setting);
    if (severity === "light") return 3_600_000;
    if (severity === "medium") return 12 * 3_600_000;
    return 24 * 3_600_000;
  }
  if (classifier === "respect") {
    const setting = getSetting(`respect.severity.${severity}.timeout`);
    if (Number.isFinite(setting) && setting > 0) return Number(setting);
    if (severity === "light") {
      const fallback = getSetting("respect.timeout");
      if (Number.isFinite(fallback) && fallback > 0) return Number(fallback);
      return 15 * 60_000;
    }
    if (severity === "medium") {
      const fallback = getSetting("respect.tier2.timeout");
      if (Number.isFinite(fallback) && fallback > 0) return Number(fallback);
      return 3_600_000;
    }
    const fallback = getSetting("respect.tier3.timeout");
    if (Number.isFinite(fallback) && fallback > 0) return Number(fallback);
    return 24 * 3_600_000;
  }
  return 3_600_000;
}

// ---------------------------------------------------------------------------
// DM helper
// ---------------------------------------------------------------------------

async function dmUser(member, { classifier, severity, durationMs } = {}) {
  if (!member?.createDM) return;
  let dm;
  try {
    dm = await member.createDM();
  } catch (err) {
    recordRuntimeEvent("warn", "training-dm-create", err?.message || err);
    return;
  }
  if (!dm) return;

  const human = formatDuration(durationMs);
  const body = classifier === "scam"
    ? `hey — your message looked like a sale/trade, so it got removed. you're muted for ${human}. if this was wrong, just ping staff in the server.`
    : `hey — that message got flagged for disrespect toward kicia. you're muted for ${human}. if it was a misread, ping staff.`;
  const header = classifier === "scam" ? "Message Removed" : "Message Flagged";

  try {
    await dm.send({
      embeds: [buildPanel({ header, body, color: WARN })]
    });
  } catch (err) {
    recordRuntimeEvent("warn", "training-dm-send", err?.message || err);
  }
}

async function dmLiftedUser(member) {
  if (!member?.createDM) return;
  let dm;
  try {
    dm = await member.createDM();
  } catch (err) {
    recordRuntimeEvent("warn", "training-dm-lift-create", err?.message || err);
    return;
  }
  if (!dm) return;
  try {
    await dm.send({
      embeds: [buildPanel({
        header: "Timeout Lifted",
        body: "hey — staff reviewed and lifted your timeout. sorry for the noise!",
        color: SUCCESS
      })]
    });
  } catch (err) {
    recordRuntimeEvent("warn", "training-dm-lift-send", err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Retroactive action — timeout + delete + DM + log
// ---------------------------------------------------------------------------

async function applyRetroactiveAction(interaction, sample, { classifier, severity, durationMs }) {
  const guild = interaction?.guild;
  if (!guild) return;

  // Try to fetch original message (may already be gone)
  let originalMessage = null;
  if (sample?.channelId && sample?.messageId) {
    const channel = await guild.channels
      .fetch(sample.channelId)
      .catch(() => null);
    if (channel?.messages?.fetch) {
      originalMessage = await channel.messages
        .fetch(sample.messageId)
        .catch(() => null);
    }
  }

  // Fetch the offending member
  let guildMember = null;
  if (sample?.authorId) {
    guildMember = await guild.members
      .fetch(sample.authorId)
      .catch(() => null);
  }

  // Apply timeout — best effort
  if (guildMember?.timeout) {
    const reason = `training: ${classifier} ${severity} — labeled by ${interaction.user?.username || interaction.user?.id || "staff"}`;
    try {
      await guildMember.timeout(durationMs, reason);
    } catch (err) {
      recordRuntimeEvent(
        "warn",
        "training-retroactive-timeout",
        err?.message || err
      );
    }
  }

  // Delete original message — best effort
  if (originalMessage && originalMessage.deletable !== false) {
    try {
      await originalMessage.delete();
    } catch (err) {
      // The message may have been deleted already; ignore
      recordRuntimeEvent(
        "info",
        "training-retroactive-delete",
        err?.message || err
      );
    }
  }

  // DM the user — best effort
  if (guildMember) {
    await dmUser(guildMember, { classifier, severity, durationMs });
  }

  // Audit log
  try {
    await sendLogPanel(guild, buildPanel({
      header: `Training applied · ${classifier} · ${severity}`,
      body: [
        `**User:** ${sample?.authorId ? `<@${sample.authorId}>` : "_(unknown)_"}`,
        `**Labeled by:** <@${interaction.user?.id}>`,
        `**Duration:** ${formatDuration(durationMs)}`,
        `**Sample:** #${sample?.id}`
      ].join("\n"),
      color: DANGER
    }));
  } catch (err) {
    recordRuntimeEvent("warn", "training-log-applied", err?.message || err);
  }

  // Bump respect tier state if this was a respect label
  if (classifier === "respect" && sample?.authorId) {
    try {
      const decayMs = Number(getSetting("respect.tier.decayMs") ?? 7 * 86_400_000);
      await bumpRespectTier(sample.authorId, { decayMs });
    } catch (err) {
      recordRuntimeEvent("warn", "training-respect-tier", err?.message || err);
    }
  }
}

// ---------------------------------------------------------------------------
// Source-message UI update (disable buttons + add "Labeled" field)
// ---------------------------------------------------------------------------

async function disableButtonsAndAddLabel(
  interaction,
  sample,
  { classifier, label, severity, labelerId } = {}
) {
  try {
    const msg = interaction?.message;
    if (!msg?.edit) return;

    let embeds = msg.embeds;
    if (Array.isArray(embeds) && embeds[0]) {
      const newEmbed = EmbedBuilder.from(embeds[0]);
      const sevPart = severity ? ` (${severity})` : "";
      newEmbed.addFields({
        name: "Labeled",
        value: `<@${labelerId}> · ${label}${sevPart} · <t:${Math.floor(Date.now() / 1000)}:R>`,
        inline: false
      });
      embeds = [newEmbed, ...embeds.slice(1)];
    }

    const updatedSample = { ...(sample || {}), label };
    const cls = classifier || sample?.classifier || "scam";
    const newRows = buildTrainingFeedbackButtonRows(
      String(sample?.id ?? ""),
      cls,
      updatedSample
    );

    await msg.edit({
      embeds: embeds || msg.embeds,
      components: newRows
    });
  } catch (err) {
    recordRuntimeEvent("warn", "training-disable-buttons", err?.message || err);
  }
}

// ---------------------------------------------------------------------------
// Undo button builder
// ---------------------------------------------------------------------------

function buildUndoButtonRow(sampleId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TRAIN_UNDO_PREFIX}${sampleId}`)
      .setStyle(ButtonStyle.Secondary)
      .setLabel("Undo (30s)")
  );
}

// ---------------------------------------------------------------------------
// Actor label helper
// ---------------------------------------------------------------------------

function getActorLabel(interaction) {
  return (
    interaction?.member?.displayName ||
    interaction?.user?.username ||
    interaction?.user?.tag ||
    interaction?.user?.id ||
    "staff"
  );
}

// ---------------------------------------------------------------------------
// Direct-DB undo (training-db doesn't expose a clearLabel helper)
// ---------------------------------------------------------------------------

async function clearLabelRaw(sampleId) {
  const { getDatabase, schedulePersist } = require("../restricted-emoji-db");
  const db = await getDatabase();
  db.run(
    `UPDATE training_samples
     SET label = NULL,
         labeler_id = NULL,
         labeler_label = NULL,
         labeled_at = NULL,
         severity = NULL
     WHERE id = ?`,
    [Number(sampleId)]
  );
  schedulePersist(db);
}

async function saveStaffNoteRaw(sampleId, note) {
  const { getDatabase, schedulePersist } = require("../restricted-emoji-db");
  const db = await getDatabase();
  db.run(
    "UPDATE training_samples SET staff_note = ? WHERE id = ?",
    [String(note || "").slice(0, 400), Number(sampleId)]
  );
  schedulePersist(db);
}

// ---------------------------------------------------------------------------
// Branch handlers
// ---------------------------------------------------------------------------

async function handleLabelPositive(interaction, { sampleId, classifier, severity }) {
  if (!canLabelTraining(interaction)) {
    await ephemeralReply(interaction, "you can't label training samples");
    return;
  }
  if (!classifier || !severity) {
    await ephemeralReply(interaction, "unknown training action");
    return;
  }

  const labelerId = interaction.user?.id || null;
  const labelerLabel = getActorLabel(interaction);
  const isOwner = isKernelUserId(labelerId);

  let result;
  try {
    result = await updateTrainingSampleLabel(sampleId, {
      label: "positive",
      labelerId,
      labelerLabel,
      severity,
      allowOverride: isOwner
    });
  } catch (err) {
    recordRuntimeEvent("warn", "training-label-positive", err?.message || err);
    await ephemeralReply(interaction, "couldn't save label — try again");
    return;
  }

  if (!result?.ok && result?.alreadyLabeled) {
    const who = result.oldLabeler ? `<@${result.oldLabeler}>` : "another staff member";
    await ephemeralReply(interaction, `already labeled by ${who}`);
    return;
  }

  const sample = await getTrainingSampleById(sampleId).catch(() => null);
  if (!sample) {
    await ephemeralReply(interaction, "sample not found");
    return;
  }

  // Warn-DM-only path for respect (no timeout)
  if (classifier === "respect" && severity === "warn") {
    // Best-effort warn DM
    if (sample.authorId && interaction.guild) {
      const member = await interaction.guild.members
        .fetch(sample.authorId)
        .catch(() => null);
      if (member?.createDM) {
        try {
          const dm = await member.createDM();
          if (dm) {
            await dm.send({
              embeds: [buildPanel({
                header: "Heads-up",
                body: "hey — that message came off as disrespectful toward kicia. friendly heads-up, no timeout this time. if it was a misread, ping staff.",
                color: WARN
              })]
            }).catch(() => {});
          }
        } catch (err) {
          recordRuntimeEvent("warn", "training-warn-dm", err?.message || err);
        }
      }
    }
    try {
      await sendLogPanel(interaction.guild, buildPanel({
        header: "Training warn · respect",
        body: [
          `**User:** ${sample.authorId ? `<@${sample.authorId}>` : "_(unknown)_"}`,
          `**Labeled by:** <@${labelerId}>`,
          `**Sample:** #${sample.id}`
        ].join("\n"),
        color: INFO
      }));
    } catch (err) {
      recordRuntimeEvent("warn", "training-log-warn", err?.message || err);
    }
    await disableButtonsAndAddLabel(interaction, sample, {
      classifier,
      label: "positive",
      severity,
      labelerId
    });
    await ephemeralReply(
      interaction,
      "labeled as disrespect (warn) — DM sent, no timeout. you have 30s to undo.",
      [buildUndoButtonRow(sampleId)]
    );
    return;
  }

  // Full retroactive action for all other severities
  const durationMs = resolveSeverityDurationMs(classifier, severity);
  await applyRetroactiveAction(interaction, sample, {
    classifier,
    severity,
    durationMs
  });

  await disableButtonsAndAddLabel(interaction, sample, {
    classifier,
    label: "positive",
    severity,
    labelerId
  });

  await ephemeralReply(
    interaction,
    `labeled as ${classifier} (${severity}) — applying ${formatDuration(durationMs)} timeout. you have 30s to undo.`,
    [buildUndoButtonRow(sampleId)]
  );
}

async function handleLabelNegative(interaction, { sampleId }) {
  if (!canLabelTraining(interaction)) {
    await ephemeralReply(interaction, "you can't label training samples");
    return;
  }

  const labelerId = interaction.user?.id || null;
  const labelerLabel = getActorLabel(interaction);
  const isOwner = isKernelUserId(labelerId);

  let result;
  try {
    result = await updateTrainingSampleLabel(sampleId, {
      label: "negative",
      labelerId,
      labelerLabel,
      allowOverride: isOwner
    });
  } catch (err) {
    recordRuntimeEvent("warn", "training-label-negative", err?.message || err);
    await ephemeralReply(interaction, "couldn't save label — try again");
    return;
  }

  if (!result?.ok && result?.alreadyLabeled) {
    const who = result.oldLabeler ? `<@${result.oldLabeler}>` : "another staff member";
    await ephemeralReply(interaction, `already labeled by ${who}`);
    return;
  }

  const sample = await getTrainingSampleById(sampleId).catch(() => null);
  await disableButtonsAndAddLabel(interaction, sample || { id: sampleId }, {
    classifier: sample?.classifier,
    label: "negative",
    severity: null,
    labelerId
  });

  await ephemeralReply(
    interaction,
    "marked as not a violation — thanks. you have 30s to undo.",
    [buildUndoButtonRow(sampleId)]
  );
}

async function handleLift(interaction, { sampleId }) {
  if (!canLabelTraining(interaction)) {
    await ephemeralReply(interaction, "you can't label training samples");
    return;
  }

  const labelerId = interaction.user?.id || null;
  const labelerLabel = getActorLabel(interaction);

  // Owner-allowed override regardless of current label state — staff lifting
  // a wrongful timeout overrides any prior label.
  try {
    await updateTrainingSampleLabel(sampleId, {
      label: "negative",
      labelerId,
      labelerLabel,
      allowOverride: true
    });
  } catch (err) {
    recordRuntimeEvent("warn", "training-lift-label", err?.message || err);
  }

  const sample = await getTrainingSampleById(sampleId).catch(() => null);
  if (!sample) {
    await ephemeralReply(interaction, "sample not found");
    return;
  }

  // Revert timeout + DM apology
  if (sample.authorId && interaction.guild) {
    const guildMember = await interaction.guild.members
      .fetch(sample.authorId)
      .catch(() => null);
    if (guildMember?.timeout) {
      try {
        await guildMember.timeout(
          null,
          `training revert: ${interaction.user?.username || interaction.user?.id || "staff"} marked as wrongful`
        );
      } catch (err) {
        recordRuntimeEvent("warn", "training-lift-timeout", err?.message || err);
      }
    }
    if (guildMember) {
      await dmLiftedUser(guildMember);
    }
  }

  try {
    await sendLogPanel(interaction.guild, buildPanel({
      header: "Training timeout lifted",
      body: [
        `**User:** ${sample.authorId ? `<@${sample.authorId}>` : "_(unknown)_"}`,
        `**Lifted by:** <@${labelerId}>`,
        `**Sample:** #${sample.id}`
      ].join("\n"),
      color: INFO
    }));
  } catch (err) {
    recordRuntimeEvent("warn", "training-lift-log", err?.message || err);
  }

  await disableButtonsAndAddLabel(interaction, sample, {
    classifier: sample.classifier,
    label: "negative",
    severity: null,
    labelerId
  });

  await ephemeralReply(interaction, "timeout lifted, user notified.");
}

async function handleUndo(interaction, { sampleId }) {
  const sample = await getTrainingSampleById(sampleId).catch(() => null);
  if (!sample?.labeledAt) {
    await ephemeralReply(interaction, "nothing to undo");
    return;
  }

  const ageMs = Date.now() - Number(sample.labeledAt);
  if (ageMs > 30_000) {
    await ephemeralReply(interaction, "undo window expired (30s)");
    return;
  }

  const userId = interaction.user?.id;
  if (sample.labelerId !== userId && !isKernelUserId(userId)) {
    await ephemeralReply(interaction, "only the original labeler can undo within 30s");
    return;
  }

  try {
    await clearLabelRaw(sampleId);
  } catch (err) {
    recordRuntimeEvent("warn", "training-undo", err?.message || err);
    await ephemeralReply(interaction, "couldn't undo — try again");
    return;
  }

  await ephemeralReply(interaction, "label undone.");
}

async function handleNoteOpen(interaction, { sampleId }) {
  if (!canLabelTraining(interaction)) {
    await ephemeralReply(interaction, "you can't label training samples");
    return;
  }
  try {
    await interaction.showModal?.(buildTrainingNoteModal(sampleId));
  } catch (err) {
    recordRuntimeEvent("warn", "training-note-modal", err?.message || err);
    await ephemeralReply(interaction, "couldn't open note form — try again");
  }
}

async function handleNoteSubmit(interaction, { sampleId }) {
  if (!canLabelTraining(interaction)) {
    await ephemeralReply(interaction, "you can't label training samples");
    return;
  }
  let value = "";
  try {
    value = interaction.fields?.getTextInputValue?.(TRAIN_NOTE_INPUT_ID) ?? "";
  } catch (err) {
    recordRuntimeEvent("warn", "training-note-read", err?.message || err);
  }
  try {
    await saveStaffNoteRaw(sampleId, value);
  } catch (err) {
    recordRuntimeEvent("warn", "training-note-save", err?.message || err);
    await ephemeralReply(interaction, "couldn't save note — try again");
    return;
  }
  await ephemeralReply(interaction, "note saved.");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function maybeHandleTrainingFeedbackInteraction(interaction) {
  const parsed = parseTrainingInteraction(interaction?.customId);
  if (!parsed) return false;

  // Reject anything outside a guild (training samples are guild-scoped).
  if (!interaction.inGuild?.()) {
    await ephemeralReply(interaction, "training actions only work inside the server");
    return true;
  }

  // Modal submit must be routed even though parseTrainingInteraction matched
  // before we know the interaction type — verify the right kind here.
  try {
    switch (parsed.type) {
      case "label-positive":
        if (!interaction.isButton?.()) return true;
        await handleLabelPositive(interaction, parsed);
        return true;
      case "label-neg":
        if (!interaction.isButton?.()) return true;
        await handleLabelNegative(interaction, parsed);
        return true;
      case "lift":
        if (!interaction.isButton?.()) return true;
        await handleLift(interaction, parsed);
        return true;
      case "undo":
        if (!interaction.isButton?.()) return true;
        await handleUndo(interaction, parsed);
        return true;
      case "note-open":
        if (!interaction.isButton?.()) return true;
        await handleNoteOpen(interaction, parsed);
        return true;
      case "note-submit":
        if (!interaction.isModalSubmit?.()) return true;
        await handleNoteSubmit(interaction, parsed);
        return true;
      default:
        return false;
    }
  } catch (err) {
    recordRuntimeEvent("error", "training-feedback-router", err?.message || err);
    try {
      await ephemeralReply(interaction, "something went wrong handling that action");
    } catch {
      /* swallow */
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  maybeHandleTrainingFeedbackInteraction,
  parseTrainingInteraction,
  canLabelTraining
};
