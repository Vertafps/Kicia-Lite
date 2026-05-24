function messageFromInteraction(interaction, syntheticContent) {
  const guild = interaction.guild;
  const channel = interaction.channel;
  const member = interaction.member;
  const user = interaction.user;

  let replied = interaction.replied || interaction.deferred;

  async function safeReplyOrFollowUp(payload) {
    try {
      if (!replied) {
        replied = true;
        await interaction.reply({ ...payload, flags: payload.flags ?? (1 << 6) }); // ephemeral by default
        return await interaction.fetchReply().catch(() => null);
      } else {
        return await interaction.followUp({ ...payload, flags: payload.flags ?? (1 << 6) });
      }
    } catch (err) {
      return null;
    }
  }

  const msg = {
    id: interaction.id,
    content: String(syntheticContent || ""),
    author: user,
    member,
    guild,
    guildId: guild?.id,
    channel,
    channelId: channel?.id,
    mentions: { everyone: false, users: new Map(), roles: new Map() },

    async reply(payload) {
      const normalized = typeof payload === "string" ? { content: payload } : payload;
      return safeReplyOrFollowUp(normalized);
    },

    async edit(payload) {
      try { return await interaction.editReply(payload); }
      catch { return null; }
    },

    async react() { return null; },

    inGuild() { return Boolean(guild); },
    isFromGuild() { return Boolean(guild); },

    __isInteractionAdapter: true,
    __interaction: interaction
  };

  return msg;
}

module.exports = { messageFromInteraction };
