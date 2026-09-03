// commands/help.js — /help → everything the bot can do
import { SlashCommandBuilder } from 'discord.js';
import { baseEmbed, BRAND_COLOR } from '../lib/embeds.js';

export const data = new SlashCommandBuilder().setName('help').setDescription('Show everything the Z.ai bot can do');

export async function execute(interaction) {
  const embed = baseEmbed(BRAND_COLOR)
    .setAuthor({ name: 'Z.ai Discord Assistant' })
    .setTitle('🤖 Your AI Automation Bot — Commands')
    .setDescription(
      '**AI Chat**\n' +
        '`/ask <question>` — ask me anything (I remember the conversation)\n' +
        '`@mention me` in any channel or DM me — I reply directly\n' +
        '🧠 **Agent mode:** just *tell me* what to do and I do it:\n' +
        '　*"remind me in 20 minutes to check the oven"*\n' +
        '　*"add task: finish the report" · "my tasks" · "my notes"*\n' +
        '　*"note: wifi password is 1234"*\n' +
        'Admins can set an **AI room** where I reply to every message\n\n' +
        '**⚡ Zapier (Apollo · HubSpot · Gmail · Facebook · GA4)**\n' +
        '`/zapier` — show connected apps & actions\n' +
        'Just say it and I do it: *"email john@acme.com the proposal"*,\n' +
        '*"save lead Sarah Khan sarah@shopify.com in Apollo"*\n\n' +
        '**Automations**\n' +
        '`/search <query>` — real-time web search + AI summary\n' +
        '`/image <prompt>` — generate an AI image\n' +
        '`/summarize <url>` — summarize any web page link\n' +
        '`/tts <text>` — turn text into a voice note 🔊\n' +
        '`/translate <text>` — translate text (react 🤖 on any message for English)\n\n' +
        '**⏰ Reminders & ✅ Tasks & 📝 Notes**\n' +
        '`/remind when:<time> what:<text>` — scheduled ping\n' +
        '`/reminders list` / `cancel` — manage reminders\n' +
        '`/tasks add` / `list` / `done` — your checklist\n' +
        '`/notes add` / `list` / `delete` — your saved notes\n\n' +
        '**Utility**\n' +
        '`/reset` — clear conversation memory\n' +
        '`/setairoom` — admin: set the auto-reply channel\n' +
        '`/setbrief` — admin: schedule the daily news brief'
    )
    .addFields({
      name: '💡 Tips',
      value:
        '• React with 🤖 on any message and I will translate it to English\n' +
        '• I remember the last few messages in each conversation\n' +
        '• "Find real..." style requests are grounded in live web search with sources\n' +
        '• All answers are powered by Z.ai',
    });

  await interaction.reply({ embeds: [embed] });
}
