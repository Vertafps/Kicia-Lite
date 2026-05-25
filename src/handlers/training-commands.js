const { canUseOwnerCommands, hasAnyRole } = require("../permissions");
const {
  STAFF_ROLE_IDS,
  MOD_ROLE_IDS,
  OWNER_ROLE_IDS,
  ADMIN_ROLE_IDS
} = require("../config");
const { buildPanel, SUCCESS, DANGER, WARN, INFO } = require("../embed");
const { safeReply } = require("../utils/respond");
const { recordRuntimeEvent } = require("../runtime-health");

async function replyPanel(message, panel) {
  await safeReply(message, {
    embeds: [buildPanel(panel)],
    allowedMentions: { repliedUser: false }
  });
}

function canStaffUse(message) {
  if (canUseOwnerCommands(message)) return true;
  return hasAnyRole(message?.member, [
    ...(STAFF_ROLE_IDS || []),
    ...(MOD_ROLE_IDS || []),
    ...(ADMIN_ROLE_IDS || []),
    ...(OWNER_ROLE_IDS || [])
  ]);
}

async function handleTrainCommand(message, parsed) {
  if (parsed.action === "help") {
    await replyPanel(message, {
      header: "Train",
      body: [
        "`$train scam` — retrain scam classifier from labeled samples",
        "`$train respect` — retrain respect classifier",
        "`$train review [classifier]` — ephemeral batch label"
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  if (parsed.action === "invalid") {
    await replyPanel(message, {
      header: "Train — Invalid",
      body: parsed.error,
      color: DANGER
    });
    return true;
  }

  if (parsed.action === "retrain") {
    if (!canUseOwnerCommands(message)) {
      await replyPanel(message, {
        header: "Train — Denied",
        body: "owner only",
        color: DANGER
      });
      return true;
    }
    await replyPanel(message, {
      header: "Train · Starting",
      body: `retraining ${parsed.classifier} head…`,
      color: INFO
    });

    try {
      const { listTrainingSamplesForRetrain } = require("../training-db");
      const samples = await listTrainingSamplesForRetrain(parsed.classifier);
      const labeled = samples.filter((s) => s.label === "positive" || s.label === "negative");
      if (labeled.length < 20) {
        await replyPanel(message, {
          header: "Train · Not Enough Data",
          body: `only ${labeled.length} labeled samples for **${parsed.classifier}**. need at least 20 to retrain.`,
          color: WARN
        });
        return true;
      }

      const trainSamples = labeled
        .filter((s) => s.vector)
        .map((s) => ({
          vector: s.vector,
          label: s.label === "positive" ? 1 : 0
        }));

      if (trainSamples.length < 20) {
        await replyPanel(message, {
          header: "Train · Embeddings Missing",
          body: `only ${trainSamples.length} samples have embeddings. backfilling may be needed.`,
          color: WARN
        });
        return true;
      }

      const inlineProbe = require("../inline-probe");
      const result = inlineProbe.trainAndCrossValidate(trainSamples, {
        epochs: 200,
        lr: 0.01,
        l2: 0.001,
        batchSize: 32,
        seed: 42
      });

      const dbModule = require("../restricted-emoji-db");
      const db = await dbModule.getDatabase();
      const headKey = `classifier.${parsed.classifier}.head_v1`;
      db.run("INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)", [
        headKey,
        JSON.stringify({
          W: result.head.W,
          b: result.head.b,
          version: 1,
          trainedAt: Date.now(),
          n: trainSamples.length,
          threshold: result.threshold
        })
      ]);
      dbModule.schedulePersist(db, { immediate: true });

      // invalidate head caches so new weights apply immediately, not after the 60s TTL
      try {
        if (parsed.classifier === "scam") {
          require("../scam-trade").resetHeadCache?.();
        } else if (parsed.classifier === "respect") {
          require("../kicia-disrespect").resetHeadCache?.();
        }
      } catch (err) {
        recordRuntimeEvent("warn", "train-head-cache-reset", err?.message || err);
      }

      await replyPanel(message, {
        header: `Train · ${parsed.classifier} retrained`,
        body: [
          `**Samples:** ${trainSamples.length}`,
          `**Precision:** ${(result.metrics.precision * 100).toFixed(1)}%`,
          `**Recall:** ${(result.metrics.recall * 100).toFixed(1)}%`,
          `**F1:** ${(result.metrics.f1 * 100).toFixed(1)}%`,
          `**Threshold:** ${result.threshold.toFixed(2)}`
        ].join("\n"),
        color: SUCCESS
      });
    } catch (err) {
      recordRuntimeEvent("error", "train-retrain", err?.message || err);
      await replyPanel(message, {
        header: "Train · Failed",
        body: err?.message || String(err),
        color: DANGER
      });
    }
    return true;
  }

  if (parsed.action === "review") {
    if (!canStaffUse(message)) {
      await replyPanel(message, {
        header: "Train — Denied",
        body: "staff+ only",
        color: DANGER
      });
      return true;
    }
    const { listUnlabeledTrainingSamples } = require("../training-db");
    const samples = await listUnlabeledTrainingSamples(parsed.classifier, { limit: 5 });
    if (!samples.length) {
      await replyPanel(message, {
        header: "Train · Review",
        body: `no unlabeled ${parsed.classifier} samples`,
        color: INFO
      });
      return true;
    }
    const lines = samples.map((s) => {
      const snippet = String(s.rawText || "").slice(0, 80);
      return `• sample #${s.id} · <@${s.authorId}> · "${snippet}…"`;
    });
    await replyPanel(message, {
      header: `Train · Review · ${parsed.classifier}`,
      body: lines.join("\n") + "\n\nlabel via the training channel buttons",
      color: INFO
    });
    return true;
  }

  return false;
}

async function handleTrainingCommand(message, parsed) {
  if (parsed.action === "help") {
    await replyPanel(message, {
      header: "Training",
      body: [
        "`$training stats` — sample counts per classifier",
        "`$training purge <user>` — wipe samples from a user (owner only)"
      ].join("\n"),
      color: INFO
    });
    return true;
  }

  if (parsed.action === "invalid") {
    await replyPanel(message, {
      header: "Training — Invalid",
      body: parsed.error,
      color: DANGER
    });
    return true;
  }

  if (parsed.action === "stats") {
    if (!canStaffUse(message)) {
      await replyPanel(message, {
        header: "Training — Denied",
        body: "staff+ only",
        color: DANGER
      });
      return true;
    }
    const { getTrainingStats } = require("../training-db");
    const stats = await getTrainingStats();
    const lines = [];
    for (const [classifier, counts] of Object.entries(stats.byClassifier || {})) {
      lines.push(
        `**${classifier}** · total ${counts.total} · positive ${counts.positive} · negative ${counts.negative} · unlabeled ${counts.unlabeled}`
      );
    }
    await replyPanel(message, {
      header: "Training · Stats",
      body: lines.length ? lines.join("\n") : "no samples yet",
      color: INFO
    });
    return true;
  }

  if (parsed.action === "purge") {
    if (!canUseOwnerCommands(message)) {
      await replyPanel(message, {
        header: "Training — Denied",
        body: "owner only",
        color: DANGER
      });
      return true;
    }
    const { purgeTrainingSamplesByAuthor } = require("../training-db");
    const result = await purgeTrainingSamplesByAuthor(parsed.userId);
    await replyPanel(message, {
      header: "Training · Purged",
      body: `wiped ${result.deletedCount} samples from <@${parsed.userId}>`,
      color: WARN
    });
    return true;
  }

  return false;
}

module.exports = {
  handleTrainCommand,
  handleTrainingCommand
};
