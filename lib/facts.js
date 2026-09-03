// lib/facts.js — persistent workspace facts + dynamic-enum resolution cache.
//
// "Facts" are stable answers the bot learns about the user's connected accounts
// (e.g. which Facebook Page is "our page"), so natural phrases like
// "post on our Facebook page" resolve without asking every time.
// "Enum cache" stores results of Zapier's list_dynamic_enum_values helper
// (24h TTL) so we don't re-fetch the same dropdown options on every action.

import { load, save } from './store.js';

const ENUM_TTL_MS = 24 * 60 * 60 * 1000;

let facts = null;

function get() {
  if (!facts) {
    facts = load('facts', {});
    if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) facts = {};
    if (typeof facts.saved !== 'object' || facts.saved === null) facts.saved = {};
    if (typeof facts.enums !== 'object' || facts.enums === null) facts.enums = {};
  }
  return facts;
}

function flush() {
  try { save('facts', facts); } catch (err) { console.error('[facts] save failed:', err.message); }
}

/** Get a saved fact, e.g. getFact('facebookPage') → { value, label, at } or null */
export function getFact(key) {
  const f = get().saved[key];
  return f && typeof f === 'object' && Object.keys(f).length ? f : null;
}

/** Save a fact (overwrites) */
export function setFact(key, value) {
  get().saved[key] = { ...value, at: Date.now() };
  flush();
}

/** Forget a fact (e.g. after an auth failure so we re-ask next time) */
export function clearFact(key) {
  delete get().saved[key];
  flush();
}

function enumCacheGet(key) {
  const e = get().enums[key];
  if (!e || !Array.isArray(e.values)) return null;
  if (Date.now() - e.at > ENUM_TTL_MS) return null;
  return e.values;
}

function enumCacheSet(key, values) {
  get().enums[key] = { values, at: Date.now() };
  flush();
}

/** Cached wrapper key for one tool property (+optional search term) */
export function enumCache(toolName, prop, search) {
  const key = `${toolName}.${prop}::${String(search || '').toLowerCase()}`;
  return {
    get: () => enumCacheGet(key),
    set: (values) => enumCacheSet(key, values),
  };
}
