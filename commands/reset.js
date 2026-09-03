// commands/reset.js — /reset → clear the conversation memory for this chat
import { SlashCommandBuilder } from 'discord.js';
import { okEmbed, resetHistory, memoryKey } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('reset')
  .setDescription('Clear the AI conversation memory in this chat');

export async function execute(interaction) {
  resetHistory(memoryKey(interaction.channelId, interaction.user.id));
  await interaction.reply({ embeds: [okEmbed('Memory cleared', 'The AI has forgotten this conversation. Fresh start! 🧠✨')], ephemeral: true });
}
