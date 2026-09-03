// commands/notes.js — /notes add <text> | list | delete <id>
import { SlashCommandBuilder } from 'discord.js';
import { addNote, listNotes, deleteNote } from '../lib/notes.js';
import { baseEmbed, INFO_COLOR, okEmbed, errorEmbed } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('notes')
  .setDescription('Your personal notes saved in the bot')
  .addSubcommand((s) => s.setName('add').setDescription('Save a note').addStringOption((o) => o.setName('text').setDescription('Note text').setRequired(true).setMaxLength(500)))
  .addSubcommand((s) => s.setName('list').setDescription('Show your notes'))
  .addSubcommand((s) => s.setName('delete').setDescription('Delete a note').addIntegerOption((o) => o.setName('id').setDescription('Note ID').setRequired(true)));

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  const userId = interaction.user.id;

  if (sub === 'add') {
    const n = addNote(userId, interaction.options.getString('text'));
    return interaction.reply({ embeds: [okEmbed('📝 Note saved!', `**#${n.id}** — ${n.text}\n\nAccess anytime with /notes list`)], ephemeral: true });
  }

  if (sub === 'list') {
    const list = listNotes(userId);
    return interaction.reply({
      embeds: [
        baseEmbed(INFO_COLOR)
          .setTitle('📝 Your notes')
          .setDescription(list.length ? list.map((n) => `**#${n.id}** — ${n.text}`).join('\n\n') : 'No notes yet. Save one with /notes add'),
      ],
      ephemeral: true,
    });
  }

  if (sub === 'delete') {
    const id = interaction.options.getInteger('id');
    const ok2 = deleteNote(userId, id);
    return interaction.reply({
      embeds: [ok2 ? okEmbed('🗑️ Note deleted', `Note **#${id}** removed.`) : errorEmbed(`No note **#${id}** found — check /notes list.`)],
      ephemeral: true,
    });
  }
}
