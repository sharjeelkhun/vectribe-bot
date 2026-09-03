// commands/zapier.js — /zapier → show connected Zapier MCP apps & actions
import { SlashCommandBuilder } from 'discord.js';
import { baseEmbed, INFO_COLOR, errorEmbed } from '../lib/embeds.js';
import { isMcpConfigured, zapierListTools } from '../lib/mcp.js';

export const data = new SlashCommandBuilder()
  .setName('zapier')
  .setDescription('Show the Zapier apps & actions connected to this bot');

export async function execute(interaction) {
  await interaction.deferReply();

  if (!isMcpConfigured()) {
    return interaction.editReply({
      embeds: [errorEmbed('Zapier MCP is not configured. Ask the bot owner to add ZAPIER_MCP_URL to the .env file.')],
    });
  }

  try {
    const tools = await zapierListTools();
    const usable = tools.filter((t) => !['get_dynamic_properties_schema', 'list_dynamic_enum_values', 'get_configuration_url'].includes(t.name));

    const groups = {};
    for (const t of usable) {
      const app = t.name.split('_')[0];
      (groups[app] ??= []).push(t);
    }

    const APP_LABELS = {
      apollo: '🎯 Apollo.io — leads & contacts',
      hubspot: '🧲 HubSpot — CRM (contacts, companies, deals)',
      gmail: '📧 Gmail — send / search / reply email',
      facebook: '📣 Facebook Pages — posts & media',
      google: '📊 Google Analytics — traffic reports',
    };

    const fields = Object.entries(groups)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)
      .map(([app, list]) => ({
        name: APP_LABELS[app] || `⚡ ${app}`,
        value: `${list.length} actions — e.g. \`${list.slice(0, 3).map((t) => t.name.replace(/^[a-z0-9]+_/, '')).join('`, `')}\``,
      }));

    const embed = baseEmbed(INFO_COLOR)
      .setTitle('⚡ Zapier MCP — connected!')
      .setDescription(
        `**${usable.length} actions** across ${Object.keys(groups).length} apps are wired into my brain.\n\n` +
          'Just tell me what to do in plain English — no slash commands needed:\n' +
          '　*"send an email to john@acme.com about the SEO proposal"*\n' +
          '　*"save this lead in Apollo: Sarah Khan, sarah@shopify.com"*\n' +
          '　*"create a HubSpot deal for the Vectribe redesign — £2,400"*\n' +
          '　*"post on our Facebook page: new case study is live!"*\n' +
          '　*"how many visitors did we get last week?"*\n\n' +
          'If I\'m missing a detail (like an email address), I\'ll ask before acting.'
      )
      .addFields(fields);

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[cmd:zapier]', err);
    await interaction.editReply({ embeds: [errorEmbed(`Zapier connection failed: ${err.message}`)] });
  }
}
