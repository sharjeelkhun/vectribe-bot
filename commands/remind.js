// commands/remind.js — /remind when:<natural time> what:<text>
import { SlashCommandBuilder } from 'discord.js';
import { parseWhen, fmtWhen, addReminder } from '../lib/reminders.js';
import { okEmbed, errorEmbed } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('remind')
  .setDescription('Set a reminder — I will ping you when it is time')
  .addStringOption((o) =>
    o.setName('when').setDescription('e.g. "in 20 minutes", "tomorrow 9am", "at 5:30pm"').setRequired(true).setMaxLength(100)
  )
  .addStringOption((o) => o.setName('what').setDescription('What should I remind you about?').setRequired(true).setMaxLength(500));

export async function execute(interaction) {
  const whenText = interaction.options.getString('when');
  const what = interaction.options.getString('what');

  await interaction.deferReply({ ephemeral: true });

  const dueTs = await parseWhen(whenText);
  if (!dueTs) {
    return interaction.editReply({
      embeds: [errorEmbed(`I couldn't turn **"${whenText}"** into a time. Try *"in 20 minutes"*, *"tomorrow 9am"*, or *"at 5:30pm"*.`)],
    });
  }

  const r = addReminder({
    userId: interaction.user.id,
    username: interaction.user.username,
    channelId: interaction.channelId,
    guildName: interaction.guild?.name,
    text: what,
    dueTs,
  });

  await interaction.editReply({
    embeds: [okEmbed('⏰ Reminder set!', `**#${r.id}** — ${what}\n🗓️ Due: **${fmtWhen(dueTs)}**\n\nI'll ping you in this channel.`)],
  });
}
