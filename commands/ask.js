// commands/ask.js — /ask question → AI chat answer
import { SlashCommandBuilder } from 'discord.js';
import { chatGrounded } from '../lib/zai.js';
import { baseEmbed, BRAND_COLOR, errorEmbed, chunkText, getHistory, pushHistory, memoryKey, checkCooldown } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('ask')
  .setDescription('Ask the Z.ai assistant anything')
  .addStringOption((o) =>
    o.setName('question').setDescription('Your question for the AI').setRequired(true).setMaxLength(1000)
  );

export async function execute(interaction) {
  const question = interaction.options.getString('question');
  const key = memoryKey(interaction.channelId, interaction.user.id);

  const cd = checkCooldown(interaction.user.id, 4000);
  if (cd) {
    return interaction.reply({
      embeds: [errorEmbed(`Slow down a moment — try again in **${Math.ceil(cd / 1000)}s**.`)],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    const { answer, searched, sources } = await chatGrounded(question, getHistory(key));
    pushHistory(key, question, answer);

    const embed = baseEmbed(BRAND_COLOR)
      .setAuthor({ name: `Z.ai Assistant — reply to ${interaction.user.username}` })
      .setTitle('💬 Answer')
      .setDescription(chunkText(answer)[0]);
    if (searched) {
      embed.addFields({
        name: '🔎 Answer grounded in live web search',
        value: sources.join('\n').slice(0, 1000) || 'yes',
      });
    }

    await interaction.editReply({ embeds: [embed] });
    const extraChunks = chunkText(answer).slice(1, 3);
    for (const c of extraChunks) {
      await interaction.followUp({ embeds: [baseEmbed(BRAND_COLOR).setDescription(c)] });
    }
  } catch (err) {
    console.error('[ask]', err);
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}
