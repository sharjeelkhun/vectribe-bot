// commands/summarize.js — /summarize url → read page + AI summary
import { SlashCommandBuilder } from 'discord.js';
import { readPage, chat } from '../lib/zai.js';
import { baseEmbed, INFO_COLOR, errorEmbed, checkCooldown } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('summarize')
  .setDescription('Summarize any web page or article link')
  .addStringOption((o) => o.setName('url').setDescription('The link to summarize').setRequired(true).setMaxLength(500))
  .addStringOption((o) =>
    o
      .setName('style')
      .setDescription('Summary style')
      .addChoices(
        { name: 'Short paragraph', value: 'paragraph' },
        { name: 'Key bullet points', value: 'bullets' },
        { name: 'Explain like I am 5', value: 'eli5' }
      )
  );

const STYLE_PROMPTS = {
  paragraph: 'Write a clear summary paragraph (max 130 words).',
  bullets: 'Write 4-6 key bullet points (one line each).',
  eli5: 'Explain the page in very simple words anyone can understand (max 120 words).',
};

export async function execute(interaction) {
  const url = interaction.options.getString('url');
  const style = interaction.options.getString('style') || 'paragraph';

  const cd = checkCooldown(interaction.user.id, 5000);
  if (cd) {
    return interaction.reply({
      embeds: [errorEmbed(`Slow down a moment — try again in **${Math.ceil(cd / 1000)}s**.`)],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    const page = await readPage(url);
    const summary = await chat([
      {
        role: 'user',
        content: `Summarize the following web page.\nTitle: ${page.title}\n\nContent:\n${page.text}\n\n${STYLE_PROMPTS[style]}`,
      },
    ]);

    const embed = baseEmbed(INFO_COLOR)
      .setAuthor({ name: `Page summary — requested by ${interaction.user.username}` })
      .setTitle(`📄 ${page.title.slice(0, 250)}`)
      .setURL(page.url)
      .setDescription(summary.slice(0, 4000))
      .addFields({ name: '🔗 Link', value: page.url.slice(0, 1000) });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[summarize]', err);
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}
