const {
  ADMIN_ROLE_IDS,
  MOD_ROLE_IDS,
  OWNER_ROLE_IDS,
  OWNER_USER_IDS,
  STAFF_ROLE_IDS
} = require("../config");
const { WARN, buildRichPanel } = require("../embed");
const { sendLogPanel } = require("../log-channel");
const { hasAnyRole } = require("../permissions");
const { similarity } = require("../prohibited-commerce");
const { recordRuntimeEvent } = require("../runtime-health");

const STAFF_SIMILARITY_THRESHOLD = 0.75;
const STAFF_ROLE_IDS_ALL = [...OWNER_ROLE_IDS, ...ADMIN_ROLE_IDS, ...MOD_ROLE_IDS, ...STAFF_ROLE_IDS];
const CONFUSABLES = {
  "\u0430": "a",
  "\u0435": "e",
  "\u043e": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0445": "x",
  "\u0443": "y",
  "\u0456": "i",
  "\u03bf": "o",
  "\u03c1": "p",
  "\u03bd": "v",
  "\u03b1": "a",
  "0": "o",
  "1": "l",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  "$": "s",
  "|": "l",
  "!": "i"
};

function normalizeHomoglyphs(str) {
  return String(str || "")
    .toLowerCase()
    .split("")
    .map((char) => CONFUSABLES[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "");
}

function isStaffMember(member) {
  return OWNER_USER_IDS.includes(String(member?.id || member?.user?.id || "")) ||
    hasAnyRole(member, STAFF_ROLE_IDS_ALL);
}

function memberNames(member) {
  return [
    member?.displayName,
    member?.nickname,
    member?.user?.globalName,
    member?.user?.username
  ]
    .map(normalizeHomoglyphs)
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

function collectCachedStaffMembers(guild, joiningMember) {
  return [...(guild?.members?.cache?.values?.() || [])]
    .filter((member) => member?.id !== joiningMember?.id && isStaffMember(member));
}

function findImpersonationMatch(joiningMember, staffMembers) {
  const joiningNames = memberNames(joiningMember);
  let best = null;
  for (const staffMember of staffMembers) {
    const staffNames = memberNames(staffMember);
    for (const joiningName of joiningNames) {
      for (const staffName of staffNames) {
        if (joiningName.length < 3 || staffName.length < 3) continue;
        const score = similarity(joiningName, staffName);
        if (score >= STAFF_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
          best = { staffMember, score, joiningName, staffName };
        }
      }
    }
  }
  return best;
}

function buildImpersonationPanel(member, match) {
  return buildRichPanel({
    title: "Potential Staff Impersonation",
    color: WARN,
    fields: [
      {
        name: "Joining Member",
        value: `<@${member.id}> \`${member.user?.username || member.displayName || member.id}\``,
        inline: true
      },
      {
        name: "Resembles",
        value: `<@${match.staffMember.id}> \`${match.staffMember.user?.username || match.staffMember.displayName || match.staffMember.id}\``,
        inline: true
      },
      {
        name: "Similarity",
        value: `${Math.round(match.score * 100)}%`,
        inline: true
      },
      {
        name: "Action",
        value: "No action taken - review manually",
        inline: false
      }
    ]
  });
}

async function maybeHandleImpersonationCheck(member, { sendLog = sendLogPanel } = {}) {
  try {
    if (!member?.guild || member.user?.bot || isStaffMember(member)) return false;
    const staffMembers = collectCachedStaffMembers(member.guild, member);
    if (!staffMembers.length) return false;
    const match = findImpersonationMatch(member, staffMembers);
    if (!match) return false;
    await sendLog(member.guild, buildImpersonationPanel(member, match)).catch(() => null);
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "impersonation-check", err?.message || err);
    return false;
  }
}

module.exports = {
  collectCachedStaffMembers,
  findImpersonationMatch,
  maybeHandleImpersonationCheck,
  normalizeHomoglyphs
};
