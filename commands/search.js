// commands/search.js — /search query → real-time web results + AI summary
import { SlashCommandBuilder } from 'discord.js';
import { webSearch, searchToDigest, chat } from '../lib/zai.js';
import { baseEmbed, OK_COLOR, errorEmbed, checkCooldown } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('search')
  .setDescription('Search the web in real time and get an AI summary')
  .addStringOption((o) => o.setName('query').setDescription('What to search for').setRequired(true).setMaxLength(200))
  .addIntegerOption((o) =>
    o.setName('results').setDescription('How many links to show (1-10, default 5)').setMinValue(1).setMaxValue(10)
  );

export async function execute(interaction) {
  const query = interaction.options.getString('query');
  const num = interaction.options.getInteger('results') || 5;

  const cd = checkCooldown(interaction.user.id, 4000);
  if (cd) {
    return interaction.reply({
      embeds: [errorEmbed(`Slow down a moment — try again in **${Math.ceil(cd / 1000)}s**.`)],
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  try {
    const results = await webSearch(query, Math.max(num, 8));

    if (!results.length) {
      return interaction.editReply({ embeds: [errorEmbed(`No results found for **${query}**.`)] });
    }

    // AI summary of the top results (best effort — search still shows if it fails)
    let summary = null;
    try {
      summary = await chat([
        {
          role: 'user',
          content:
            `Search query: "${query}"\n\nSearch results:\n${searchToDigest(results)}\n\n` +
            'Based only on these results, write a short neutral summary (max 120 words) answering the query.',
        },
      ]);
    } catch (e) {
      console.error('[search] summary skipped:', e.message);
    }

    const embed = baseEmbed(OK_COLOR)
      .setAuthor({ name: `Web search — requested by ${interaction.user.username}` })
      .setTitle(`🔎 Results for "${query.slice(0, 200)}"`);

    if (summary) {
      embed.addFields({ name: '🤖 AI Summary', value: summary.slice(0, 1000) });
    }

    for (const r of results.slice(0, num)) {
      const name = `[${String(r.name || 'Untitled').slice(0, 120)}](${r.url})`;
      const snippet = String(r.snippet || '').slice(0, 180) || '—';
      embed.addFields({
        name: `${r.host_name || 'web'}${r.date ? ` · ${r.date}` : ''}`,
        value: `${name}\n${snippet}`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[search]', err);
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}
