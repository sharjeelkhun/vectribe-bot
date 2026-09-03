// commands/tasks.js — /tasks add <text> | list | done <id>
import { SlashCommandBuilder } from 'discord.js';
import { addTask, listTasks, completeTask } from '../lib/notes.js';
import { baseEmbed, INFO_COLOR, okEmbed, errorEmbed } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('tasks')
  .setDescription('Your personal task checklist')
  .addSubcommand((s) => s.setName('add').setDescription('Add a task').addStringOption((o) => o.setName('text').setDescription('Task description').setRequired(true).setMaxLength(500)))
  .addSubcommand((s) => s.setName('list').setDescription('Show your tasks'))
  .addSubcommand((s) => s.setName('done').setDescription('Mark a task complete').addIntegerOption((o) => o.setName('id').setDescription('Task ID').setRequired(true)));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (sub === 'add') {
    const t = addTask(userId, interaction.options.getString('text'));
    return interaction.reply({ embeds: [okEmbed('✅ Task added!', `**#${t.id}** — ${t.text}\n\nView all with /tasks list`)], ephemeral: true });
  }

  if (sub === 'list') {
    const list = listTasks(userId);
    return interaction.reply({
      embeds: [
        baseEmbed(INFO_COLOR)
          .setTitle('✅ Your tasks')
          .setDescription(
            list.length
              ? list.map((t) => `${t.done ? '☑️' : '⬜'} **#${t.id}** — ${t.text}${t.done ? ' _(done)_' : ''}`).join('\n')
              : 'No tasks yet. Add one with /tasks add'
          ),
      ],
      ephemeral: true,
    });
  }

  if (sub === 'done') {
    const id = interaction.options.getInteger('id');
    const ok2 = completeTask(userId, id);
    return interaction.reply({
      embeds: [ok2 ? okEmbed('🎉 Task completed!', `**#${id}** done. Nice!`) : errorEmbed(`No open task **#${id}** — check /tasks list.`)],
      ephemeral: true,
    });
  }
}
