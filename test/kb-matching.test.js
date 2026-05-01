process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "test-token";
process.env.KB_URL = process.env.KB_URL || "https://example.com/kb.json";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeKb, tryIssueMatch } = require("../src/kb");

const kb = normalizeKb({
  issues: [
    {
      title: "GUI Not Loading / Security Kick 1 / FPS Drops / Lag / Lobby Issue",
      category: "executor",
      keywords: ["gui not loading", "ui gone", "wont load", "not loading", "lobby", "freeze"],
      match_phrases: ["gui not loading", "ui gone", "wont load", "not loading", "broken in lobby"],
      reply: "KiciaHook does not work in the main lobby."
    },
    {
      title: "How to Load a Config",
      category: "config",
      keywords: ["load config", "import config", "json config", "json file", "where do i put config"],
      match_phrases: ["load config", "import config", "where do i put config", "i have a config"],
      reply: "Place your .json config file in Workspace > KiciaHook > RivalsV2 > Configs."
    },
    {
      title: "No HWID Found Error",
      category: "script",
      keywords: ["no hwid found", "hwid error", "hwid not found"],
      match_phrases: ["no hwid found", "hwid error", "hwid not found"],
      reply: "Copy the full script from the panel."
    },
    {
      title: "How to Reset HWID",
      category: "account",
      keywords: ["reset hwid", "new pc", "new computer", "different pc"],
      match_phrases: ["reset hwid", "new pc hwid", "changed pc"],
      reply: "We no longer manually reset HWIDs. Please wait out your cooldown."
    },
    {
      title: "Difference Between Free and Premium",
      category: "product",
      keywords: ["free vs premium", "premium features", "why premium"],
      match_phrases: ["premium vs free", "free vs premium", "what does premium have"],
      reply: "Premium includes Orbit Aura."
    },
    {
      title: "Lost a Fight While Using Premium",
      category: "config",
      keywords: ["premium lost fight", "bad config", "premium weak"],
      match_phrases: ["premium bad", "premium lost fight", "premium not hitting"],
      reply: "This is almost always a config issue."
    },
    {
      title: "Banned / Detected",
      category: "ban",
      keywords: ["banned", "detected", "anticheat ban", "mod ban", "got banned"],
      match_phrases: ["got banned", "is kicia detected", "will i get banned"],
      reply: "KiciaHook is tested to remain undetected."
    },
    {
      title: "Account Transfers / Discord Server Ban",
      category: "support_only",
      keywords: ["account transfer", "discord ban", "banned from discord", "server ban"],
      match_phrases: ["account transfer", "discord ban", "banned from discord"],
      reply: "This needs staff."
    },
    {
      title: "Features Not Visible on Your Screen",
      category: "visual",
      keywords: ["feature not visible", "orbit aura not showing", "feature invisible", "aura invisible"],
      match_phrases: ["feature not visible", "orbit aura not showing", "feature invisible"],
      reply: "Some features are client-side only."
    },
    {
      title: "Where to Buy / Pricing / Robux Payment",
      category: "purchase",
      keywords: ["where to buy", "price", "pricing", "robux", "rbx", "payment", "buy premium"],
      match_phrases: ["where to buy", "how to buy", "can i pay with robux", "robux payment", "can i buy with"],
      reply: "Check the resellers channel."
    },
    {
      title: "GUI Layout Guide",
      category: "gui",
      keywords: ["where is", "gui layout", "which tab", "where to find"],
      match_phrases: ["where is", "where is esp", "where is fly", "where is walkspeed"],
      reply: [
        "Combat: Legitbot, Silent Aim, Triggerbot, Rage (Contains Orbit Aura & Anti Aim)",
        "Visuals: ESP, Overrides, World, Players",
        "Misc: Movement, Fly, Walkspeed, Slideboost, Auto Queue, Device Spoofer, Hitsounds, Weapons (Unlock All, No Spread, Anti Katata), Auto Loadout"
      ].join("\n")
    },
    {
      title: "Anti Katata Not Working",
      category: "feature",
      keywords: ["anti katata", "katata not working", "anti katata broken", "katana"],
      match_phrases: ["anti katata", "anti katata broken"],
      reply: "Anti Katata is ping-dependent."
    },
    {
      title: "Magic Bullet Patched",
      category: "feature",
      keywords: ["magic bullet", "magic bullet not working", "magic bullet gone"],
      match_phrases: ["magic bullet", "magic bullet gone", "magic bullet broken"],
      reply: "Magic Bullet has been patched."
    },
    {
      title: "KiciaHook Website / Official Site",
      category: "purchase",
      keywords: ["kiciahook site", "kicia website", "official site", "website"],
      match_phrases: ["kiciahook website", "kicia website", "official site", "do you have a website"],
      reply: "KiciaHook does not currently have an official website."
    },
    {
      title: "Silent Aim, Rage, and Projectile TP Not Working",
      category: "feature",
      keywords: ["silent aim", "rage", "projectile tp", "patched", "not working", "broken"],
      match_phrases: ["silent aim not working", "rage not working", "projectile tp broken", "rage broken"],
      reply: "Rivals anticheat patched some projectile TP functions."
    },
    {
      title: "How to Get a Key and Get Whitelisted (Free and Premium)",
      category: "key",
      keywords: ["how to get key", "lootlabs", "adslift", "key system", "key ads"],
      match_phrases: ["how to get key", "lootlabs key", "adslift key", "how to complete key system"],
      reply: "Use Lootlabs or Adslift to generate a free key."
    },
    {
      title: "How to Reset Settings / Keybinds",
      category: "config",
      keywords: ["reset settings", "reset keybinds", "default settings", "keybinds wrong"],
      match_phrases: ["reset my settings", "reset my keybinds", "how do i go back to default"],
      reply: "Delete or rename the config that is currently being loaded."
    }
  ]
});

function assertIssue(prompt, title) {
  const match = tryIssueMatch(prompt, kb);
  assert.equal(match?.title || null, title, prompt);
}

test("live KB style matching handles shorthand and conflict-heavy docs prompts", () => {
  assertIssue("where do i put my json", "How to Load a Config");
  assertIssue("my cfg wont load", "How to Load a Config");
  assertIssue("it says no hardware id", "No HWID Found Error");
  assertIssue("new pc key not work", "How to Reset HWID");
  assertIssue("what is premium", "Difference Between Free and Premium");
  assertIssue("why am i losing with premium", "Lost a Fight While Using Premium");
  assertIssue("is this detected", "Banned / Detected");
  assertIssue("i got discord banned", "Account Transfers / Discord Server Ban");
  assertIssue("orbit aura invisible", "Features Not Visible on Your Screen");
  assertIssue("can i buy ts with roblox", "Where to Buy / Pricing / Robux Payment");
  assertIssue("where site", "KiciaHook Website / Official Site");
  assertIssue("where auto queue", "GUI Layout Guide");
  assertIssue("anti katana broken", "Anti Katata Not Working");
  assertIssue("rage patched", "Silent Aim, Rage, and Projectile TP Not Working");
  assertIssue("mb gone", "Magic Bullet Patched");
  assertIssue("adslift stuck", "How to Get a Key and Get Whitelisted (Free and Premium)");
  assertIssue("reset my binds", "How to Reset Settings / Keybinds");
});

test("live KB style matching keeps vague prompts from hijacking docs", () => {
  assertIssue("random nonsense", null);
  assertIssue("premium", null);
  assertIssue("where is", null);
});
