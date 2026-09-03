// lib/config.js — tiny JSON config store (AI room, daily brief settings)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  aiChannelId: null,      // channel where the bot replies to EVERY message
  briefChannelId: null,   // channel that receives the daily news brief
  briefHour: 9,           // 9 AM
  briefMinute: 0,
  timezone: process.env.BRIEF_TIMEZONE || 'Asia/Karachi',
};

let cache = null;

export function getConfig() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

export function saveConfig(patch) {
  const next = { ...getConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  cache = next;
  return next;
}
