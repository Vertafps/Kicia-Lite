const crypto = require("crypto");

let _getDatabase = null;
let _schedulePersist = null;

function getDatabase() {
  if (!_getDatabase) {
    const mod = require("./restricted-emoji-db");
    if (typeof mod.getDatabase !== "function") {
      throw new Error("training-db: restricted-emoji-db.js does not export getDatabase");
    }
    if (typeof mod.schedulePersist !== "function") {
      throw new Error("training-db: restricted-emoji-db.js does not export schedulePersist");
    }
    _getDatabase = mod.getDatabase;
    _schedulePersist = mod.schedulePersist;
  }
  return _getDatabase();
}

function schedulePersist(db) {
  if (!_schedulePersist) {
    const mod = require("./restricted-emoji-db");
    _schedulePersist = mod.schedulePersist;
  }
  return _schedulePersist(db);
}

function getSetting(key) {
  try {
    return require("./settings").getSetting(key);
  } catch {
    return undefined;
  }
}

function getRows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function mapSampleRow(row) {
  if (!row) return null;
  return {
    id:                Number(row.id),
    classifier:        row.classifier != null ? String(row.classifier) : null,
    createdAt:         row.created_at != null ? Number(row.created_at) : null,
    guildId:           row.guild_id != null ? String(row.guild_id) : null,
    channelId:         row.channel_id != null ? String(row.channel_id) : null,
    messageId:         row.message_id != null ? String(row.message_id) : null,
    messageUrl:        row.message_url != null ? String(row.message_url) : null,
    authorId:          row.author_id != null ? String(row.author_id) : null,
    authorLabel:       row.author_label != null ? String(row.author_label) : null,
    rawText:           row.raw_text != null ? String(row.raw_text) : null,
    normalizedText:    row.normalized_text != null ? String(row.normalized_text) : null,
    signalsJson:       row.signals_json != null ? String(row.signals_json) : null,
    decision:          row.decision != null ? String(row.decision) : null,
    actionActionId:    row.action_action_id != null ? String(row.action_action_id) : null,
    label:             row.label != null ? String(row.label) : null,
    severity:          row.severity != null ? String(row.severity) : null,
    labelerId:         row.labeler_id != null ? String(row.labeler_id) : null,
    labelerLabel:      row.labeler_label != null ? String(row.labeler_label) : null,
    labeledAt:         row.labeled_at != null ? Number(row.labeled_at) : null,
    staffNote:         row.staff_note != null ? String(row.staff_note) : null,
    feedbackMessageId: row.feedback_message_id != null ? String(row.feedback_message_id) : null,
    feedbackChannelId: row.feedback_channel_id != null ? String(row.feedback_channel_id) : null,
    dedupKey:          row.dedup_key != null ? String(row.dedup_key) : null,
    posted:            Number(row.posted || 0),
    anonymized:        Number(row.anonymized || 0)
  };
}

// sql.js has no getRowsModified(); use SELECT changes() to read DML count.
function changesCount(db) {
  return db.exec("SELECT changes() AS c")[0]?.values?.[0]?.[0] ?? 0;
}

async function createTrainingSample({
  classifier,
  guildId,
  channelId,
  messageId,
  messageUrl,
  authorId,
  authorLabel,
  rawText,
  normalizedText,
  signalsJson,
  decision,
  actionActionId = null,
  dedupKey,
  vector = null,
  modelId = null
} = {}) {
  const db = await getDatabase();
  const now = Date.now();

  const windowMs = getSetting("training.dedup.windowMs") ?? 6 * 3_600_000;
  const cutoff = now - Number(windowMs);

  const existing = getRows(
    db,
    "SELECT id FROM training_samples WHERE dedup_key = ? AND created_at > ? LIMIT 1",
    [dedupKey, cutoff]
  );
  if (existing.length) {
    return { sampleId: Number(existing[0].id), deduped: true };
  }

  const signalsStr =
    typeof signalsJson === "string" ? signalsJson : JSON.stringify(signalsJson ?? {});

  db.run(
    `INSERT INTO training_samples
       (classifier, created_at, guild_id, channel_id, message_id, message_url,
        author_id, author_label, raw_text, normalized_text, signals_json,
        decision, action_action_id, dedup_key, posted, anonymized)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    [
      classifier,
      now,
      guildId ?? null,
      channelId ?? null,
      messageId ?? null,
      messageUrl ?? null,
      authorId ?? null,
      authorLabel ?? null,
      rawText,
      normalizedText,
      signalsStr,
      decision,
      actionActionId,
      dedupKey
    ]
  );

  const idRow = db.exec("SELECT last_insert_rowid() AS id")[0]?.values?.[0]?.[0];
  const sampleId = Number(idRow);

  if (vector instanceof Float32Array && modelId) {
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    db.run(
      `INSERT OR REPLACE INTO training_embeddings (sample_id, model_id, dims, vector)
       VALUES (?, ?, ?, ?)`,
      [sampleId, modelId, vector.length, blob]
    );
  }

  schedulePersist(db);
  return { sampleId, deduped: false };
}

async function getTrainingSampleById(sampleId) {
  const db = await getDatabase();
  const rows = getRows(
    db,
    "SELECT * FROM training_samples WHERE id = ? LIMIT 1",
    [Number(sampleId)]
  );
  return rows.length ? mapSampleRow(rows[0]) : null;
}

async function getTrainingSampleByFeedbackMessage(messageId) {
  const db = await getDatabase();
  const rows = getRows(
    db,
    "SELECT * FROM training_samples WHERE feedback_message_id = ? LIMIT 1",
    [String(messageId)]
  );
  return rows.length ? mapSampleRow(rows[0]) : null;
}

async function listUnlabeledTrainingSamples(classifier, { limit = 5, olderThanMs = null } = {}) {
  const db = await getDatabase();
  const params = [classifier];
  let extra = "";
  if (olderThanMs != null) {
    extra = " AND created_at < ?";
    params.push(Date.now() - Number(olderThanMs));
  }
  params.push(Number(limit));
  const rows = getRows(
    db,
    `SELECT * FROM training_samples
     WHERE classifier = ? AND label IS NULL${extra}
     ORDER BY created_at ASC
     LIMIT ?`,
    params
  );
  return rows.map(mapSampleRow);
}

async function listTrainingSamplesForRetrain(classifier) {
  const db = await getDatabase();
  const rows = getRows(
    db,
    `SELECT s.*, e.model_id AS _model_id, e.vector AS _vector
     FROM training_samples s
     LEFT JOIN training_embeddings e ON e.sample_id = s.id
     WHERE s.classifier = ? AND s.label IS NOT NULL
     ORDER BY s.created_at ASC`,
    [classifier]
  );
  return rows.map((row) => {
    const sample = mapSampleRow(row);
    let vec = null;
    if (row._vector) {
      const bytes =
        row._vector instanceof Uint8Array
          ? row._vector
          : new Uint8Array(row._vector);
      vec = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    }
    sample.vector = vec;
    return sample;
  });
}

async function updateTrainingSampleLabel(
  sampleId,
  { label, labelerId, labelerLabel, severity = null, staffNote = null, allowOverride = false } = {}
) {
  const db = await getDatabase();
  const now = Date.now();

  if (allowOverride) {
    db.run(
      `UPDATE training_samples
       SET label = ?, severity = ?, labeler_id = ?, labeler_label = ?,
           labeled_at = ?, staff_note = ?
       WHERE id = ?`,
      [label, severity, labelerId, labelerLabel, now, staffNote, Number(sampleId)]
    );
  } else {
    db.run(
      `UPDATE training_samples
       SET label = ?, severity = ?, labeler_id = ?, labeler_label = ?,
           labeled_at = ?, staff_note = ?
       WHERE id = ? AND label IS NULL`,
      [label, severity, labelerId, labelerLabel, now, staffNote, Number(sampleId)]
    );
  }

  const changed = changesCount(db);
  schedulePersist(db);

  if (changed === 0) {
    const row = await getTrainingSampleById(sampleId);
    return {
      ok: false,
      alreadyLabeled: true,
      oldLabel: row?.label ?? null,
      oldLabeler: row?.labelerId ?? null
    };
  }
  return { ok: true };
}

async function setTrainingSamplePosted(
  sampleId,
  { feedbackMessageId, feedbackChannelId, posted = 1 } = {}
) {
  const db = await getDatabase();
  db.run(
    `UPDATE training_samples
     SET posted = ?, feedback_message_id = ?, feedback_channel_id = ?
     WHERE id = ?`,
    [posted ? 1 : 0, feedbackMessageId ?? null, feedbackChannelId ?? null, Number(sampleId)]
  );
  schedulePersist(db);
}

async function listUnpostedTrainingSamples({ limit = 50, guildId = null } = {}) {
  const db = await getDatabase();
  const params = [];
  let guildClause = "";
  if (guildId != null) {
    guildClause = " AND guild_id = ?";
    params.push(String(guildId));
  }
  params.push(Number(limit));
  const rows = getRows(
    db,
    `SELECT * FROM training_samples
     WHERE posted = 0${guildClause}
     ORDER BY created_at ASC
     LIMIT ?`,
    params
  );
  return rows.map(mapSampleRow);
}

async function countTrainingSamples({ classifier = null, label = null } = {}) {
  const db = await getDatabase();
  const conditions = [];
  const params = [];
  if (classifier != null) {
    conditions.push("classifier = ?");
    params.push(String(classifier));
  }
  if (label != null) {
    conditions.push("label = ?");
    params.push(String(label));
  }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const stmt = db.prepare(`SELECT COUNT(*) AS c FROM training_samples${where}`);
  try {
    stmt.bind(params);
    if (!stmt.step()) return 0;
    return Number(stmt.getAsObject().c ?? 0);
  } finally {
    stmt.free();
  }
}

async function getTrainingStats() {
  const db = await getDatabase();
  const rows = getRows(
    db,
    `SELECT classifier,
            COUNT(*) AS total,
            SUM(CASE WHEN label = 'positive' THEN 1 ELSE 0 END) AS positive,
            SUM(CASE WHEN label = 'negative' THEN 1 ELSE 0 END) AS negative,
            SUM(CASE WHEN label IS NULL THEN 1 ELSE 0 END) AS unlabeled
     FROM training_samples
     GROUP BY classifier`,
    []
  );
  const byClassifier = {};
  for (const row of rows) {
    byClassifier[String(row.classifier)] = {
      total:     Number(row.total    ?? 0),
      positive:  Number(row.positive ?? 0),
      negative:  Number(row.negative ?? 0),
      unlabeled: Number(row.unlabeled ?? 0)
    };
  }
  return { byClassifier };
}

async function sweepExpiredTrainingSamples({
  retentionMs,
  anonymizeAfterMs,
  now = Date.now()
} = {}) {
  const db = await getDatabase();

  const deleteCutoff = now - Number(retentionMs);
  db.run("DELETE FROM training_samples WHERE created_at < ?", [deleteCutoff]);
  const deletedCount = changesCount(db);

  const anonCutoff = now - Number(anonymizeAfterMs);
  db.run(
    `UPDATE training_samples
     SET author_id = NULL, author_label = NULL, anonymized = 1
     WHERE created_at < ? AND anonymized = 0`,
    [anonCutoff]
  );
  const anonymizedCount = changesCount(db);

  if (deletedCount > 0 || anonymizedCount > 0) {
    schedulePersist(db);
  }
  return { deletedCount, anonymizedCount };
}

async function purgeTrainingSamplesByAuthor(authorId) {
  const db = await getDatabase();
  db.run("DELETE FROM training_samples WHERE author_id = ?", [String(authorId)]);
  const deletedCount = changesCount(db);
  if (deletedCount > 0) schedulePersist(db);
  return { deletedCount };
}

async function upsertTrainingEmbedding(sampleId, { modelId, vector } = {}) {
  const db = await getDatabase();
  const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  db.run(
    `INSERT OR REPLACE INTO training_embeddings (sample_id, model_id, dims, vector)
     VALUES (?, ?, ?, ?)`,
    [Number(sampleId), String(modelId), vector.length, blob]
  );
  schedulePersist(db);
}

async function getTrainingEmbedding(sampleId) {
  const db = await getDatabase();
  const rows = getRows(
    db,
    "SELECT model_id, dims, vector FROM training_embeddings WHERE sample_id = ? LIMIT 1",
    [Number(sampleId)]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const bytes =
    row.vector instanceof Uint8Array ? row.vector : new Uint8Array(row.vector);
  return {
    modelId: String(row.model_id),
    dims:    Number(row.dims),
    vector:  new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  };
}

async function getRespectTierState(userId) {
  const db = await getDatabase();
  const rows = getRows(
    db,
    "SELECT tier, last_offense_at FROM respect_tier_state WHERE user_id = ? LIMIT 1",
    [String(userId)]
  );
  if (!rows.length) return null;
  return {
    tier:          Number(rows[0].tier),
    lastOffenseAt: Number(rows[0].last_offense_at)
  };
}

// Tier caps at 4. If lastOffenseAt has aged past decayMs, reset to 1.
async function bumpRespectTier(userId, { now = Date.now(), decayMs } = {}) {
  const db = await getDatabase();
  const existing = await getRespectTierState(userId);

  let newTier;
  if (!existing || existing.lastOffenseAt < now - Number(decayMs)) {
    newTier = 1;
  } else {
    newTier = Math.min(existing.tier + 1, 4);
  }

  db.run(
    `INSERT INTO respect_tier_state (user_id, last_offense_at, tier)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       last_offense_at = excluded.last_offense_at,
       tier = excluded.tier`,
    [String(userId), now, newTier]
  );
  schedulePersist(db);
  return { tier: newTier, lastOffenseAt: now };
}

async function resetRespectTier(userId) {
  const db = await getDatabase();
  db.run("DELETE FROM respect_tier_state WHERE user_id = ?", [String(userId)]);
  schedulePersist(db);
}

function __resetForTests() {
  _getDatabase = null;
  _schedulePersist = null;
}

module.exports = {
  createTrainingSample,
  getTrainingSampleById,
  getTrainingSampleByFeedbackMessage,
  listUnlabeledTrainingSamples,
  listTrainingSamplesForRetrain,
  updateTrainingSampleLabel,
  setTrainingSamplePosted,
  listUnpostedTrainingSamples,
  countTrainingSamples,
  getTrainingStats,
  sweepExpiredTrainingSamples,
  purgeTrainingSamplesByAuthor,
  upsertTrainingEmbedding,
  getTrainingEmbedding,
  getRespectTierState,
  bumpRespectTier,
  resetRespectTier,
  __resetForTests,
  mapSampleRow
};
