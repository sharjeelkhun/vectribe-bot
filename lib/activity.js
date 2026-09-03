// lib/activity.js — persistent log of what the bot ACTUALLY did (emails sent,
// lead hunts, Zapier actions, reminders…). Survives restarts and works across
// channels, so "what were we doing?" always has a real answer.
import { load, save } from './store.js';

const MAX_ENTRIES = 40;
let entries = load('activity', []);
if (!Array.isArray(entries)) entries = [];

const fmtTs = (ts) =>
  new Date(ts).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Record one completed action. Keep summaries short — they get injected into LLM context. */
export function addActivity(kind, summary) {
  const s = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  if (!s) return;
  entries.unshift({ ts: Date.now(), kind, summary: s });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  save('activity', entries);
}

/** Compact bullet list of the latest actions (for LLM context or embeds). */
export function activityBlock(max = 10) {
  if (!entries.length) return '';
  return entries
    .slice(0, max)
    .map((e) => `• [${fmtTs(e.ts)}] (${e.kind}) ${e.summary}`)
    .join('\n');
}
