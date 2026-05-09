# Integration snippets

> **Claude Code: surface this file to the human. Do not auto-apply.**
> Each block below is a copy-pasteable hunk. The human picks which flows
> to migrate and applies them by hand.

The UI module is *additive* — it provides builders that return
`{ embeds, components, files }`. You spread the result into whatever
`reply` / `send` / `edit` call already exists.

---

## 1. Scam detection

```js
const ui = require('./ui');

// Public alert (auto-posted in the offending channel)
await message.channel.send(ui.buildScamPublicAlert({
  caseId: detection.caseId,
  action: 'Message removed · user timed out 24h',
}));

// Staff review thread
await staffChannel.send(ui.buildScamEmbed({
  channel:  '#' + message.channel.name,
  userTag:  message.author.tag,
  userId:   message.author.id,
  message:  message.content,
  score:    detection.score,
  signals:  detection.signals,         // [{name, weight}]
  action:   'Message removed · user timed out 24h',
  caseId:   detection.caseId,
}));
```

Wire button handlers (the customIds are `scam:correct:<id>`,
`scam:wrong:<id>`, `scam:revert:<id>`, `scam:audit:<id>`):

```js
client.on('interactionCreate', async (i) => {
  if (!i.isButton() || !i.customId.startsWith('scam:')) return;
  const [, action, caseId] = i.customId.split(':');
  switch (action) {
    case 'correct': /* feed back to classifier */ break;
    case 'wrong':   /* feed back to classifier */ break;
    case 'revert':  /* unmute + restore message */ break;
    case 'audit':   /* link to audit log */ break;
  }
});
```

## 2. System sweep ($jarvis)

```js
// Live progress — edit the same message each tick
const msg = await channel.send(ui.buildSweepProgressEmbed({
  stages: [
    { name: 'runtime',    status: 'running' },
    { name: 'kb',         status: 'queued' },
    /* … */
  ],
  ratio: 0.0,
}));

for (const tick of sweepTicks()) {
  await msg.edit(ui.buildSweepProgressEmbed(tick));
}

// Final report
await msg.edit(ui.buildSweepReportEmbed({
  systems:  [/* {key, score, status, detail} */],
  findings: [/* {key, severity, line} */],
  runId:    'J-2401',
}));
```

## 3. Outage watch

```js
// Public (in #general)
await general.send(ui.buildOutagePublic({ since: '4 minutes ago' }));

// Staff review (in #staff) — rendered as reports come in
await staff.send(ui.buildOutageStaffReview({
  reports: [{ t: 0, user: 'alice', conf: 88 }, /* … */],
  threshold: 4, windowMin: 10,
  caseId: 'O-2401',
}));

// After staff confirms
await general.send(ui.buildOutageConfirmed({ since: '5 minutes ago' }));

// Or false alarm
await general.send(ui.buildOutageCleared({ uptime: 99.97 }));
```

## 4. $status

```js
await i.reply(ui.buildStatusEmbed({
  status:      currentStatus,           // 'UP' | 'DOWN' | 'UNAWARE'
  uptime:      stats.uptime24h,
  latencyMs:   client.ws.ping,
  ribbon:      stats.ribbon96,          // length-96 array
  lastDown:    stats.lastDownHumanized,
  incidents7d: String(stats.incidents7d),
}));
```

## 5. Daily recap (cron)

```js
await recapChannel.send(ui.buildDailyRecapEmbed({
  date:     new Date().toDateString(),
  slices:   [
    { label: 'Help Replied',   value: 64 },
    { label: 'Scam Cleared',   value: 18 },
    { label: 'Scam Confirmed', value: 8  },
    { label: 'Status Pings',   value: 24 },
  ],
  activity:    hourlyCounts,            // length-24 array
  outageHour:  14,                      // optional
  highlights: [
    { label: 'Top channel', value: '#help' },
    { label: 'Avg latency', value: '47ms'  },
  ],
}));
```

## 6. KB lookup

```js
const result = kb.search(question);

if (result.match >= 0.7) {
  await i.reply(ui.buildKbMatchEmbed({
    question, title: result.title, tag: result.tag,
    steps: result.steps, step: 1, match: result.match,
    source: 'kb.json', url: result.url,
  }));
} else {
  await i.reply(ui.buildKbNoMatchEmbed({
    question,
    score: Math.round(result.match * 100),
    supportInviteUrl: process.env.KICIAHOOK_SUPPORT_INVITE,
    ticketUrl:        process.env.KICIAHOOK_TICKET_URL,
    closestArticles:  result.candidates.slice(0, 3),
  }));
}
```

## 7. Lockdown

```js
await channel.send(ui.buildLockdownEmbed({
  channels: [
    { name: 'general', status: 'locked' },
    { name: 'help',    status: 'locked' },
    /* … */
  ],
  reason: 'precautionary · scam wave',
  actor:  i.user.tag,
}));
```

---

## Notes

* **Don't** import the embed builders inside existing handlers if you want to
  keep them untouched — wire them at call sites in your dispatcher.
* Every builder returns `{ embeds, components, files }`; spread it into whatever
  `reply`/`send`/`edit` call you already have.
* All images are PNG buffers. Discord caches them by attachment URL — don't
  re-attach the same image needlessly across edits.
