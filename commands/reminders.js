// commands/reminders.js — /reminders list | /reminders cancel id:<n>
import { SlashCommandBuilder } from 'discord.js';
import { listReminders, cancelReminder, fmtWhen } from '../lib/reminders.js';
import { baseEmbed, INFO_COLOR, okEmbed, errorEmbed } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('reminders')
  .setDescription('Manage your reminders')
  .addSubcommand((s) => s.setName('list').setDescription('Show your active reminders'))
  .addSubcommand((s) =>
    s.setName('cancel').setDescription('Cancel a reminder').addIntegerOption((o) =>
      o.setName('id').setDescription('Reminder ID (from /reminders list)').setRequired(true)
    )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const list = listReminders(interaction.user.id);
    const embed = baseEmbed(INFO_COLOR)
      .setTitle('⏰ Your active reminders')
      .setDescription(
        list.length
          ? list.map((r) => `**#${r.id}** — ${r.text}\n　　🗓️ ${fmtWhen(r.dueTs)}`).join('\n\n')
          : 'No upcoming reminders. Create one with `/remind`!'
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'cancel') {
    const id = interaction.options.getInteger('id');
    const done = cancelReminder(interaction.user.id, id);
    return interaction.reply({
      embeds: [
        done
          ? okEmbed('🗑️ Reminder cancelled', `Reminder **#${id}** is gone.`)
          : errorEmbed(`I couldn't find an active reminder **#${id}** — check /reminders list.`),
      ],
      ephemeral: true,
    });
  }
}
