"use strict";

// Diagnostic: report the bot's EFFECTIVE permissions in a given channel,
// computed the same way Discord does (base role perms + channel overwrites).
// Usage: node scripts/check-channel-perms.js <channelId>
// Reads DISCORD_TOKEN from the environment / .env. Never prints the token.

const https = require("https");
const fs = require("fs");
const path = require("path");

function loadToken() {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN.trim();
  try {
    const env = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    const m = env.match(/^DISCORD_TOKEN\s*=\s*(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return null;
}

const TOKEN = loadToken();
const channelId = process.argv[2];
if (!TOKEN) { console.error("no DISCORD_TOKEN"); process.exit(1); }
if (!channelId) { console.error("usage: node scripts/check-channel-perms.js <channelId>"); process.exit(1); }

function api(p) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: "discord.com", path: `/api/v10${p}`, method: "GET", headers: { Authorization: `Bot ${TOKEN}`, "User-Agent": "kicialite-diag/1.0" } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(new Error(`${p} → HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const P = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  MODERATE_MEMBERS: 1n << 40n
};

(async () => {
  const me = await api("/users/@me");
  const channel = await api(`/channels/${channelId}`);
  const guildId = channel.guild_id;
  const roles = await api(`/guilds/${guildId}/roles`);
  const member = await api(`/guilds/${guildId}/members/${me.id}`);

  const roleById = new Map(roles.map((r) => [r.id, r]));
  const everyone = roleById.get(guildId);
  let base = BigInt(everyone?.permissions || "0");
  for (const rid of member.roles) base |= BigInt(roleById.get(rid)?.permissions || "0");

  const isAdmin = (base & P.ADMINISTRATOR) === P.ADMINISTRATOR;

  // channel overwrites
  const ow = channel.permission_overwrites || [];
  const find = (id) => ow.find((o) => o.id === id);
  if (!isAdmin) {
    const ev = find(guildId);
    if (ev) base = (base & ~BigInt(ev.deny)) | BigInt(ev.allow);
    let allow = 0n, deny = 0n;
    for (const rid of member.roles) { const o = find(rid); if (o) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); } }
    base = (base & ~deny) | allow;
    const mo = find(me.id);
    if (mo) base = (base & ~BigInt(mo.deny)) | BigInt(mo.allow);
  }

  const has = (bit) => isAdmin || (base & bit) === bit;
  console.log(`bot: ${me.username} (${me.id})`);
  console.log(`channel: #${channel.name} (${channelId})  guild ${guildId}`);
  console.log(`administrator:    ${isAdmin}`);
  console.log(`view channel:     ${has(P.VIEW_CHANNEL)}`);
  console.log(`send messages:    ${has(P.SEND_MESSAGES)}`);
  console.log(`embed links:      ${has(P.EMBED_LINKS)}`);
  console.log(`attach files:     ${has(P.ATTACH_FILES)}`);
  console.log(`MANAGE MESSAGES:  ${has(P.MANAGE_MESSAGES)}   <-- needed to delete images`);
  console.log(`moderate members: ${has(P.MODERATE_MEMBERS)}   <-- needed to timeout`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
