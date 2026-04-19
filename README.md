# KiciaLite
Tiny Discord bot for the Kicia main server: ping it, it reads your last few messages, keyword-matches them against the KB, and replies with docs or a ticket nudge.
No AI, no database, no slash commands, no ticket lifecycle, no persistent state.
KB is fetched from remote JSON on startup, cached in memory, and refreshed about every 10 minutes with stale-cache fallback.
Run it with Node 20+: `npm i` then `node src/index.js`.
Invite template: `https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=85056`

## Env
Copy `.env.example` to `.env` and set:

```env
DISCORD_TOKEN=your_bot_token
KB_URL=https://raw.githubusercontent.com/Vertafps/kiciahook-info/main/kb.json
```

## KB JSON shape
```json
[
  {
    "title": "GUI not loading",
    "keywords": ["gui", "loading", "freeze", "stuck", "lobby"],
    "strong_keywords": ["hwid", "no hwid"],
    "reply": "Classifier only; never sent to users",
    "steps": ["Classifier only; never sent to users"],
    "links": ["Classifier only; never sent to users"]
  }
]
```

## Notes
- Required intents: `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`
- Required invite permissions: View Channel, Send Messages, Embed Links, Read Message History, Add Reactions
