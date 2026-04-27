const { PermissionFlagsBits } = require("discord.js");
const {
  OWNER_USER_ID,
  OWNER_ROLE_IDS,
  ADMIN_ROLE_IDS,
  MOD_ROLE_IDS,
  STAFF_ROLE_IDS,
  EMOJI_MANAGER_ROLE_IDS,
  MODERATION_BYPASS_ROLE_IDS,
  RESTRICTED_REACTION_TARGET_ROLE_IDS
} = require("./config");

const STAFF_BYPASS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers
];

function hasAnyRole(member, roleIds) {
  return (roleIds || []).some((roleId) => member?.roles?.cache?.has?.(roleId));
}

function hasAnyPermission(member, permissions) {
  return (permissions || []).some((permission) => member?.permissions?.has?.(permission));
}

function isKernelUserId(userId) {
  return String(userId || "") === OWNER_USER_ID;
}

function isKernelMessage(message) {
  return isKernelUserId(message?.author?.id);
}

function canUseOwnerCommands(message) {
  return isKernelMessage(message) || hasAnyRole(message?.member, OWNER_ROLE_IDS);
}

function canUseLockCommands(message) {
  return canUseOwnerCommands(message);
}

function canUseEmojiCommands(message) {
  return isKernelMessage(message) || hasAnyRole(message?.member, EMOJI_MANAGER_ROLE_IDS);
}

function canUseTrustedLinkCommands(message) {
  return canUseEmojiCommands(message);
}

function hasModerationBypassMember(member, userId) {
  return (
    isKernelUserId(userId) ||
    hasAnyRole(member, MODERATION_BYPASS_ROLE_IDS) ||
    hasAnyPermission(member, STAFF_BYPASS_PERMISSIONS)
  );
}

function hasModerationBypassMessage(message) {
  return hasModerationBypassMember(message?.member, message?.author?.id);
}

function isProtectedReactionTargetMember(member) {
  return hasAnyRole(member, RESTRICTED_REACTION_TARGET_ROLE_IDS);
}

function hasHigherStaffRole(member) {
  return hasAnyRole(member, [...OWNER_ROLE_IDS, ...ADMIN_ROLE_IDS, ...MOD_ROLE_IDS]);
}

function isStaffOnlyTrackedMember(member) {
  return hasAnyRole(member, STAFF_ROLE_IDS) && !hasHigherStaffRole(member);
}

module.exports = {
  STAFF_BYPASS_PERMISSIONS,
  hasAnyRole,
  hasAnyPermission,
  isKernelUserId,
  isKernelMessage,
  canUseOwnerCommands,
  canUseLockCommands,
  canUseEmojiCommands,
  canUseTrustedLinkCommands,
  hasModerationBypassMember,
  hasModerationBypassMessage,
  isProtectedReactionTargetMember,
  hasHigherStaffRole,
  isStaffOnlyTrackedMember
};
