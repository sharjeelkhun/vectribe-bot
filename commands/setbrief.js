// commands/setbrief.js — admin: configure the daily news brief
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { saveConfig, getConfig } from '../lib/config.js';
import { okEmbed, errorEmbed, infoEmbed } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('setbrief')
  .setDescription('Admin: set the daily AI news brief channel and time')
  .addChannelOption((o) =>
    o.setName('channel').setDescription('Channel that receives the brief').addChannelTypes(ChannelType.GuildText)
  )
  .addIntegerOption((o) =>
    o.setName('hour').setDescription('Hour of day (0-23, server shows local time)').setMinValue(0).setMaxValue(23)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  const channel = interaction.options.getChannel('channel');
  const hour = interaction.options.getInteger('hour');

  if (!channel && hour === null) {
    const cfg = getConfig();
    const status = cfg.briefChannelId
      ? `📰 Daily brief is currently <#${cfg.briefChannelId}> at **${String(cfg.briefHour).padStart(2, '0')}:${String(cfg.briefMinute).padStart(2, '0')}** (${cfg.timezone}).`
      : '📰 Daily brief is currently **disabled**.';
    return interaction.reply({ embeds: [infoEmbed('Daily brief status', status)], ephemeral: true });
  }

  saveConfig({
    briefChannelId: channel ? channel.id : getConfig().briefChannelId,
    ...(hour !== null ? { briefHour: hour } : {}),
  });

  const cfg = getConfig();
  if (!cfg.briefChannelId) {
    return interaction.reply({ embeds: [errorEmbed('No channel configured — pick a channel first.')], ephemeral: true });
  }

  await interaction.reply({
    embeds: [
      okEmbed(
        'Daily brief saved',
        channel
          ? `📰 The AI news brief will be posted in ${channel} daily at **${String(cfg.briefHour).padStart(2, '0')}:${String(cfg.briefMinute).padStart(2, '0')}** (${cfg.timezone}).`
          : `⏰ Time updated to **${String(cfg.briefHour).padStart(2, '0')}:${String(cfg.briefMinute).padStart(2, '0')}** (${cfg.timezone}).`
      ),
    ],
    ephemeral: true,
  });
}
