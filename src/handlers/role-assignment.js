const { PermissionFlagsBits } = require("discord.js");
const { ENABLE_GUILD_MEMBER_EVENTS } = require("../config");
const { buildPanel, DANGER, INFO, SUCCESS, WARN } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const { canUseOwnerCommands } = require("../permissions");

const SNOWFLAKE_RE = /^\d{17,20}$/;
const ROLE_ASSIGN_DELAY_MS = 125;
const ROLE_PROGRESS_EDIT_MS = 5_000;
const ROLE_LIST_PAGE_SIZE = 1000;
const activeRoleAllJobs = new Map();

const DANGEROUS_ALL_ROLE_PERMISSIONS = [
  [PermissionFlagsBits.Administrator, "Administrator"],
  [PermissionFlagsBits.ManageRoles, "Manage Roles"],
  [PermissionFlagsBits.ManageGuild, "Manage Server"],
  [PermissionFlagsBits.BanMembers, "Ban Members"],
  [PermissionFlagsBits.KickMembers, "Kick Members"],
  [PermissionFlagsBits.ModerateMembers, "Timeout Members"]
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSnowflake(input, type = "any") {
  const raw = String(input || "").trim();
  const roleMatch = raw.match(/^<@&(\d{17,20})>$/);
  if (roleMatch && (type === "role" || type === "any")) return roleMatch[1];
  const userMatch = raw.match(/^<@!?(\d{17,20})>$/);
  if (userMatch && (type === "user" || type === "any")) return userMatch[1];
  if (SNOWFLAKE_RE.test(raw)) return raw;
  return null;
}

function parseRoleMessage(content) {
  const trimmed = String(content || "").trim();
  if (!/^\$role(?:\s|$)/i.test(trimmed)) return null;
  if (/^\$role$/i.test(trimmed)) return { action: "help" };

  const allMatch = trimmed.match(/^\$role\s+all\s+(\S+)$/i);
  if (allMatch) {
    return {
      action: "all",
      roleId: extractSnowflake(allMatch[1], "role")
    };
  }

  const singleMatch = trimmed.match(/^\$role\s+(\S+)\s+(\S+)$/i);
  if (singleMatch) {
    return {
      action: "one",
      userId: extractSnowflake(singleMatch[1], "user"),
      roleId: extractSnowflake(singleMatch[2], "role")
    };
  }

  return { action: "help" };
}

function roleUsageBody() {
  return [
    "**Correct format:**",
    "`$role all <roleid>`",
    "`$role <@user|userid> <roleid>`",
    "",
    "Use the raw role id for large roles so Discord does not ping anyone."
  ].join("\n");
}

function rolePosition(role) {
  return Number(role?.rawPosition ?? role?.position ?? 0);
}

function roleHasPermission(role, permission) {
  return Boolean(role?.permissions?.has?.(permission));
}

function getDangerousAllRolePermissionLabels(role) {
  return DANGEROUS_ALL_ROLE_PERMISSIONS
    .filter(([permission]) => roleHasPermission(role, permission))
    .map(([, label]) => label);
}

function describeRole(role) {
  return `${role?.name || "role"} (${role?.id || "unknown"})`;
}

function describeUser(userId) {
  return userId ? `<@${userId}> (${userId})` : "unknown user";
}

function buildProgressBar(done, total, width = 18) {
  const numericTotal = Math.max(0, Number(total || 0));
  if (!numericTotal) return `[${"-".repeat(width)}]`;
  const ratio = Math.max(0, Math.min(1, Number(done || 0) / numericTotal));
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}

async function sendRolePanel(message, panel) {
  const payload = {
    embeds: [buildPanel(panel)],
    allowedMentions: { parse: [] }
  };

  try {
    return await message.reply(payload);
  } catch {
    return message.channel?.send?.(payload);
  }
}

async function editRolePanel(sentMessage, panel) {
  if (!sentMessage?.edit) return false;
  await sentMessage.edit({
    embeds: [buildPanel(panel)],
    allowedMentions: { parse: [] }
  }).catch(() => null);
  return true;
}

async function resolveBotMember(guild) {
  if (guild?.members?.me) return guild.members.me;
  if (typeof guild?.members?.fetchMe !== "function") return null;
  return guild.members.fetchMe().catch(() => null);
}

async function resolveRole(guild, roleId) {
  if (!roleId) return null;
  const cached = guild?.roles?.cache?.get?.(roleId);
  if (cached) return cached;
  if (typeof guild?.roles?.fetch !== "function") return null;
  return guild.roles.fetch(roleId).catch(() => null);
}

async function resolveMember(guild, userId) {
  if (!userId) return null;
  const cached = guild?.members?.cache?.get?.(userId);
  if (cached) return cached;
  if (typeof guild?.members?.fetch !== "function") return null;
  return guild.members.fetch({ user: userId, force: true })
    .catch(() => guild.members.fetch(userId).catch(() => null));
}

async function validateRoleCommandTarget(message, command, { allowDangerousAll = false } = {}) {
  if (!message?.inGuild?.()) {
    return { ok: false, panel: { header: "Server Only", body: "role commands only work inside the server", color: WARN } };
  }

  if (!command.roleId) {
    return { ok: false, panel: { header: "Role Command", body: roleUsageBody(), color: INFO } };
  }

  const guild = message.guild;
  const role = await resolveRole(guild, command.roleId);
  if (!role) {
    return { ok: false, panel: { header: "Role Not Found", body: "I could not find that role id in this server.", color: DANGER } };
  }

  if (role.id === guild.id || role.name === "@everyone") {
    return { ok: false, panel: { header: "Unsafe Role", body: "`@everyone` cannot be assigned like this.", color: DANGER } };
  }

  if (role.managed) {
    return { ok: false, panel: { header: "Managed Role", body: "Discord/integration-managed roles cannot be assigned manually.", color: DANGER } };
  }

  const botMember = await resolveBotMember(guild);
  if (!botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
    return { ok: false, panel: { header: "Missing Bot Permission", body: "I need `Manage Roles` to assign roles.", color: DANGER } };
  }

  const botHighest = botMember.roles?.highest;
  if (!botHighest || rolePosition(role) >= rolePosition(botHighest)) {
    return {
      ok: false,
      panel: {
        header: "Role Too High",
        body: "Move my bot role above the target role in Discord's role list, then retry.",
        color: DANGER
      }
    };
  }

  if (command.action === "all" && !allowDangerousAll) {
    const dangerous = getDangerousAllRolePermissionLabels(role);
    if (dangerous.length) {
      return {
        ok: false,
        panel: {
          header: "Unsafe Bulk Role",
          body: [
            `I will not bulk-assign roles with elevated permissions: ${dangerous.join(", ")}.`,
            "Use a normal member/access role for `$role all`."
          ].join("\n"),
          color: DANGER
        }
      };
    }
  }

  return { ok: true, guild, role, botMember };
}

function compareSnowflakeIds(a, b) {
  try {
    const left = BigInt(String(a));
    const right = BigInt(String(b));
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  } catch {
    return String(a).localeCompare(String(b));
  }
}

async function collectMembersMissingRole(guild, roleId, {
  pageSize = ROLE_LIST_PAGE_SIZE,
  onProgress = async () => {}
} = {}) {
  let after;
  let scanned = 0;
  let already = 0;
  let bots = 0;
  const missing = [];

  for (;;) {
    const page = await guild.members.list({
      limit: pageSize,
      after,
      cache: false
    });
    const members = [...(page?.values?.() || [])].sort((a, b) => compareSnowflakeIds(a.id, b.id));
    if (!members.length) break;

    for (const member of members) {
      scanned += 1;
      if (member.user?.bot) {
        bots += 1;
      } else if (member.roles?.cache?.has?.(roleId)) {
        already += 1;
      } else {
        missing.push(member.id);
      }
    }

    after = members[members.length - 1].id;
    await onProgress({ scanned, already, bots, missing: missing.length });
    if (members.length < pageSize) break;
  }

  return { scanned, already, bots, missing };
}

function buildRoleAllPanel({ role, phase, scanned = 0, estimate = 0, missing = 0, already = 0, bots = 0, added = 0, failed = 0, total = 0 }) {
  const isAssigning = phase === "assigning";
  const done = isAssigning ? added + failed : scanned;
  const denominator = isAssigning ? total : estimate;
  return {
    header: isAssigning ? "Role All - Assigning" : phase === "done" ? "Role All Complete" : "Role All - Scanning",
    body: [
      `**Role:** ${describeRole(role)}`,
      `**Progress:** ${buildProgressBar(done, denominator)}`,
      `**Scanned:** ${scanned}${estimate ? ` / about ${estimate}` : ""}`,
      `**Missing Role:** ${missing}`,
      `**Already Had Role:** ${already}`,
      `**Bots Skipped:** ${bots}`,
      isAssigning || phase === "done" ? `**Assigned:** ${added} / ${total}` : null,
      isAssigning || phase === "done" ? `**Failed/Skipped During Apply:** ${failed}` : null
    ].filter(Boolean).join("\n"),
    color: phase === "done" ? SUCCESS : INFO
  };
}

async function handleSingleRoleCommand(message, command, deps = {}) {
  if (!command.userId || !command.roleId) {
    await sendRolePanel(message, { header: "Role Command", body: roleUsageBody(), color: INFO });
    return true;
  }

  const validation = await validateRoleCommandTarget(message, command);
  if (!validation.ok) {
    await sendRolePanel(message, validation.panel);
    return true;
  }

  const { guild, role } = validation;
  const member = await resolveMember(guild, command.userId);
  if (!member) {
    await sendRolePanel(message, {
      header: "Member Not Found",
      body: `I could not find ${describeUser(command.userId)} in this server.`,
      color: DANGER
    });
    return true;
  }

  if (member.manageable === false) {
    await sendRolePanel(message, {
      header: "Member Too High",
      body: "I cannot edit roles for that member because of Discord role hierarchy.",
      color: DANGER
    });
    return true;
  }

  if (member.roles?.cache?.has?.(role.id)) {
    await sendRolePanel(message, {
      header: "Role Already Present",
      body: `${describeUser(member.id)} already has ${describeRole(role)}.`,
      color: WARN
    });
    return true;
  }

  try {
    await member.roles.add(role, `owner role command by ${message.author?.tag || message.author?.id || "owner"}`);
  } catch (err) {
    await sendRolePanel(message, {
      header: "Role Add Failed",
      body: `Discord refused the role update: ${err?.message || err}`,
      color: DANGER
    });
    return true;
  }

  await sendRolePanel(message, {
    header: "Role Added",
    body: `${describeUser(member.id)} now has ${describeRole(role)}.`,
    color: SUCCESS
  });
  await (deps.sendLog || sendLogPanel)(guild, {
    header: "Role Added",
    body: [
      `**User:** ${describeUser(member.id)}`,
      `**Role:** ${describeRole(role)}`,
      `**By:** ${message.author?.id ? `<@${message.author.id}>` : "owner"}`
    ].join("\n"),
    color: SUCCESS
  }).catch(() => null);
  return true;
}

async function handleRoleAllCommand(message, command, {
  allowBulkMemberList = ENABLE_GUILD_MEMBER_EVENTS,
  sleepFn = sleep,
  sendLog = sendLogPanel,
  nowFn = Date.now
} = {}) {
  if (!allowBulkMemberList) {
    await sendRolePanel(message, {
      header: "Guild Members Intent Needed",
      body: [
        "`$role all` has to request the server member list.",
        "Enable the Discord Developer Portal `Server Members Intent`, set `ENABLE_GUILD_MEMBER_EVENTS=true`, then restart the bot.",
        "Single-user `$role <user> <roleid>` still works without the full member list."
      ].join("\n"),
      color: WARN
    });
    return true;
  }

  const validation = await validateRoleCommandTarget(message, command);
  if (!validation.ok) {
    await sendRolePanel(message, validation.panel);
    return true;
  }

  const { guild, role } = validation;
  const lockKey = guild.id;
  if (activeRoleAllJobs.has(lockKey)) {
    await sendRolePanel(message, {
      header: "Role All Already Running",
      body: `A role-all job is already running in this server: ${activeRoleAllJobs.get(lockKey)}`,
      color: WARN
    });
    return true;
  }

  activeRoleAllJobs.set(lockKey, describeRole(role));
  const estimate = Number(guild.memberCount || 0);
  const progressMessage = await sendRolePanel(message, buildRoleAllPanel({
    role,
    phase: "scanning",
    estimate
  }));
  await sendLog(guild, {
    header: "Role All Started",
    body: [
      `**Role:** ${describeRole(role)}`,
      `**By:** ${message.author?.id ? `<@${message.author.id}>` : "owner"}`,
      `**Estimated Members:** ${estimate || "unknown"}`
    ].join("\n"),
    color: INFO
  }).catch(() => null);

  let lastEditAt = 0;
  let scanned = 0;
  let already = 0;
  let bots = 0;
  let missing = [];
  let added = 0;
  let failed = 0;

  try {
    const scan = await collectMembersMissingRole(guild, role.id, {
      onProgress: async (progress) => {
        scanned = progress.scanned;
        already = progress.already;
        bots = progress.bots;
        const current = nowFn();
        if (current - lastEditAt >= ROLE_PROGRESS_EDIT_MS) {
          lastEditAt = current;
          await editRolePanel(progressMessage, buildRoleAllPanel({
            role,
            phase: "scanning",
            scanned,
            estimate,
            missing: progress.missing,
            already,
            bots
          }));
        }
      }
    });

    scanned = scan.scanned;
    already = scan.already;
    bots = scan.bots;
    missing = scan.missing;

    await editRolePanel(progressMessage, buildRoleAllPanel({
      role,
      phase: "assigning",
      scanned,
      estimate,
      missing: missing.length,
      already,
      bots,
      total: missing.length
    }));

    for (const userId of missing) {
      const member = await resolveMember(guild, userId);
      if (!member || member.user?.bot || member.manageable === false || member.roles?.cache?.has?.(role.id)) {
        failed += 1;
      } else {
        try {
          await member.roles.add(role, `owner role-all command by ${message.author?.tag || message.author?.id || "owner"}`);
          added += 1;
        } catch {
          failed += 1;
        }
      }

      const current = nowFn();
      if (current - lastEditAt >= ROLE_PROGRESS_EDIT_MS || added + failed === missing.length) {
        lastEditAt = current;
        await editRolePanel(progressMessage, buildRoleAllPanel({
          role,
          phase: "assigning",
          scanned,
          estimate,
          missing: missing.length,
          already,
          bots,
          added,
          failed,
          total: missing.length
        }));
      }
      await sleepFn(ROLE_ASSIGN_DELAY_MS);
    }

    await editRolePanel(progressMessage, buildRoleAllPanel({
      role,
      phase: "done",
      scanned,
      estimate,
      missing: missing.length,
      already,
      bots,
      added,
      failed,
      total: missing.length
    }));
    await sendLog(guild, {
      header: "Role All Complete",
      body: [
        `**Role:** ${describeRole(role)}`,
        `**By:** ${message.author?.id ? `<@${message.author.id}>` : "owner"}`,
        `**Scanned:** ${scanned}`,
        `**Assigned:** ${added}`,
        `**Already Had Role:** ${already}`,
        `**Bots Skipped:** ${bots}`,
        `**Failed/Skipped:** ${failed}`
      ].join("\n"),
      color: failed ? WARN : SUCCESS
    }).catch(() => null);
  } catch (err) {
    await editRolePanel(progressMessage, {
      header: "Role All Failed",
      body: `Bulk role assignment stopped: ${err?.message || err}`,
      color: DANGER
    });
    await sendLog(guild, {
      header: "Role All Failed",
      body: `Bulk role assignment for ${describeRole(role)} failed: ${err?.message || err}`,
      color: DANGER
    }).catch(() => null);
  } finally {
    activeRoleAllJobs.delete(lockKey);
  }

  return true;
}

async function maybeHandleRoleCommand(message, deps = {}) {
  const command = parseRoleMessage(message.content);
  if (!command) return false;
  if (!canUseOwnerCommands(message)) return true;

  if (command.action === "help") {
    await sendRolePanel(message, { header: "Role Command", body: roleUsageBody(), color: INFO });
    return true;
  }

  if (command.action === "one") {
    return handleSingleRoleCommand(message, command, deps);
  }

  if (command.action === "all") {
    return handleRoleAllCommand(message, command, deps);
  }

  await sendRolePanel(message, { header: "Role Command", body: roleUsageBody(), color: INFO });
  return true;
}

module.exports = {
  buildProgressBar,
  collectMembersMissingRole,
  extractSnowflake,
  maybeHandleRoleCommand,
  parseRoleMessage,
  validateRoleCommandTarget
};
