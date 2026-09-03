// commands/tts.js — /tts text → voice note audio attachment
import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { tts, TTS_VOICES } from '../lib/zai.js';
import { baseEmbed, OK_COLOR, errorEmbed } from '../lib/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('tts')
  .setDescription('Convert text into a spoken voice note (audio file)')
  .addStringOption((o) =>
    o.setName('text').setDescription('Text to speak (max 1024 characters)').setRequired(true).setMaxLength(1024)
  )
  .addStringOption((o) =>
    o
      .setName('voice')
      .setDescription('Voice to use')
      .addChoices(
        { name: 'Tongtong — warm & friendly', value: 'tongtong' },
        { name: 'Chuichui — lively & cute', value: 'chuichui' },
        { name: 'Xiaochen — calm & professional', value: 'xiaochen' },
        { name: 'Jam — British gentleman', value: 'jam' },
        { name: 'Kazi — clear & standard', value: 'kazi' },
        { name: 'Douji — natural & fluent', value: 'douji' },
        { name: 'Luodo — expressive', value: 'luodo' }
      )
  )
  .addNumberOption((o) =>
    o.setName('speed').setDescription('Speech speed 0.5 (slow) to 2.0 (fast)').setMinValue(0.5).setMaxValue(2.0)
  );

export async function execute(interaction) {
  const text = interaction.options.getString('text');
  const voice = interaction.options.getString('voice') || 'tongtong';
  const speed = interaction.options.getNumber('speed') || 1.0;

  await interaction.deferReply();

  try {
    const buffer = await tts(text, voice, speed);
    const file = new AttachmentBuilder(buffer, { name: `voice-${Date.now()}.wav` });

    const embed = baseEmbed(OK_COLOR)
      .setAuthor({ name: `Voice note — requested by ${interaction.user.username}` })
      .setTitle('🎙️ Text to Speech')
      .addFields(
        { name: 'Text', value: text.slice(0, 1000) },
        { name: 'Voice', value: voice, inline: true },
        { name: 'Speed', value: `${speed}x`, inline: true }
      );

    await interaction.editReply({ embeds: [embed], files: [file] });
  } catch (err) {
    console.error('[tts]', err);
    await interaction.editReply({ embeds: [errorEmbed(err.message)] });
  }
}
