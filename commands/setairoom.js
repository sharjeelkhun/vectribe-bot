// commands/setairoom.js — admin: set the channel where the bot replies to EVERY message
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { saveConfig } from '../lib/config.js';
import { okEmbed, errorEmbed } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('setairoom')
  .setDescription('Admin: set a channel where the bot replies to every message (leave empty to disable)')
  .addChannelOption((o) =>
    o.setName('channel').setDescription('The AI room channel').addChannelTypes(ChannelType.GuildText)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  const channel = interaction.options.getChannel('channel');
  saveConfig({ aiChannelId: channel ? channel.id : null });

  const embed = channel
    ? okEmbed('AI room enabled', `From now on I will reply to **every message** posted in ${channel}. 🤖`)
    : okEmbed('AI room disabled', 'I will only reply when mentioned or when you use my commands.');
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
