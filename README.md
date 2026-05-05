# KiciaLite

Discord support, moderation, and utility bot for the Kicia main server.

The bot answers support pings from the remote KB, tracks KiciaHook runtime status, watches risky links and scam/trade patterns, logs moderation actions with review controls, supports restricted reaction rules, locks configured channels, and posts daily stats.

Run with Node 20+:

```powershell
npm install
npm start
```

## Env

Copy `.env.example` to `.env` and set:

```env
DISCORD_TOKEN=your_bot_token
KB_URL=https://raw.githubusercontent.com/Vertafps/kiciahook-info/main/kb.json
```

Optional reputation and AI keys can stay blank. The bot keeps local-first moderation behavior when optional services are unavailable.

```env
GOOGLE_SAFE_BROWSING_API_KEY=
GOOGLE_WEB_RISK_API_KEY=
VIRUSTOTAL_API_KEY=
GEMINI_API_KEY=
GEMINI_SCAM_MODEL=gemini-2.5-flash-lite
```

## Commands

Everyone:

- `$status` shows the current KiciaHook status.
- Ping the bot after describing an issue to get a KB/docs match or ticket nudge.

Owners:

- `$status up` / `$status down` updates the runtime support status.
- `$state` shows the bot presence text.
- `$state <message>` sets and persists the bot custom presence text.
- `$state reset` restores the default presence text.
- `$fetch` refreshes the KB cache.
- `$jarvis` runs runtime, KB, moderation, intelligence, and security diagnostics.
- `$testpromax` runs the extended diagnostics sweep with a longer progress pass.
- `$role all <roleid>` assigns a safe role to every human member missing it.
- `$role <@user|userid> <roleid>` assigns a role to one member.
- `$db` inspects SQLite state.
- `$scamaudit` shows recent scam/trade classifier decisions.
- `$whitelist <user>` / `$whitelist remove <user>` manages manual moderation bypass.
- `$lock` / `$unlock` updates configured channel send permissions.

Staff and higher:

- `$allowlink <url>` / `$removelink <url>` manages dynamic trusted links.
- `$emoji <emoji>` / `$emoji remove <emoji>` manages restricted reactions.
- `$nick` / `$nick add /pattern/i -> name` / `$nick remove <id>` manages nickname rename rules.

## State

Persistent state is stored in `data/restricted-reactions.sqlite` via `sql.js`.

The database currently stores app config, bot presence state, restricted emojis, trusted links, nickname rename rules, manual moderation whitelist users, daily stats, scam decision audits, and moderation action review records.

## Notes

Required intents:

- `Guilds`
- `GuildMessages`
- `GuildMessageReactions`
- `MessageContent`
- `DirectMessages`

Optional privileged intent:

- `GuildMembers` enables `$role all`, join/member-update nickname checks, and join-time staff impersonation review. Set `ENABLE_GUILD_MEMBER_EVENTS=true` only after enabling this intent in the Discord Developer Portal.

Recommended invite permissions include View Channel, Send Messages, Embed Links, Read Message History, Add Reactions, Manage Messages, Manage Nicknames, Manage Roles, Moderate Members, and channel/role permissions needed for lockdown. The bot role must be above every role it assigns and above every member it renames.
