const assert = require("node:assert/strict");
const test = require("node:test");
const { PermissionFlagsBits } = require("discord.js");
const {
  buildProgressBar,
  collectMembersMissingRole,
  maybeHandleRoleCommand,
  parseRoleMessage
} = require("../src/handlers/role-assignment");

const OWNER_ID = "847703912932311091";
const ROLE_ID = "1484218502805061662";
const USER_ID = "123456789012345678";

function permissionsWith(values = []) {
  return {
    has: (permission) => values.includes(permission)
  };
}

function roleWith({ id = ROLE_ID, name = "member", position = 1, permissions = [] } = {}) {
  return {
    id,
    name,
    position,
    rawPosition: position,
    managed: false,
    permissions: permissionsWith(permissions)
  };
}

function memberWith({ id, bot = false, hasRole = false, manageable = true, addCalls = [] }) {
  return {
    id,
    manageable,
    user: { id, bot, username: id },
    roles: {
      cache: {
        has: (roleId) => hasRole && roleId === ROLE_ID
      },
      add: async (role, reason) => {
        addCalls.push({ id, roleId: role.id || role, reason });
      }
    }
  };
}

function buildRoleCommandFixture(content, {
  role = roleWith(),
  targetMember = memberWith({ id: USER_ID }),
  allMembers = []
} = {}) {
  const replies = [];
  const edits = [];
  const logs = [];
  const addCalls = targetMember.roles.add ? [] : null;
  if (addCalls) {
    targetMember.roles.add = async (nextRole, reason) => {
      addCalls.push({ id: targetMember.id, roleId: nextRole.id || nextRole, reason });
    };
  }

  const guild = {
    id: "guild-1",
    memberCount: allMembers.length || 1,
    roles: {
      cache: {
        get: (roleId) => roleId === role.id ? role : null
      }
    },
    members: {
      me: {
        permissions: permissionsWith([PermissionFlagsBits.ManageRoles]),
        roles: { highest: { position: 50, rawPosition: 50 } }
      },
      cache: {
        get: (userId) => userId === targetMember.id ? targetMember : null
      },
      fetch: async ({ user }) => {
        const found = [targetMember, ...allMembers].find((member) => member.id === user);
        if (!found) throw new Error("missing");
        return found;
      },
      list: async ({ after, limit }) => {
        if (after) return new Map();
        return new Map(allMembers.slice(0, limit).map((member) => [member.id, member]));
      }
    }
  };

  const message = {
    content,
    guild,
    author: { id: OWNER_ID, tag: "owner#0001" },
    member: {
      roles: { cache: { has: (roleId) => roleId === "1484221158390890496" } }
    },
    inGuild: () => true,
    reply: async (payload) => {
      replies.push(payload);
      return {
        edit: async (nextPayload) => edits.push(nextPayload)
      };
    }
  };

  return {
    addCalls,
    edits,
    guild,
    logs,
    message,
    replies,
    sendLog: async (_guild, panel) => {
      logs.push(panel);
      return true;
    }
  };
}

test("role command parses bulk and single formats without role pings", () => {
  assert.deepEqual(parseRoleMessage(`$role all <@&${ROLE_ID}>`), {
    action: "all",
    roleId: ROLE_ID
  });
  assert.deepEqual(parseRoleMessage(`$role <@${USER_ID}> ${ROLE_ID}`), {
    action: "one",
    userId: USER_ID,
    roleId: ROLE_ID
  });
  assert.equal(buildProgressBar(5, 10), "[#########---------] 50%");
});

test("single role command assigns a role to one fetched member", async () => {
  const fixture = buildRoleCommandFixture(`$role ${USER_ID} ${ROLE_ID}`);
  const handled = await maybeHandleRoleCommand(fixture.message, {
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.equal(fixture.addCalls.length, 1);
  assert.equal(fixture.addCalls[0].roleId, ROLE_ID);
  assert.match(fixture.replies[0].embeds[0].data.description, /Role Added/i);
  assert.equal(fixture.logs.length, 1);
});

test("role all rejects dangerous elevated roles", async () => {
  const role = roleWith({
    permissions: [PermissionFlagsBits.Administrator]
  });
  const fixture = buildRoleCommandFixture(`$role all ${ROLE_ID}`, { role });
  const handled = await maybeHandleRoleCommand(fixture.message, {
    allowBulkMemberList: true,
    sendLog: fixture.sendLog
  });

  assert.equal(handled, true);
  assert.match(fixture.replies[0].embeds[0].data.description, /Unsafe Bulk Role/i);
  assert.equal(fixture.logs.length, 0);
});

test("role all scans missing humans before applying the role", async () => {
  const missing = memberWith({ id: "123456789012345678" });
  const already = memberWith({ id: "123456789012345679", hasRole: true });
  const bot = memberWith({ id: "123456789012345680", bot: true });
  const fixture = buildRoleCommandFixture(`$role all ${ROLE_ID}`, {
    targetMember: missing,
    allMembers: [missing, already, bot]
  });

  const handled = await maybeHandleRoleCommand(fixture.message, {
    allowBulkMemberList: true,
    sendLog: fixture.sendLog,
    sleepFn: async () => {},
    nowFn: (() => {
      let now = 0;
      return () => {
        now += 6000;
        return now;
      };
    })()
  });

  assert.equal(handled, true);
  assert.equal(fixture.addCalls.length, 1);
  assert.equal(fixture.addCalls[0].id, missing.id);
  assert.ok(fixture.edits.length >= 2);
  assert.match(fixture.edits.at(-1).embeds[0].data.description, /Role All Complete/i);
  assert.equal(fixture.logs.length, 2);
});

test("member list collector returns only humans missing the target role", async () => {
  const missing = memberWith({ id: "123456789012345678" });
  const already = memberWith({ id: "123456789012345679", hasRole: true });
  const bot = memberWith({ id: "123456789012345680", bot: true });
  const guild = {
    members: {
      list: async () => new Map([
        [missing.id, missing],
        [already.id, already],
        [bot.id, bot]
      ])
    }
  };

  const result = await collectMembersMissingRole(guild, ROLE_ID, { pageSize: 1000 });
  assert.deepEqual(result.missing, [missing.id]);
  assert.equal(result.already, 1);
  assert.equal(result.bots, 1);
});
