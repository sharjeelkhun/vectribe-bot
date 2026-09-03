// commands/image.js — /image prompt → AI-generated picture
import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { generateImage, IMAGE_SIZES } from '../lib/zai.js';
import { baseEmbed, BRAND_COLOR, errorEmbed, checkCooldown } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('image')
  .setDescription('Generate an AI image from a text description')
  .addStringOption((o) =>
    o.setName('prompt').setDescription('Describe the image you want').setRequired(true).setMaxLength(500)
  )
  .addStringOption((o) =>
    o
      .setName('size')
      .setDescription('Image size')
      .addChoices(
        { name: 'Square (1024x1024)', value: '1024x1024' },
        { name: 'Landscape (1344x768)', value: '1344x768' },
        { name: 'Portrait (768x1344)', value: '768x1344' },
        { name: 'Wide banner (1440x720)', value: '1440x720' }
      )
  );

export async function execute(interaction) {
  const prompt = interaction.options.getString('prompt');
  const size = interaction.options.getString('size') || '1024x1024';

  const cd = checkCooldown(interaction.user.id, 8000);
  if (cd) {
    return interaction.reply({
      embeds: [errorEmbed(`Image generation is busy — try again in **${Math.ceil(cd / 1000)}s**.`)],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    const buffer = await generateImage(prompt, size);
    const file = new AttachmentBuilder(buffer, { name: `zai-image-${Date.now()}.jpg` });

    const embed = baseEmbed(BRAND_COLOR)
      .setAuthor({ name: `AI image — requested by ${interaction.user.username}` })
      .setTitle('🎨 Generated Image')
      .addFields(
        { name: 'Prompt', value: prompt.slice(0, 1000) },
        { name: 'Size', value: size, inline: true }
      )
      .setImage(`attachment://${file.name}`);

    await interaction.editReply({ embeds: [embed], files: [file] });
  } catch (err) {
    console.error('[image]', err);
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}
