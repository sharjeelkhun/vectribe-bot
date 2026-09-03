// index.js — Z.ai Discord Assistant (entry point)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Collection,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import cron from 'node-cron';

import { chat, chatGrounded, webSearch, searchToDigest, translate, friendlyError } from './lib/zai.js';
import { runAgent } from './lib/agent.js';
import { tick as reminderTick, recoverMissed } from './lib/reminders.js';
import { isGmailConfigured } from './lib/gmail.js';
import { isMcpConfigured, zapierListTools } from './lib/mcp.js';
import { getConfig, saveConfig } from './lib/config.js';
import {
  baseEmbed,
  BRAND_COLOR,
  OK_COLOR,
  INFO_COLOR,
  errorEmbed,
  chunkText,
  getHistory,
  pushHistory,
  resetHistory,
  memoryKey,
  checkCooldown,
} from './lib/embeds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Load slash commands                                                 */
/* ------------------------------------------------------------------ */

const commands = new Collection();
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const mod = await import(`./commands/${file}`);
  if (mod?.data && mod?.execute) commands.set(mod.data.name, mod);
}
console.log(`✓ Loaded ${commands.size} slash commands:`, [...commands.keys()].join(', '));

/* ------------------------------------------------------------------ */
/* Discord client                                                      */
/* ------------------------------------------------------------------ */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — must be enabled in the Developer Portal
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

/* ------------------------------------------------------------------ */
/* Shared AI chat handler (mention / AI room / DM)                     */
/* ------------------------------------------------------------------ */

async function aiChatReply(message, userText) {
  const cd = checkCooldown(message.author.id, 4000);
  if (cd) {
    await message.reply(`⏳ One moment please — try again in **${Math.ceil(cd / 1000)}s**.`);
    return;
  }

  await message.channel.sendTyping().catch(() => {});
  // Discord typing expires after ~10s — long AI backoffs (rate-limit retries)
  // would look like dead silence, so keep it alive until we reply.
  const typingTimer = setInterval(() => message.channel.sendTyping().catch(() => {}), 9000);
  const key = memoryKey(message.channelId, message.author.id);

  try {
    const text = (userText || message.content || '').trim();

    // 1) AGENT BRAIN — try to route the message to a tool (reminders, notes, tasks, email)
    //    history is passed so "our agency" / "that website" resolve from context
    const agentReply = await runAgent(text, {
      id: message.author.id,
      username: message.author.username,
      channelId: message.channelId,
      guildName: message.guild?.name,
      rawText: text,
      history: getHistory(key),
    });
    if (agentReply) {
      pushHistory(key, text, '[executed an action for the user]');
      return void (await message.reply({ embeds: [agentReply.embed] }));
    }

    // 2) NORMAL CHAT — grounded AI answer
    const { answer, searched, sources } = await chatGrounded(text, getHistory(key));
    pushHistory(key, text, answer);

    const chunks = chunkText(answer);
    const first = baseEmbed(BRAND_COLOR)
      .setAuthor({ name: `Z.ai Assistant — replying to ${message.author.username}`, iconURL: message.author.displayAvatarURL() })
      .setDescription(chunks[0]);
    if (searched) {
      first.addFields({
        name: '🔎 Answer grounded in live web search',
        value: sources.slice(0, 4).map((u) => u).join('\n').slice(0, 1000) || 'yes',
      });
    }
    await message.reply({ embeds: [first] });
    for (const c of chunks.slice(1, 3)) {
      await message.channel.send({ embeds: [baseEmbed(BRAND_COLOR).setDescription(c)] });
    }
  } catch (err) {
    console.error('[aiChat]', err);
    await message.reply({ embeds: [errorEmbed(friendlyError(err))] }).catch(() => {});
  } finally {
    clearInterval(typingTimer);
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot is online as ${c.user.tag} — serving ${c.guilds.cache.size} server(s)`);
  console.log(`📧 Gmail: ${isGmailConfigured() ? 'CONNECTED ✓' : 'not connected (add GMAIL_USER + GMAIL_APP_PASSWORD to enable)'}`);

  if (isMcpConfigured()) {
    zapierListTools()
      .then((t) => console.log(`⚡ Zapier MCP ready — ${t.filter((x) => !x.name.startsWith('get_') && !x.name.startsWith('list_')).length || t.length} actions available`))
      .catch((e) => console.log('⚡ Zapier MCP not available:', e.message));
  }

  if (recoverMissed()) console.log('⏰ expired reminders cleaned up');

  // Register slash commands per guild (instant availability)
  const json = [...commands.values()].map((cmd) => cmd.data.toJSON());
  for (const guild of c.guilds.cache.values()) {
    try {
      await guild.commands.set(json);
      console.log(`  ✓ commands registered in "${guild.name}"`);
    } catch (err) {
      console.error(`  ✗ failed to register commands in "${guild.name}":`, err.message);
    }
  }

  c.user.setPresence({
    activities: [{ name: 'Z.ai | /help', type: 3 }], // WATCHING
    status: 'online',
  });

  startDailyBrief();

  // reminder scheduler — check every 30 seconds
  setInterval(() => reminderTick(c).catch((e) => console.error('reminder tick:', e.message)), 30000);
});

// New server joined while running → register commands there too
client.on(Events.GuildCreate, async (guild) => {
  const json = [...commands.values()].map((cmd) => cmd.data.toJSON());
  try {
    await guild.commands.set(json);
    console.log(`✓ joined new server "${guild.name}" — commands registered`);
  } catch (err) {
    console.error('✗ command registration failed:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = commands.get(interaction.commandName);
  if (!cmd) return;
  try {
    await cmd.execute(interaction);
  } catch (err) {
    console.error(`[cmd:${interaction.commandName}]`, err);
    const payload = { embeds: [errorEmbed('Something broke while running that command. Please try again.')] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply({ ...payload, ephemeral: true }).catch(() => {});
  }
});

// Mentions, AI room, DMs
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return; // DMs handled below
  if (message.webhookId) return;

  const cfg = getConfig();
  const mentioned = message.mentions.has(client.user);
  const isAiRoom = cfg.aiChannelId && message.channelId === cfg.aiChannelId;

  if (mentioned || isAiRoom) {
    // strip the mention from the text
    let text = message.content.replace(/<@!?(\d+)>/g, '').trim();
    if (mentioned && !text) text = 'Hello! Introduce yourself briefly.';
    await aiChatReply(message, text);
  }
});

// DMs → AI chat
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || message.guild) return;
  await aiChatReply(message, message.content);
});

// 🤖 reaction → translate to English
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) reaction = await reaction.fetch();
    if (reaction.emoji.name !== '🤖') return;
    if (reaction.message.partial) await reaction.message.fetch();
    const target = reaction.message;
    const content = (target.content || '').trim();
    if (!content || content.length < 2) return;

    // avoid double-translating the same message
    const marker = `translate:${target.id}`;
    if (client._translated?.has(marker)) return;
    (client._translated ??= new Set()).add(marker);

    await target.channel.sendTyping().catch(() => {});
    const translated = await translate(content, 'English');
    const embed = baseEmbed(INFO_COLOR)
      .setAuthor({ name: `Translation for ${user.username} 🤖` })
      .addFields(
        { name: 'Original message', value: content.slice(0, 1000) },
        { name: '→ English', value: translated.slice(0, 1000) }
      );
    await target.reply({ embeds: [embed] });
  } catch (err) {
    console.error('[translator]', err);
  }
});

/* ------------------------------------------------------------------ */
/* Daily news brief (cron)                                             */
/* ------------------------------------------------------------------ */

function startDailyBrief() {
  const cfg = getConfig();
  const hour = String(cfg.briefHour).padStart(2, '0');
  const minute = String(cfg.briefMinute).padStart(2, '0');
  const expr = `${minute} ${hour} * * *`;
  console.log(`📅 Daily brief scheduled at ${hour}:${minute} (${cfg.timezone})`);

  cron.schedule(expr, async () => {
    const cfg2 = getConfig();
    if (!cfg2.briefChannelId) return;
    const channel = await client.channels.fetch(cfg2.briefChannelId).catch(() => null);
    if (!channel) return;

    console.log('📰 Generating daily brief…');
    try {
      const results = await webSearch('top news today world business technology', 10, 1);
      const digest = searchToDigest(results);
      const summary = await chat([
        {
          role: 'user',
          content:
            `Create a morning news brief in English from these search results (today is ${new Date().toDateString()}).\n\n` +
            `Format EXACTLY like this:\n` +
            `**🌅 Top Stories**\n• 3 bullets\n\n**💻 Tech & Business**\n• 3 bullets\n\n**🌍 World**\n• 2 bullets\n\n` +
            `Keep every bullet under 15 words. End with one short friendly sign-off line.\n\nResults:\n${digest}`,
        },
      ]);

      const embed = baseEmbed(OK_COLOR)
        .setTitle('📰 Your Daily Brief — powered by Z.ai')
        .setDescription(summary.slice(0, 4000));

      const sourceFields = results.slice(0, 5).map((r) => ({
        name: String(r.host_name || 'source').slice(0, 80),
        value: `[${String(r.name || 'link').slice(0, 90)}](${r.url})`,
      }));
      embed.addFields(sourceFields);

      await channel.send({ embeds: [embed] });
      console.log('✅ daily brief posted');
    } catch (err) {
      console.error('✗ daily brief failed:', err.message);
      channel.send({ embeds: [errorEmbed(`Daily brief failed: ${friendlyError(err)}`)] }).catch(() => {});
    }
  }, { timezone: cfg.timezone });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/* Single-instance guard — prevents two bot copies replying to every message */
const PID_FILE = path.join(__dirname, 'bot.pid');
try {
  if (fs.existsSync(PID_FILE)) {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim() || '0', 10);
    if (oldPid && oldPid !== process.pid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch { /* not running */ }
      if (alive) {
        console.error(`\n❌ Another bot instance is already running (PID ${oldPid}).`);
        console.error('   Stop it first:  pkill -f "node index.js"  — then start again.\n');
        process.exit(1);
      }
    }
  }
} catch { /* stale/corrupt lock is fine */ }
fs.writeFileSync(PID_FILE, String(process.pid));
const releaseLock = () => {
  try { if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
};
process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN.startsWith('PASTE_')) {
  console.error('\n❌ No Discord bot token found!');
  console.error('   Open the .env file and set DISCORD_TOKEN=your-bot-token');
  console.error('   Get it from: https://discord.com/developers/applications → your app → Bot → Reset Token\n');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Login failed:', err.message);
  process.exit(1);
});
