/**
 * Handler for the $jarvis sweep report buttons.
 *
 *   sweep:rerun:{runId}  → re-runs the diagnostics, edits the message in place
 *   sweep:logs:{runId}   → ephemeral reply with a jump link to the log channel
 *
 * Why this lives separately from status.js: the sweep buttons are user-driven
 * interactions (separate from the message-driven `$jarvis` command), so they
 * deserve their own routing module that the InteractionCreate listener calls.
 */

"use strict";

const { runJarvisDiagnostics } = require("../diagnostics");
const { forceRefreshKb } = require("../kb");
const { CHANNEL_LOCK_ROLE_ID, LOG_CHANNEL_ID, OWNER_ROLE_IDS } = require("../config");
const { canUseOwnerCommands, hasAnyRole, isKernelUserId } = require("../permissions");
const { buildPanel, brandAuthor, INFO, DANGER, WARN, SUCCESS } = require("../embed");
const { recordRuntimeEvent } = require("../runtime-health");
const ui = require("../ui");

const SWEEP_RERUN_PREFIX = "sweep:rerun:";
const SWEEP_LOGS_PREFIX = "sweep:logs:";

function classifySweepInteraction(customId) {
  const id = String(customId || "");
  if (id.startsWith(SWEEP_RERUN_PREFIX)) {
    return { kind: "rerun", runId: id.slice(SWEEP_RERUN_PREFIX.length) };
  }
  if (id.startsWith(SWEEP_LOGS_PREFIX)) {
    return { kind: "logs", runId: id.slice(SWEEP_LOGS_PREFIX.length) };
  }
  return null;
}

function canRerunSweep(interaction) {
  if (!interaction) return false;
  if (isKernelUserId(interaction.user?.id)) return true;
  return hasAnyRole(interaction.member, OWNER_ROLE_IDS);
}

async function replyEphemeral(interaction, panel) {
  const payload = {
    embeds: [buildPanel({ author: brandAuthor("JARVIS · SWEEP"), ...panel })],
    flags: 1 << 6,
    allowedMentions: { parse: [] }
  };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (err) {
    recordRuntimeEvent("warn", "sweep-review-ephemeral", err?.message || err);
  }
}

async function handleRerun(interaction) {
  if (!canRerunSweep(interaction)) {
    await replyEphemeral(interaction, {
      header: "Owner Only",
      body: "only the kernel or owner role can re-run a sweep.",
      color: WARN
    });
    return;
  }

  // Ack the click immediately so Discord doesn't show "interaction failed".
  // We use deferUpdate (no message) so the original message stays intact while
  // we re-run; we'll edit the message with the new sweep when ready.
  try {
    await interaction.deferUpdate();
  } catch (err) {
    recordRuntimeEvent("warn", "sweep-review-defer", err?.message || err);
    return;
  }

  const sourceMessage = interaction.message;
  if (!sourceMessage) {
    await replyEphemeral(interaction, {
      header: "Re-run Failed",
      body: "couldn't read the original sweep message.",
      color: DANGER
    });
    return;
  }

  // Construct a message-like object that `runJarvisDiagnostics` can read for
  // guild/channel/author context. We pass the interaction's user as the author
  // so any audit-trail downstream attributes the re-run correctly.
  const messageLike = {
    ...sourceMessage,
    guild: sourceMessage.guild,
    guildId: sourceMessage.guildId,
    channel: sourceMessage.channel,
    channelId: sourceMessage.channelId,
    author: interaction.user,
    member: interaction.member,
    inGuild: () => Boolean(sourceMessage.inGuild?.()),
    reply: sourceMessage.reply?.bind(sourceMessage)
  };

  let report;
  try {
    report = await runJarvisDiagnostics(messageLike, {
      refreshKb: forceRefreshKb,
      channelLockRoleId: CHANNEL_LOCK_ROLE_ID
    });
  } catch (err) {
    recordRuntimeEvent("warn", "sweep-review-rerun", err?.message || err);
    await replyEphemeral(interaction, {
      header: "Sweep Failed",
      body: "the sweep raised an error mid-run. logs have it.",
      color: DANGER
    });
    return;
  }

  const findings = (report.sectionSummaries || [])
    .filter((s) => s.tone !== "ok")
    .map((s) => ({
      key: s.key,
      severity: s.tone === "fail" ? "fail" : "warn",
      line: s.detail
    }));
  const newRunId = `J-${String(Date.now()).slice(-4)}`;
  const sweep = ui.buildSweepReportEmbed({
    systems: report.scorecard,
    findings,
    runId: newRunId
  });

  try {
    await sourceMessage.edit({
      embeds: sweep.embeds,
      components: sweep.components,
      files: sweep.files,
      attachments: [],
      allowedMentions: { repliedUser: false }
    });
  } catch (err) {
    recordRuntimeEvent("warn", "sweep-review-edit", err?.message || err);
    await replyEphemeral(interaction, {
      header: "Edit Failed",
      body: "couldn't update the sweep message — try again.",
      color: DANGER
    });
    return;
  }

  await replyEphemeral(interaction, {
    header: "Sweep Re-run",
    body: `new run **${newRunId}** posted above.`,
    color: SUCCESS
  });
}

async function handleLogs(interaction) {
  const guildId = interaction.guildId;
  const url = guildId
    ? `https://discord.com/channels/${guildId}/${LOG_CHANNEL_ID}`
    : null;

  await replyEphemeral(interaction, {
    header: "Bot Log Channel",
    body: url
      ? `→ [open log channel](${url})`
      : "log channel reference is configured for the main guild only.",
    color: INFO
  });
}

async function maybeHandleSweepReviewInteraction(interaction) {
  const parsed = classifySweepInteraction(interaction?.customId);
  if (!parsed) return false;
  if (!interaction?.isButton?.()) return true;

  if (!interaction.inGuild?.()) {
    await replyEphemeral(interaction, {
      header: "Server Only",
      body: "sweep buttons only work inside the server.",
      color: WARN
    });
    return true;
  }

  if (parsed.kind === "rerun") {
    await handleRerun(interaction);
    return true;
  }
  if (parsed.kind === "logs") {
    await handleLogs(interaction);
    return true;
  }

  return false;
}

module.exports = {
  classifySweepInteraction,
  canRerunSweep,
  maybeHandleSweepReviewInteraction,
  SWEEP_RERUN_PREFIX,
  SWEEP_LOGS_PREFIX
};
