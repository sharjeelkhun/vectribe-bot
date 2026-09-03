// commands/translate.js — /translate text → translated version
import { SlashCommandBuilder } from 'discord.js';
import { translate } from '../lib/zai.js';
import { baseEmbed, INFO_COLOR, errorEmbed } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('translate')
  .setDescription('Translate text into another language')
  .addStringOption((o) =>
    o.setName('text').setDescription('Text to translate').setRequired(true).setMaxLength(2000)
  )
  .addStringOption((o) =>
    o
      .setName('target')
      .setDescription('Target language (default: English)')
      .addChoices(
        { name: 'English', value: 'English' },
        { name: 'Urdu', value: 'Urdu' },
        { name: 'Arabic', value: 'Arabic' },
        { name: 'Chinese', value: 'Chinese' },
        { name: 'Spanish', value: 'Spanish' },
        { name: 'French', value: 'French' },
        { name: 'German', value: 'German' },
        { name: 'Hindi', value: 'Hindi' }
      )
  );

export async function execute(interaction) {
  const text = interaction.options.getString('text');
  const target = interaction.options.getString('target') || 'English';

  await interaction.deferReply();

  try {
    const result = await translate(text, target);

    const embed = baseEmbed(INFO_COLOR)
      .setAuthor({ name: `Translation — requested by ${interaction.user.username}` })
      .setTitle('🌐 Translation')
      .addFields(
        { name: 'Original', value: text.slice(0, 1000) || '—' },
        { name: `→ ${target}`, value: result.slice(0, 1000) }
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[translate]', err);
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}
