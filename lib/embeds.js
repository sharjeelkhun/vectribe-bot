// lib/embeds.js — fancy embed helpers + per-channel conversation memory
import { EmbedBuilder } from 'discord.js';

export const BRAND_COLOR = 0x7c3aed;      // Z.ai purple
export const OK_COLOR = 0x22c55e;
export const ERROR_COLOR = 0xef4444;
export const INFO_COLOR = 0x0ea5e9;
export const FOOTER = 'Powered by Z.ai';

export function baseEmbed(color = BRAND_COLOR) {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: FOOTER })
    .setTimestamp();
}

export function okEmbed(title, description) {
  return baseEmbed(OK_COLOR).setTitle(`✅ ${title}`).setDescription(description);
}

export function errorEmbed(message) {
  return baseEmbed(ERROR_COLOR)
    .setTitle('❌ Something went wrong')
    .setDescription(String(message).slice(0, 4000));
}

export function infoEmbed(title, description) {
  return baseEmbed(INFO_COLOR).setTitle(title).setDescription(description);
}

/** Split long text into Discord-safe chunks (max 4000 chars each) */
export function chunkText(text, max = 4000) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest.length) out.push(rest);
  return out;
}

/* ------------------------------------------------------------------ */
/* Per-channel conversation memory (last 8 exchanges)                  */
/* ------------------------------------------------------------------ */

const memory = new Map(); // key: channelKey -> [{role, content}]
const MAX_TURNS = 8;

export function memoryKey(channelId, userId = 'global') {
  return `${channelId}:${userId}`;
}

export function getHistory(key) {
  return memory.get(key) || [];
}

export function pushHistory(key, userMsg, assistantMsg) {
  const hist = memory.get(key) || [];
  hist.push({ role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg });
  while (hist.length > MAX_TURNS * 2) hist.splice(0, 2);
  memory.set(key, hist);
}

export function resetHistory(key) {
  memory.delete(key);
}

/** Simple per-user cooldown to prevent spam (returns ms remaining) */
const cooldowns = new Map();
export function checkCooldown(userId, ms = 4000) {
  const now = Date.now();
  const until = cooldowns.get(userId) || 0;
  if (now < until) return until - now;
  cooldowns.set(userId, now + ms);
  return 0;
}
