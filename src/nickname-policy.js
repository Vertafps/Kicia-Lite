const DEFAULT_NICKNAME_RENAME_SENTINEL = "__DEFAULT__";
const DEFAULT_BADNAME_PREFIX = "BADNAME #";

function normalizeNicknameText(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDefaultNicknameRename(renameTo) {
  return String(renameTo || "").trim() === DEFAULT_NICKNAME_RENAME_SENTINEL;
}

function buildDefaultBadName(memberOrUserId) {
  const id = typeof memberOrUserId === "string"
    ? memberOrUserId
    : memberOrUserId?.id || memberOrUserId?.user?.id || "";
  const digits = String(id || "").replace(/\D/g, "");
  const suffix = (digits.slice(-6) || "000000").padStart(6, "0");
  return `${DEFAULT_BADNAME_PREFIX}${suffix}`;
}

function resolveNicknameRenameTarget(renameTo, memberOrUserId) {
  return isDefaultNicknameRename(renameTo)
    ? buildDefaultBadName(memberOrUserId)
    : normalizeNicknameText(renameTo);
}

function formatNicknameRenameTarget(renameTo) {
  return isDefaultNicknameRename(renameTo)
    ? `${DEFAULT_BADNAME_PREFIX}number`
    : normalizeNicknameText(renameTo);
}

module.exports = {
  DEFAULT_NICKNAME_RENAME_SENTINEL,
  DEFAULT_BADNAME_PREFIX,
  buildDefaultBadName,
  formatNicknameRenameTarget,
  isDefaultNicknameRename,
  normalizeNicknameText,
  resolveNicknameRenameTarget
};
