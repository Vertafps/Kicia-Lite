"use strict";

/**
 * Profile-signal multiplier for scam confidence.
 *
 * Brand-new accounts and just-joined members are statistically much more
 * likely to be drive-by scammers. We scale the existing classifier confidence
 * by a multiplier derived from these profile signals.
 *
 * Bounded:
 *  - 1.0 ≤ multiplier ≤ 1.6  (so weak signals can never fabricate a hit)
 *  - Mature accounts get exactly 1.0 (no impact)
 *
 * The multiplier is applied AFTER the cascade has decided the message looks
 * scam-shaped — never used to *create* a verdict, only to amplify an existing
 * one when the actor's profile is suspicious.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function computeProfileMultiplier(member, now = Date.now()) {
  if (!member) return 1.0;

  let multiplier = 1.0;
  const reasons = [];

  const createdTs = member.user?.createdTimestamp ?? member.user?.createdAt?.getTime?.();
  if (Number.isFinite(createdTs)) {
    const accountAgeDays = (now - createdTs) / DAY_MS;
    if (accountAgeDays < 7) {
      multiplier *= 1.3;
      reasons.push(`account age ${accountAgeDays.toFixed(1)}d`);
    } else if (accountAgeDays < 30) {
      multiplier *= 1.1;
      reasons.push(`account age ${Math.round(accountAgeDays)}d`);
    }
  }

  const joinedTs = member.joinedTimestamp ?? member.joinedAt?.getTime?.();
  if (Number.isFinite(joinedTs)) {
    const guildTenureMs = now - joinedTs;
    if (guildTenureMs < HOUR_MS) {
      multiplier *= 1.4;
      reasons.push(`joined ${Math.round(guildTenureMs / 60000)}m ago`);
    } else if (guildTenureMs < DAY_MS) {
      multiplier *= 1.15;
      reasons.push(`joined ${Math.round(guildTenureMs / HOUR_MS)}h ago`);
    }
  }

  multiplier = Math.min(1.6, Math.max(1.0, multiplier));

  return { multiplier, reasons };
}

function applyProfileMultiplier(confidence, member, now = Date.now()) {
  const safeConfidence = Math.max(0, Math.min(99, Number(confidence) || 0));
  const { multiplier, reasons } = computeProfileMultiplier(member, now);
  if (multiplier <= 1.0) {
    return { confidence: safeConfidence, multiplier: 1.0, reasons: [] };
  }
  const scaled = Math.min(99, Math.round(safeConfidence * multiplier));
  return { confidence: scaled, multiplier, reasons };
}

module.exports = {
  computeProfileMultiplier,
  applyProfileMultiplier
};
