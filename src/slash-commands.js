const {
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");
const { messageFromInteraction } = require("./utils/reply-target");
const { recordRuntimeEvent } = require("./runtime-health");

// visibility hint only; the handler still re-checks server-side
const OWNER_PERMS = String(PermissionFlagsBits.Administrator);
const STAFF_PERMS = String(PermissionFlagsBits.ManageMessages);

function buildDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Show or set the KiciaHook runtime status")
      .addSubcommand(s => s.setName("show").setDescription("Show current status"))
      .addSubcommand(s => s.setName("set")
        .setDescription("Set runtime status (owner)")
        .addStringOption(o => o.setName("state").setDescription("up | down | unaware").setRequired(true)
          .addChoices({ name: "up", value: "up" }, { name: "down", value: "down" }, { name: "unaware", value: "unaware" })))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("state")
      .setDescription("Bot presence text (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .addSubcommand(s => s.setName("show").setDescription("Show current presence"))
      .addSubcommand(s => s.setName("set")
        .setDescription("Set presence text")
        .addStringOption(o => o.setName("message").setDescription("New presence").setRequired(true)))
      .addSubcommand(s => s.setName("reset").setDescription("Reset to default"))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("fetch")
      .setDescription("Refresh KB cache (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("jarvis")
      .setDescription("Run diagnostics (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("testpromax")
      .setDescription("Extended diagnostics (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("role")
      .setDescription("Role assignment (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .addSubcommand(s => s.setName("assign")
        .setDescription("Assign role to one member")
        .addUserOption(o => o.setName("user").setDescription("Target user").setRequired(true))
        .addRoleOption(o => o.setName("role").setDescription("Role to grant").setRequired(true)))
      .addSubcommand(s => s.setName("assign-all")
        .setDescription("Assign role to ALL human members missing it")
        .addRoleOption(o => o.setName("role").setDescription("Role to grant").setRequired(true)))
      .addSubcommand(s => s.setName("status").setDescription("Current bulk job state"))
      .addSubcommand(s => s.setName("cancel").setDescription("Request bulk job stop"))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("db")
      .setDescription("Inspect SQLite (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("set-channels")
      .setDescription("Show configured channels (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("set-channel")
      .setDescription("Configure a channel slot (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .addStringOption(o => o.setName("slot").setDescription("Channel slot").setRequired(true).setAutocomplete(true))
      .addChannelOption(o => o.setName("channel").setDescription("Target channel").setRequired(true))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("whitelist")
      .setDescription("Moderation whitelist (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .addSubcommand(s => s.setName("add")
        .setDescription("Add user to whitelist")
        .addUserOption(o => o.setName("user").setDescription("User to whitelist").setRequired(true)))
      .addSubcommand(s => s.setName("remove")
        .setDescription("Remove user from whitelist")
        .addUserOption(o => o.setName("user").setDescription("User to remove").setRequired(true)))
      .addSubcommand(s => s.setName("list").setDescription("List whitelisted users"))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("lock")
      .setDescription("Lock configured channels (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .toJSON(),
    new SlashCommandBuilder()
      .setName("unlock")
      .setDescription("Unlock configured channels (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .toJSON(),

    new SlashCommandBuilder()
      .setName("allowlink")
      .setDescription("Trusted-link management (staff+)")
      .setDefaultMemberPermissions(STAFF_PERMS)
      .addSubcommand(s => s.setName("add")
        .setDescription("Add a trusted URL")
        .addStringOption(o => o.setName("url").setDescription("URL").setRequired(true)))
      .addSubcommand(s => s.setName("remove")
        .setDescription("Remove a trusted URL")
        .addStringOption(o => o.setName("url").setDescription("URL").setRequired(true)))
      .addSubcommand(s => s.setName("list").setDescription("List trusted URLs"))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("emoji")
      .setDescription("Restricted reactions (staff+)")
      .setDefaultMemberPermissions(STAFF_PERMS)
      .addSubcommand(s => s.setName("add")
        .setDescription("Restrict an emoji")
        .addStringOption(o => o.setName("emoji").setDescription("Emoji").setRequired(true)))
      .addSubcommand(s => s.setName("remove")
        .setDescription("Unrestrict an emoji")
        .addStringOption(o => o.setName("emoji").setDescription("Emoji").setRequired(true)))
      .addSubcommand(s => s.setName("list").setDescription("List restricted emojis"))
      .addSubcommand(s => s.setName("top")
        .setDescription("Top offenders/emojis (7d)")
        .addIntegerOption(o => o.setName("count").setDescription("How many").setMinValue(1).setMaxValue(20)))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("nick")
      .setDescription("Nickname rules (staff+)")
      .setDefaultMemberPermissions(STAFF_PERMS)
      .addSubcommand(s => s.setName("add")
        .setDescription("Add a nickname rule")
        .addStringOption(o => o.setName("pattern").setDescription("Word or /regex/i").setRequired(true))
        .addStringOption(o => o.setName("rename").setDescription("Replacement name (optional)")))
      .addSubcommand(s => s.setName("remove")
        .setDescription("Remove a rule by id")
        .addIntegerOption(o => o.setName("id").setDescription("Rule ID").setRequired(true)))
      .addSubcommand(s => s.setName("list").setDescription("List nickname rules"))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("policy")
      .setDescription("Toggle scam/link policy (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .addStringOption(o => o.setName("state").setDescription("on | off | status").setRequired(true)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }, { name: "status", value: "status" }))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("config")
      .setDescription("Owner-tunable settings")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .addSubcommand(s => s.setName("list")
        .setDescription("List settings")
        .addStringOption(o => o.setName("section").setDescription("Filter by section").setAutocomplete(true))
        .addIntegerOption(o => o.setName("page").setDescription("Page (1-based)").setMinValue(1)))
      .addSubcommand(s => s.setName("get")
        .setDescription("Show one setting")
        .addStringOption(o => o.setName("key").setDescription("Setting key").setRequired(true).setAutocomplete(true)))
      .addSubcommand(s => s.setName("set")
        .setDescription("Update a setting")
        .addStringOption(o => o.setName("key").setDescription("Setting key").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("value").setDescription("New value").setRequired(true)))
      .addSubcommand(s => s.setName("reset")
        .setDescription("Reset a setting to default")
        .addStringOption(o => o.setName("key").setDescription("Setting key").setRequired(true).setAutocomplete(true)))
      .addSubcommand(s => s.setName("diff").setDescription("Show non-default settings"))
      .addSubcommand(s => s.setName("export").setDescription("Export current overrides"))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("train")
      .setDescription("Retrain classifiers (owner)")
      .setDefaultMemberPermissions(OWNER_PERMS)
      .addSubcommand(s => s.setName("scam").setDescription("Retrain scam head"))
      .addSubcommand(s => s.setName("respect").setDescription("Retrain respect head"))
      .addSubcommand(s => s.setName("review")
        .setDescription("Review unlabeled samples")
        .addStringOption(o => o.setName("classifier").setDescription("Which classifier")
          .addChoices({ name: "scam", value: "scam" }, { name: "respect", value: "respect" })))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("training")
      .setDescription("Training corpus management")
      .setDefaultMemberPermissions(STAFF_PERMS)
      .addSubcommand(s => s.setName("stats").setDescription("Show sample counts"))
      .addSubcommand(s => s.setName("purge")
        .setDescription("Wipe samples from a user (owner only)")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)))
      .toJSON(),

    new SlashCommandBuilder()
      .setName("upload")
      .setDescription("Submit content")
      .addSubcommand(s => s.setName("config")
        .setDescription("Submit a config for the configs channel")
        .addStringOption(o => o.setName("name").setDescription("Config name").setRequired(true))
        .addStringOption(o => o.setName("type").setDescription("Config type").setRequired(true)
          .addChoices(
            { name: "rage", value: "rage" },
            { name: "semi-rage", value: "semi-rage" },
            { name: "legit", value: "legit" },
            { name: "semi-legit", value: "semi-legit" }
          ))
        .addAttachmentOption(o => o.setName("file").setDescription("The config file").setRequired(true))
        .addAttachmentOption(o => o.setName("video").setDescription("Showcase video (mp4/mov/webm/etc) — required").setRequired(true))
        .addStringOption(o => o.setName("comments").setDescription("Optional notes/recommendations").setRequired(false)))
      .toJSON()
  ];
}

function synthesizeMessageContent(interaction) {
  const name = interaction.commandName;
  const sub = interaction.options.getSubcommand(false);

  switch (name) {
    case "status":
      if (sub === "show") return "$status";
      if (sub === "set") return `$status ${interaction.options.getString("state")}`;
      return "$status";
    case "state":
      if (sub === "show") return "$state";
      if (sub === "set") return `$state ${interaction.options.getString("message")}`;
      if (sub === "reset") return "$state reset";
      return "$state";
    case "fetch": return "$fetch";
    case "jarvis": return "$jarvis";
    case "testpromax": return "$testpromax";
    case "db": return "$db";
    case "set-channels": return "$set channels";
    case "set-channel": {
      const slot = interaction.options.getString("slot");
      const ch = interaction.options.getChannel("channel");
      return `$set channel ${slot} <#${ch.id}>`;
    }
    case "role": {
      if (sub === "assign") {
        const u = interaction.options.getUser("user");
        const r = interaction.options.getRole("role");
        return `$role <@${u.id}> ${r.id}`;
      }
      if (sub === "assign-all") {
        const r = interaction.options.getRole("role");
        return `$role all ${r.id}`;
      }
      if (sub === "status") return "$role status";
      if (sub === "cancel") return "$role cancel";
      return "$role";
    }
    case "whitelist": {
      if (sub === "add") return `$whitelist <@${interaction.options.getUser("user").id}>`;
      if (sub === "remove") return `$whitelist remove <@${interaction.options.getUser("user").id}>`;
      if (sub === "list") return "$whitelist";
      return "$whitelist";
    }
    case "lock": return "$lock";
    case "unlock": return "$unlock";
    case "allowlink": {
      if (sub === "add") return `$allowlink ${interaction.options.getString("url")}`;
      if (sub === "remove") return `$removelink ${interaction.options.getString("url")}`;
      if (sub === "list") return "$allowlink";
      return "$allowlink";
    }
    case "emoji": {
      if (sub === "add") return `$emoji ${interaction.options.getString("emoji")}`;
      if (sub === "remove") return `$emoji remove ${interaction.options.getString("emoji")}`;
      if (sub === "list") return "$emoji";
      if (sub === "top") {
        const c = interaction.options.getInteger("count");
        return c ? `$emoji top ${c}` : "$emoji top";
      }
      return "$emoji";
    }
    case "nick": {
      if (sub === "add") {
        const p = interaction.options.getString("pattern");
        const r = interaction.options.getString("rename");
        return r ? `$nick add ${p} -> ${r}` : `$nick add ${p}`;
      }
      if (sub === "remove") return `$nick remove ${interaction.options.getInteger("id")}`;
      if (sub === "list") return "$nick";
      return "$nick";
    }
    case "policy": return `$policy ${interaction.options.getString("state")}`;
    case "config": {
      if (sub === "list") {
        const sec = interaction.options.getString("section");
        const page = interaction.options.getInteger("page");
        return `$config list${sec ? " " + sec : ""}${page ? " " + page : ""}`;
      }
      if (sub === "get") return `$config get ${interaction.options.getString("key")}`;
      if (sub === "set") return `$config set ${interaction.options.getString("key")} ${interaction.options.getString("value")}`;
      if (sub === "reset") return `$config reset ${interaction.options.getString("key")}`;
      if (sub === "diff") return "$config diff";
      if (sub === "export") return "$config export";
      return "$config";
    }
    case "train": {
      if (sub === "scam") return "$train scam";
      if (sub === "respect") return "$train respect";
      if (sub === "review") {
        const c = interaction.options.getString("classifier") || "scam";
        return `$train review ${c}`;
      }
      return "$train";
    }
    case "training": {
      if (sub === "stats") return "$training stats";
      if (sub === "purge") return `$training purge <@${interaction.options.getUser("user").id}>`;
      return "$training";
    }
    default: return null;
  }
}

async function handleSlashCommand(interaction) {
  const content = synthesizeMessageContent(interaction);
  if (!content) {
    await interaction.reply({ content: "command not wired", flags: 1 << 6 }).catch(() => {});
    return true;
  }

  if (!interaction.replied && !interaction.deferred) {
    try { await interaction.deferReply({ flags: 1 << 6 }); } catch {}
  }

  const msg = messageFromInteraction(interaction, content);

  try {
    const { maybeHandleControlCommand } = require("./handlers/commands");
    const handled = await maybeHandleControlCommand(msg);
    if (!handled) {
      const { maybeHandleLockCommand } = require("./handlers/lockdown");
      if (await maybeHandleLockCommand(msg)) return true;
      const { maybeHandleStatusCommand } = require("./handlers/status");
      if (await maybeHandleStatusCommand(msg)) return true;
      const { maybeHandleRoleCommand } = require("./handlers/role-assignment");
      if (await maybeHandleRoleCommand(msg)) return true;
      await msg.reply({ content: "command not routed — bug logged" });
    }
  } catch (err) {
    recordRuntimeEvent("error", "slash-command", `${interaction.commandName}: ${err?.message || err}`);
    try { await msg.reply({ content: "something went wrong" }); } catch {}
  }
  return true;
}

async function handleAutocomplete(interaction) {
  try {
    const name = interaction.commandName;
    const focused = interaction.options.getFocused(true);
    const settings = require("./settings");

    if (name === "config") {
      if (focused.name === "key") {
        const allKeys = [...settings.getRegistry().keys()];
        const filtered = allKeys
          .filter(k => k.toLowerCase().includes(focused.value.toLowerCase()))
          .slice(0, 25)
          .map(k => ({ name: k, value: k }));
        await interaction.respond(filtered).catch(() => {});
        return true;
      }
      if (focused.name === "section") {
        const sections = settings.listSections()
          .filter(s => s.toLowerCase().includes(focused.value.toLowerCase()))
          .slice(0, 25)
          .map(s => ({ name: s, value: s }));
        await interaction.respond(sections).catch(() => {});
        return true;
      }
    }
    if (name === "set-channel" && focused.name === "slot") {
      const { CHANNEL_CONFIG_SLOTS } = require("./channel-config");
      const slots = CHANNEL_CONFIG_SLOTS
        .map(s => s.key)
        .filter(k => k.toLowerCase().includes(focused.value.toLowerCase()))
        .slice(0, 25)
        .map(k => ({ name: k, value: k }));
      await interaction.respond(slots).catch(() => {});
      return true;
    }
    await interaction.respond([]).catch(() => {});
    return true;
  } catch (err) {
    recordRuntimeEvent("warn", "slash-autocomplete", err?.message || err);
    return true;
  }
}

async function maybeHandleSlashCommandInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand?.()) {
      if (interaction.commandName === "upload") {
        const { handleUploadConfigInteraction } = require("./handlers/config-upload");
        return await handleUploadConfigInteraction(interaction);
      }
      return await handleSlashCommand(interaction);
    }
    if (interaction.isAutocomplete?.()) {
      return await handleAutocomplete(interaction);
    }
  } catch (err) {
    recordRuntimeEvent("error", "slash-handler", err?.message || err);
  }
  return false;
}

async function registerSlashCommands(client) {
  try {
    if (!client?.application) {
      recordRuntimeEvent("warn", "slash-register", "client.application not ready");
      return;
    }
    const definitions = buildDefinitions();
    // register per-guild for instant propagation (global takes ~1h)
    for (const [, guild] of client.guilds.cache) {
      try {
        await guild.commands.set(definitions);
        recordRuntimeEvent("info", "slash-register", `set ${definitions.length} commands on ${guild.name}`);
      } catch (err) {
        recordRuntimeEvent("warn", "slash-register-guild", `${guild.name}: ${err?.message || err}`);
      }
    }
  } catch (err) {
    recordRuntimeEvent("error", "slash-register", err?.message || err);
  }
}

function getSlashCommandDefinitions() {
  return buildDefinitions();
}

function __resetForTests() {}

module.exports = {
  registerSlashCommands,
  maybeHandleSlashCommandInteraction,
  getSlashCommandDefinitions,
  __resetForTests
};
