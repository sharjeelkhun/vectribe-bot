// lib/reminders.js — persistent reminders with natural-language time + scheduler
import { load, save } from './store.js';
import { complete } from './zai.js';

let reminders = load('reminders');
let nextId = reminders.reduce((m, r) => Math.max(m, r.id), 0) + 1;

const TZ = 'Asia/Karachi';

/* ---------------- time parsing ---------------- */

// Karachi is fixed UTC+5 (no DST) — do wall-clock math explicitly
const TZ_OFFSET_MS = 5 * 3600 * 1000;
const wallToEpoch = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi) - TZ_OFFSET_MS;
function karachiNow() {
  const u = new Date(Date.now() + TZ_OFFSET_MS);
  return { y: u.getUTCFullYear(), mo: u.getUTCMonth(), d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes() };
}

function regexParse(text) {
  const now = Date.now();
  const t = text.toLowerCase().trim();

  let m = t.match(/^in\s+(\d+)\s*(second|sec|minute|min|hour|hr|day|week)s?$/);
  if (m) {
    const n = parseInt(m[1]);
    const unitMs = { second: 1000, sec: 1000, minute: 60000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000, week: 604800000 }[m[2]];
    return now + n * unitMs;
  }

  const timeRe = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/;
  const parseH = (mm) => {
    let h = parseInt(mm[1]);
    if (mm[3] === 'pm' && h < 12) h += 12;
    if (mm[3] === 'am' && h === 12) h = 0;
    if (!mm[3] && h < 8) h += 12; // "at 9" → 9 PM more likely than 9 AM
    return [h, parseInt(mm[2] || '0')];
  };

  // "tomorrow ..." or bare "at HH:mm"
  m = t.match(/^tomorrow\b/);
  if (m) {
    const k = karachiNow();
    const mm = t.replace(/^tomorrow\b\s*/, '').match(timeRe);
    const [h, mi] = mm ? parseH(mm) : [9, 0]; // default 9 AM
    return wallToEpoch(k.y, k.mo, k.d + 1, h, mi);
  }

  m = t.match(/^(?:today\s+)?at\s+/) ? t.match(/^(?:today\s+)?at\s+(.*)$/) : null;
  if (m) {
    const mm = m[1].match(timeRe);
    if (mm) {
      const k = karachiNow();
      const [h, mi] = parseH(mm);
      let ts = wallToEpoch(k.y, k.mo, k.d, h, mi);
      if (ts <= now) ts = wallToEpoch(k.y, k.mo, k.d + 1, h, mi); // next occurrence
      return ts;
    }
  }

  return null;
}

/** LLM-based natural time normalization (handles "tomorrow evening", "next friday", etc.) */
async function llmParse(text) {
  const nowInTz = new Date().toLocaleString('en-US', { timeZone: TZ, dateStyle: 'full', timeStyle: 'long' });
  const raw = await complete([
    {
      role: 'assistant',
      content:
        `You convert a natural-language time into an exact future ISO-8601 timestamp with timezone +05:00. ` +
        `Current date/time in ${TZ}: ${nowInTz}. ` +
        `If the phrase is already a relative duration like "in 10 minutes", compute it. ` +
        `If the time has no date and would be in the past today, use tomorrow. ` +
        `Reply with ONLY the ISO timestamp string, nothing else. Example: 2026-09-04T21:00:00+05:00`,
    },
    { role: 'user', content: text },
  ]);
  const isoMatch = raw?.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:[+-]\d{2}:\d{2}|Z)?/);
  if (!isoMatch) return null;
  const d = new Date(isoMatch[0]);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Parse "when" text into a future epoch-ms timestamp.
 * Tries fast regex first, then LLM.
 */
export async function parseWhen(text) {
  const t = Date.now();
  let ts = regexParse(text);
  if (!ts) {
    try { ts = await llmParse(text); } catch { /* ignore */ }
  }
  if (!ts || ts < t || ts > t + 1000 * 86400 * 365) return null;
  return ts;
}

export function fmtWhen(ts) {
  return new Date(ts).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) + ` (${TZ})`;
}

/* ---------------- CRUD ---------------- */

export function addReminder({ userId, username, channelId, guildName, text, dueTs }) {
  const r = { id: nextId++, userId, username, channelId, guildName: guildName || null, text, dueTs, fired: false, createdAt: Date.now() };
  reminders.push(r);
  save('reminders', reminders);
  return r;
}

export function listReminders(userId) {
  return reminders.filter((r) => r.userId === userId && !r.fired).sort((a, b) => a.dueTs - b.dueTs);
}

export function cancelReminder(userId, id) {
  const r = reminders.find((r) => r.id === id && r.userId === userId && !r.fired);
  if (!r) return false;
  r.fired = true;
  r.cancelled = true;
  save('reminders', reminders);
  return true;
}

/* ---------------- scheduler ---------------- */

/**
 * Check for due reminders and deliver them. Call every ~30s from index.js.
 */
export async function tick(client) {
  const now = Date.now();
  const due = reminders.filter((r) => !r.fired && r.dueTs <= now);
  for (const r of due) {
    r.fired = true;
    const lateMin = Math.floor((now - r.dueTs) / 60000);
    save('reminders', reminders);

    const content =
      `⏰ <@${r.userId}> **Reminder${lateMin > 5 ? ` (${lateMin} min late — I was offline)` : ''}:** ${r.text}`;
    try {
      let ch = null;
      try { ch = r.channelId ? await client.channels.fetch(r.channelId) : null; } catch { /* gone */ }
      if (ch) await ch.send({ content });
      else await (await client.users.fetch(r.userId)).send({ content });
      console.log(`⏰ reminder #${r.id} delivered to ${r.username}`);
    } catch (err) {
      console.error(`✗ reminder #${r.id} delivery failed:`, err.message);
    }
  }
}

/** Re-fire reminders missed while the bot was offline if < 24h late (called on boot) */
export function recoverMissed() {
  const now = Date.now();
  let changed = false;
  for (const r of reminders) {
    if (!r.fired && r.dueTs <= now - 86400000) {
      r.fired = true;
      r.expired = true;
      changed = true;
    }
  }
  if (changed) save('reminders', reminders);
  return changed;
}
