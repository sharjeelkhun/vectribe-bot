// lib/agent.js — the agent brain: routes natural-language requests to tools
import { friendlyError, readPage, webSearch, complete, lastBusyWithin } from './zai.js';
import { parseWhen, fmtWhen, addReminder, listReminders, cancelReminder } from './reminders.js';
import { addNote, listNotes, deleteNote, addTask, listTasks, completeTask, deleteTask } from './notes.js';
import { isGmailConfigured, sendEmail, readInbox } from './gmail.js';
import { isMcpConfigured, zapierListTools, zapierCallTool } from './mcp.js';
import { getFact, setFact, enumCache } from './facts.js';
import { addActivity, activityBlock } from './activity.js';
import { baseEmbed, OK_COLOR, INFO_COLOR } from './embeds.js';

const TZ = 'Asia/Karachi';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Helper/internal MCP tools the LLM should not pick directly */
const ZAPIER_INTERNAL = new Set(['get_dynamic_properties_schema', 'list_dynamic_enum_values', 'get_configuration_url']);

/** Pretty names for Zapier app prefixes (fallback: capitalized prefix) */
const APP_LABELS = {
  apollo: 'Apollo.io',
  brevo: 'Brevo',
  facebook: 'Facebook Pages',
  gmail: 'Gmail',
  google: 'Google Analytics 4',
  hubspot: 'HubSpot',
};
const appLabel = (prefix) => APP_LABELS[prefix] || prefix.charAt(0).toUpperCase() + prefix.slice(1);

/** Live list of connected Zapier apps → "Apollo.io, Brevo, Facebook Pages, …" */
async function zapierAppsLine() {
  if (!isMcpConfigured()) return '';
  try {
    const tools = await zapierListTools();
    const apps = new Set();
    for (const t of tools) {
      if (ZAPIER_INTERNAL.has(t.name)) continue;
      apps.add(appLabel(t.name.split('_')[0]));
    }
    return apps.size ? ` (currently connected: ${[...apps].sort().join(', ')})` : '';
  } catch { return ''; }
}

/** Per-user pending clarification: userId -> { originalText, question, at } */
const pendingClarify = new Map();
const CLARIFY_TTL_MS = 10 * 60 * 1000;

/** Per-user lead-outreach approval gate: userId -> { leads, drafts, profile, at } */
const pendingLeadSend = new Map();
const LEAD_TTL_MS = 30 * 60 * 1000;
const MAX_LEADS = 10;

/** Compact recent-conversation + persistent-activity block so "our agency"/"that site"/
 *  "what were we doing?" resolve even in a brand-new channel or after a restart */
function contextBlock(user) {
  const h = Array.isArray(user?.history) ? user.history.slice(-6) : [];
  const lines = h
    .map((m) => `${m.role === 'user' ? 'User' : 'Bot'}: ${String(m.content || '').replace(/\s*\n+\s*/g, ' ').slice(0, 200)}`)
    .join('\n');
  const conv = h.length
    ? `\nRECENT CONVERSATION (resolve references like "our agency", "that website", "them" from this):\n${lines}\n`
    : '';
  const act = activityBlock(8);
  const actBlock = act
    ? `\nWORKSPACE ACTIVITY — real things I recently did for the user (persistent log, survives restarts and works across channels):\n${act}\n`
    : '';
  return conv + actBlock;
}

/** Messages that start a brand-new instruction (not an answer to my question) */
function looksLikeFreshCommand(text) {
  return /^(\/|remind\b|note\b|task\b|reset\b|help\b|my (tasks|notes|reminders)\b|add (task|note)\b)/i.test(String(text || '').trim());
}

/** Match a user reply against numbered/labeled options → { value, label } or null */
function matchOption(text, options) {
  const t = String(text || '').trim().toLowerCase().replace(/^(the|my)\s+/, '');
  if (!t || !Array.isArray(options) || !options.length) return null;
  const num = t.match(/^(\d{1,2})\b/);
  if (num) { const i = parseInt(num[1], 10) - 1; if (options[i]) return options[i]; }
  let m = options.find((o) => String(o.label).toLowerCase() === t);
  if (m) return m;
  m = options.find((o) => {
    const l = String(o.label).toLowerCase();
    return t.includes(l) || l.includes(t);
  });
  return m || null;
}

/** Does a free-text phrase plausibly refer to the saved page? ("our facebook page" etc.) */
function phraseMatchesPage(raw, label) {
  const r = String(raw || '').trim().toLowerCase();
  const l = String(label || '').trim().toLowerCase();
  if (!r) return true;
  if (/^(our|my|the|main|company|business|client)?\s*(facebook\s*)?(fan ?)?(page|profile)$/.test(r)) return true;
  if (!l) return false;
  return r.includes(l) || l.includes(r);
}

/** Fetch valid values for a dynamic-enum property via Zapier's resolver helper (cached 24h) */
async function listEnumValues(toolName, prop, search) {
  const cache = enumCache(toolName, prop, search);
  const cached = cache.get();
  if (cached) return cached;
  const args = { tool_name: toolName, property_name: prop };
  if (search) args.search = search;
  const r = await zapierCallTool('list_dynamic_enum_values', args);
  if (r.isError) return [];
  try {
    const parsed = JSON.parse(r.text);
    let values = Array.isArray(parsed?.values) ? parsed.values : [];
    // small lists paginate — merge one extra page when browsing (no search term)
    if (parsed?.next_cursor && !search) {
      try {
        const r2 = await zapierCallTool('list_dynamic_enum_values', { ...args, cursor: parsed.next_cursor });
        const p2 = JSON.parse(r2.text);
        if (Array.isArray(p2?.values)) values = values.concat(p2.values);
      } catch { /* first page is enough */ }
    }
    cache.set(values);
    return values;
  } catch { return []; }
}

async function toolCatalog() {
  const zapierApps = await zapierAppsLine();
  const tools = [
    'reminder.create  — set a reminder. params: when (natural time like "tomorrow 9am", "in 15 minutes"), what (text)',
    'reminder.list    — show my active reminders. params: none',
    'reminder.cancel  — cancel a reminder. params: id (number)',
    'note.add         — save a note. params: text',
    'note.list        — show my notes. params: none',
    'task.add         — add a task to my checklist. params: text',
    'task.list        — show my tasks. params: none',
    'task.done        — mark a task complete. params: id (number)',
    'email.send       — send an email from the connected Gmail. params: to, subject, body',
    'email.inbox      — read recent inbox emails. params: query (optional, name/subject to search)',
    `zapier           — run an action in the user\u2019s connected Zapier apps${zapierApps}. Choose for CONCRETE actions on those apps: send an email (Gmail or Brevo), create/save a lead-contact-deal-company (Apollo/HubSpot/Brevo), post to Facebook, get website analytics. params: none (details extracted later)`,
    'lead.hunt        — find real potential clients/leads for the user\u2019s own business (profile known from context/website) and prepare personalized outreach emails for approval. Use when the user wants to find/generate leads or clients and email them, e.g. "find clients based on our agency and send them emails". params: none (criteria from conversation)',
    'zapier.list      — show which Zapier apps and actions are connected, or answer "can you access X?" questions. params: none',
    'hubspot.save     — save leads into HubSpot as contacts. Use when the user says "save to hubspot" / "add these leads to hubspot" / "log them in hubspot". params: leads — array of {name,email,company,website}: extract any leads pasted in the message; use [] to save the most recent hunt results',
    'chat             — normal conversation / question. params: none',
  ];
  let list = tools.filter((t) => isGmailConfigured() || !t.startsWith('email.'));
  list = list.filter((t) => isMcpConfigured() || !t.startsWith('zapier'));
  return list;
}

async function classify(text, user = null) {
  const now = new Date().toLocaleString('en-US', { timeZone: TZ, dateStyle: 'full', timeStyle: 'long' });
  const catalog = await toolCatalog();
  const instructions =
    `You are the intent router of an AI agent. Current date/time in ${TZ}: ${now}.\n` +
    `Available actions:\n${catalog.join('\n')}\n\n` +
    `Decide ONE action for the user message. If the user asks a question, chats, or wants an answer → "chat".\n` +
    `Finding/generating LEADS or CLIENTS for the user's own business outreach (with or without emailing) → "lead.hunt". A general information question that merely contains "find" (e.g. "find plumbers in Austin") → "chat".\n` +
    `Saving leads INTO HubSpot (e.g. "save to hubspot", "save these to hubspot: John john@acme.com Acme Corp") → "hubspot.save" with params.leads = the leads extracted from the message as [{name,email,company,website}], or [] when none are pasted (then the most recent hunt results are saved).\n` +
    `If the user asks whether you can access/use a connected app or what you can do with it (e.g. "can you access brevo?") → "zapier.list" (only if that app appears in the connected list; otherwise "chat").\n` +
    `General questions ABOUT Zapier, MCP or automation concepts → "chat" (only concrete actions on connected apps → "zapier").\n` +
    `For reminder.create keep "when" in the user's own words (a later step parses it precisely).\n` +
    `Reply with ONLY a JSON object, no markdown, no explanations:\n` +
    `{"action":"<action>","params":{...}}`;

  try {
    const raw = await complete([
      { role: 'assistant', content: instructions },
      { role: 'user', content: `${contextBlock(user)}CURRENT MESSAGE: ${String(text || '').slice(0, 800)}` },
    ]);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { action: 'chat', params: {} };
    const parsed = JSON.parse(m[0]);
    return { action: parsed.action || 'chat', params: parsed.params || {} };
  } catch (err) {
    console.error('[agent] classify failed:', err.message);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* LEAD HUNT — find real prospects + draft outreach + approval gate    */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
function extractEmails(text) {
  const found = new Set();
  for (const m of String(text || '').matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    if (/\.(png|jpg|jpeg|gif|webp|svg|css|js|ico)$/.test(e)) continue;
    if (/(example\.(com|org)|yourdomain|yourcompany|domain\.(com|co)|email\.com|@sentry|wixpress|@2x|no-?reply|\.test@)/.test(e)) continue;
    found.add(e);
  }
  return [...found];
}

/** One LLM call that must return JSON (object or array) — or null.
 * API busy/429 handling lives in complete() (long backoff); here we only
 * retry once on JSON-parse hiccups, then give up (callers handle null). */
async function llmJson(instructions, userContent, attempts = 2) {
  const messages = [
    { role: 'assistant', content: instructions },
    { role: 'user', content: String(userContent || '').slice(0, 11000) },
  ];
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = await complete(messages);
      const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (!m) continue;
      return JSON.parse(m[0]);
    } catch (err) {
      // complete() already did the long busy-backoff — a thrown error here is
      // either a rate-limit exhaustion or an empty response; don't re-storm.
      console.error('[leadhunt:llm]', err.message);
      if (/429|rate limit|too many requests/i.test(String(err?.message || ''))) return null;
      if (i < attempts - 1) continue;
    }
  }
  return null;
}

/** Agency profile: from saved fact, or learned by reading the user's website (from msg/history) */
async function ensureProfile(user, text) {
  let p = getFact('agencyProfile');
  if (p?.name) return p;
  const histText = (Array.isArray(user?.history) ? user.history : []).slice(-6).map((h) => h.content).join(' ');
  const urlMatch = `${text} ${histText}`.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!urlMatch) return null;
  try {
    const page = await readPage(urlMatch[0]);
    const parsed = await llmJson(
      'Extract a business profile from this website content. Reply ONLY with JSON: ' +
      '{"name":"...","website":"...","location":"...","services":["..."],"idealCustomers":"one sentence: who would buy these services","pitch":"one sentence value proposition"}. ' +
      'Base EVERYTHING on the page content only. If the content is not a business website, reply {"error":"insufficient"}.',
      page.text.slice(0, 9000)
    );
    if (parsed && !parsed.error && parsed.name) {
      p = parsed;
      setFact('agencyProfile', p);
    }
  } catch (err) {
    console.error('[leadhunt:profile]', err.message);
  }
  return p || null;
}

/** Find people via Apollo's real search API through Zapier (returns [] on any problem) */
async function apolloSearch(criteria, count) {
  const body = await llmJson(
    'Build an Apollo.io people-search request body (POST /v1/mixed_people/search). Use ONLY these fields: ' +
    'person_locations (array of country/region/city strings), person_titles (array of job titles), ' +
    'q_organization_keyword_tags (array of industries), organization_num_employees_ranges (array like ["11,50"]), page: 1, per_page: N. ' +
    'Reply ONLY with the JSON body object, nothing else.',
    `Target criteria: ${criteria}\nper_page: ${Math.min(count * 4, 25)}`
  );
  if (!body || typeof body !== 'object') return [];
  try {
    const r = await zapierCallTool('apollo_make_api_mutating_request', {
      url: 'https://api.apollo.io/v1/mixed_people/search',
      method: 'POST',
      body: JSON.stringify(body),
      output_hint: 'the raw JSON response unchanged',
    });
    if (r.isError) return [];
    const parsed = JSON.parse(r.text);
    const people = parsed?.people || parsed?.contacts || [];
    return people
      .map((p) => ({
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || '',
        title: p.title || '',
        company: p.organization?.name || p.account?.name || '',
        email: String(p.email || '').trim(),
        website: p.organization?.website_url || p.organization?.primary_domain || '',
        source: 'Apollo',
        note: '',
      }))
      .filter((l) => l.email);
  } catch (err) {
    console.error('[leadhunt:apollo]', err.message);
    return [];
  }
}

/** Failed web searches in the most recent webHunt (distinguishes blips from dry spells) */
let lastWebHuntFails = 0;

/** Fallback: hunt the live web — search niche → read sites → extract contact emails */
async function webHunt(criteria, count, profile) {
  lastWebHuntFails = 0;
  // remember past hunts so every new hunt explores FRESH niches/towns/hosts
  const usedQueries = Array.isArray(getFact('leadHuntQueries')) ? getFact('leadHuntQueries') : [];
  const usedHosts = new Set(Array.isArray(getFact('leadHuntHosts')) ? getFact('leadHuntHosts') : []);
  const queries = await llmJson(
    'Generate 3 Google search queries to find POTENTIAL CLIENTS for the described agency — i.e. real small/local businesses that would BUY its services ' +
    '(good query patterns: a tradesman niche + city, e.g. "plumbers Birmingham", "accountants Leeds", "family restaurants Manchester", "dental clinics Birmingham"). ' +
    'The queries must NOT target other agencies or providers of the same/similar services — those are competitors, not clients. ' +
    (usedQueries.length
      ? `Previous hunts already used these queries — do NOT repeat or paraphrase them; rotate to DIFFERENT niches (restaurants, dentists, gyms, solicitors, electricians, barbers, estate agents, cafés, garages…) and/or nearby towns: ${usedQueries.slice(-18).map((q) => `"${q}"`).join(', ')}. `
      : '') +
    'Avoid directories, marketplaces, wikipedia, linkedin, facebook, instagram, yelp, reddit, youtube. ' +
    'Reply ONLY with a JSON array of 3 query strings.',
    `Agency: ${profile?.name || ''} — services: ${(profile?.services || []).join(', ')}. Location: ${profile?.location || 'any'}. Ideal customers: ${profile?.idealCustomers || criteria}. ALWAYS target the agency's own location and disambiguate it (e.g. "Birmingham UK", never Birmingham AL).`
  );
  if (!Array.isArray(queries)) { lastWebHuntFails = 3; return []; }
  const candidates = [];
  const seen = new Set();
  for (const q of queries.slice(0, 3)) {
    try {
      const results = await webSearch(q, 8);
      for (const r of results) {
        try {
          const host = new URL(r.url).hostname.replace(/^www\./, '');
          if (seen.has(host) || usedHosts.has(host)) continue; // dedupe within this hunt AND across past hunts
          if (/(linkedin|facebook|instagram|yelp|trustpilot|wikipedia|youtube|tiktok|amazon|reddit|pinterest|glassdoor|indeed|google\.|apple\.com|microsoft\.com)/.test(host)) continue;
          seen.add(host);
          candidates.push({ url: r.url, host, title: r.name || '', snippet: r.snippet || '' });
        } catch { /* bad url */ }
      }
    } catch { lastWebHuntFails += 1; }
    if (candidates.length >= count * 4) break;
  }

  // LLM quality filter — keep only true potential clients (drop competitors, providers, directories)
  let filtered = candidates;
  if (candidates.length) {
    const verdict = await llmJson(
      'Classify these websites found via Google. The user\u2019s agency SELLS: ' +
      `${(profile?.services || []).join(', ') || 'web/design services'}. ` +
      'Keep a candidate ONLY if it is a plausible CLIENT: a business that would BUY those services (a shop, tradesperson, clinic, restaurant, startup, local company…). ' +
      'DROP competitors (businesses offering the same or similar services), directories/marketplaces, news/blog sites, and giant platforms. ' +
      'Reply ONLY with JSON: {"keep":[candidate numbers]} — the numbers of candidates to keep, or [] if none qualify.',
      candidates.map((c, i) => `${i + 1}. [${c.host}] ${String(c.title).slice(0, 90)} — ${String(c.snippet).slice(0, 120)}`).join('\n')
    );
    if (verdict && Array.isArray(verdict.keep)) {
      const keep = new Set(verdict.keep.map(Number).filter((n) => n >= 1 && n <= candidates.length));
      filtered = candidates.filter((_, i) => keep.has(i + 1));
    }
  }
  const leads = [];
  for (const c of filtered.slice(0, 8)) {
    if (leads.length >= count) break;
    try {
      const page = await readPage(c.url);
      let emails = extractEmails(page.text);
      if (!emails.length) {
        try {
          const cp = await readPage(`https://${c.host}/contact`);
          emails = extractEmails(cp.text);
        } catch { /* no /contact page */ }
      }
      if (!emails.length) continue;
      leads.push({
        name: String(c.title || '').split('|')[0].trim() || c.host,
        title: '',
        company: c.host,
        email: emails[0],
        website: `https://${c.host}`,
        source: c.url,
        note: c.snippet.slice(0, 140),
      });
    } catch { /* page read failed */ }
  }
  // persist consumed queries + hosts so the NEXT hunt rotates to fresh ground
  try {
    setFact('leadHuntQueries', [...new Set([...usedQueries, ...queries])].slice(-40));
    const readHosts = filtered.slice(0, 8).map((c) => c.host);
    const leadHosts = leads.map((l) => { try { return new URL(l.source).hostname.replace(/^www\./, ''); } catch { return ''; } });
    setFact('leadHuntHosts', [...new Set([...usedHosts, ...readHosts, ...leadHosts])].filter(Boolean).slice(-300));
  } catch { /* facts unavailable */ }
  return leads;
}

/** Write one personalized outreach email per lead (single LLM call) */
async function draftEmails(profile, leads, extra = '') {
  const slim = leads.map((l) => ({ email: l.email, name: l.name, title: l.title, company: l.company, note: l.note, website: l.website }));
  const drafts = await llmJson(
    'You write cold outreach emails for the user\u2019s agency. For EACH lead write ONE short personalized email (90-130 words): ' +
    'subject (no "Re:"), body in plain text \u2014 greeting by name or "Hi there", one line proving you looked at THEIR business ' +
    '(use their company/note/website only \u2014 NEVER invent facts about them), 2-3 concrete value lines tied to the agency\u2019s services, ' +
    'one clear CTA question, sign-off with the agency name. Friendly-professional, no hype. ' +
    'Reply ONLY with a JSON array: [{"email":"...","name":"...","subject":"...","body":"..."}] in the same order as the leads.',
    `Agency profile: ${JSON.stringify(profile)}\nLeads: ${JSON.stringify(slim)}${extra ? `\n${extra}` : ''}`
  );
  return Array.isArray(drafts) ? drafts : [];
}

function leadPreviewEmbed(leads, drafts, profile, viaApollo = false) {
  const list = leads
    .slice(0, MAX_LEADS)
    .map((l, i) => `**${i + 1}. ${l.name || l.company || 'Business'}** — ${l.email}${l.company && l.company !== l.name ? ` (${l.company})` : ''}\n　　🔗 ${l.source}`)
    .join('\n');
  const d0 = drafts[0] || {};
  const preview = `**Subject:** ${d0.subject || '(drafting…)'}\n${String(d0.body || '').slice(0, 700)}`;
  return ok(
    '🎯 Lead hunt ready — for your approval',
    `Found **${leads.length} real lead${leads.length === 1 ? '' : 's'}** for **${profile?.name || 'your agency'}** (${viaApollo ? 'via Apollo' : 'via live web — emails taken from their own sites'}):\n\n${list}\n\n` +
      `✉️ **Draft preview (lead 1):**\n${preview}\n\n` +
      `Reply **send** to email all ${leads.length}, **stop** to cancel — or tell me what to change (e.g. *"make it shorter"*, *"more casual"*, *"mention pricing"*).`,
    INFO_COLOR
  );
}

/** The full lead-hunt orchestration */
async function leadHunt(text, user) {
  if (!isMcpConfigured()) return ok('🎯 Lead hunt unavailable', 'Zapier must be connected so I can send the outreach emails. Add ZAPIER_MCP_URL to the bot .env first.', 0xef4444);
  const countMatch = String(text || '').match(/\b(\d{1,2})\s*(leads?|clients?|businesses|companies|emails?|prospects?)\b/i);
  const count = Math.min(Math.max(countMatch ? parseInt(countMatch[1], 10) : 5, 1), MAX_LEADS);

  const profile = await ensureProfile(user, text);
  if (!profile?.name) {
    return ok(
      '🎯 Lead hunt — first, your business',
      'I couldn\u2019t find your business profile yet. Tell me your website (e.g. *"our website is https://vectribeagency.com"*) and I\u2019ll learn what you do, then hunt matching clients and draft the outreach emails for your approval.',
      0xef4444
    );
  }

  // 1) find real leads — Apollo first, live-web fallback
  const criteria = `${profile.idealCustomers || 'businesses that could need: ' + (profile.services || []).join(', ')}${profile.location ? ' — location: ' + profile.location : ''}. User's extra instructions: ${text.slice(0, 300)}`;
  let leads = await apolloSearch(criteria, count);
  let viaApollo = leads.length > 0;
  if (leads.length < 2) {
    const webLeads = await webHunt(criteria, count, profile);
    const seen = new Set(leads.map((l) => l.email));
    for (const l of webLeads) if (!seen.has(l.email)) leads.push(l);
    viaApollo = viaApollo && leads.length > 0;
  }
  leads = leads.slice(0, count);
  if (!leads.length) {
    if (lastBusyWithin(180000)) {
      return ok('⏳ Hunt throttled — not a dry spell', 'The AI service rate-limited me mid-hunt (too many requests in a burst). I retried in the background but the window stayed busy.\n\nWait **~1 minute** and say **find clients** again — the hunt will rerun with the same instructions.', 0xef4444);
    }
    if (lastWebHuntFails >= 2) {
      return ok('🌐 Search hiccup — not a dry spell', 'The live web search dropped mid-hunt (a network blip on my side, not an empty market).\n\nSay **find clients** again — it usually lands on the retry.', 0xf59e0b);
    }
    return ok('🎯 No leads found', 'I couldn\u2019t verify real, reachable leads for that criteria. Try telling me a niche or location, e.g. *"find 5 restaurant owners in Birmingham and email them"*.', 0xef4444);
  }

  // 2) draft personalized emails
  const drafts = await draftEmails(profile, leads);
  if (!drafts.length) return ok('✏️ Drafting failed', lastBusyWithin(180000) ? 'The AI service rate-limited me while writing the emails. Wait **~1 minute** and say **find clients** again — the leads are easy to re-find.' : 'The writing model returned nothing usable — say **find clients** again to retry.', 0xef4444);

  // 3) approval gate — nothing is sent without an explicit "send"
  pendingLeadSend.set(user.id, { leads, drafts, profile, at: Date.now() });
  setFact('lastLeads', leads.slice(0, 12)); // kept for "save to hubspot" requests
  console.log(`🎯 lead hunt: ${leads.length} leads (${viaApollo ? 'apollo' : 'web'}), drafts ready, awaiting approval`);
  addActivity('lead hunt', `Found ${leads.length} real leads for ${profile.name} (via ${viaApollo ? 'Apollo' : 'live web'}) — ${leads.map((l) => l.company || l.name).slice(0, 4).join(', ')} — drafts awaiting approval`);
  return leadPreviewEmbed(leads, drafts, profile, viaApollo);
}

function ok(title, description, color = OK_COLOR) {
  return { embed: baseEmbed(color).setTitle(title).setDescription(description) };
}

function clarifyEmbed(question) {
  return ok('🧩 One more detail needed', question, INFO_COLOR);
}

/* ------------------------------------------------------------------ */
/* HUBSPOT — save leads as contacts via Zapier                         */
/* ------------------------------------------------------------------ */

const HUBSPOT_QUOTA_RE = /insufficient|billing|upgrade your|monthly task/i;

function leadToContactArgs(l) {
  const parts = String(l.name || '').trim().split(/\s+/).filter(Boolean);
  return {
    email: l.email,
    firstname: parts[0] || undefined,
    lastname: parts.slice(1).join(' ') || undefined,
    company: l.company || undefined,
    website: l.website || l.url || undefined,
    output_hint: 'confirm the contact id and whether it was created or updated only',
  };
}

/** Leads to save: pasted in message → pending approval → last hunt results */
function collectLeads(user, params) {
  if (Array.isArray(params?.leads) && params.leads.length) return params.leads;
  if (pendingLeadSend.has(user.id)) return pendingLeadSend.get(user.id).leads || [];
  const last = getFact('lastLeads');
  if (Array.isArray(last) && last.length) return last;
  return [];
}

/** Save leads to HubSpot via Zapier. Returns {embed, summary, saved, quotaDead} */
async function saveLeadsToHubspot(leads) {
  const clean = (Array.isArray(leads) ? leads : [])
    .filter((l) => l && (l.email || l.company || l.name))
    .slice(0, 12);
  const targets = clean.filter((l) => l.email);
  const skipped = clean.filter((l) => !l.email);
  if (!targets.length) {
    const msg = 'No leads with an email address were found to save. Hunt fresh leads ("find clients in <town>") or paste them here, then say **save to hubspot**.';
    return { saved: 0, summary: msg, quotaDead: false, embed: ok('💾 Nothing to save', msg, 0xef4444) };
  }
  const lines = [];
  let saved = 0;
  let quotaDead = false;
  for (const l of targets) {
    try {
      const r = await zapierCallTool('hubspot_create_or_update_contact', leadToContactArgs(l));
      if (r.isError && HUBSPOT_QUOTA_RE.test(r.text || '')) { quotaDead = true; break; }
      if (r.isError) lines.push(`❌ ${l.company || l.name || l.email} — ${(r.text || '').replace(/\n/g, ' ').slice(0, 90)}`);
      else { saved += 1; lines.push(`✅ ${l.company || l.name || l.email} (${l.email})`); }
    } catch (e) {
      if (HUBSPOT_QUOTA_RE.test(e.message || '')) { quotaDead = true; break; }
      lines.push(`❌ ${l.company || l.name || l.email} — ${friendlyError(e).slice(0, 90)}`);
    }
    await sleep(1000); // gentle pace between contact writes
  }
  if (quotaDead) {
    const msg = 'Your Zapier account has **0 tasks left** this month (it refills around **Sep 15**). The HubSpot save is fully wired up — say **save to hubspot** again once it refills and it will go through. The leads are safe here in chat meanwhile.';
    return { saved: 0, summary: msg, quotaDead: true, embed: ok('💾 HubSpot save blocked — Zapier bucket is empty', msg, 0xf59e0b) };
  }
  if (skipped.length) lines.push(`⏭️ Skipped (no email found): ${skipped.map((l) => l.company || l.name).join(', ').slice(0, 150)}`);
  addActivity('hubspot', `Saved ${saved}/${targets.length} leads to HubSpot: ${targets.map((l) => l.company || l.name || l.email).slice(0, 6).join(', ')}`);
  const summary = lines.join('\n').slice(0, 3000);
  return { saved, summary, quotaDead: false, embed: ok(`💾 HubSpot — ${saved}/${targets.length} contacts saved`, summary || 'done', saved ? OK_COLOR : 0xef4444) };
}

/** Run a picked Zapier tool and wrap the outcome in an embed. @returns {{payload, isError}} */
async function executeZapierPick(pick) {
  console.log(`⚡ zapier call: ${pick.tool}`, JSON.stringify(pick.args).slice(0, 200));
  const r = await zapierCallTool(pick.tool, pick.args);
  const head = `**${pick.tool}**`;
  if (r.isError) return { payload: ok('⚠️ Zapier action failed', `${head}\n\n${r.text.slice(0, 3500)}`, 0xef4444), isError: true };
  return { payload: ok('⚡ Zapier action done!', `${head}\n\n${r.text.slice(0, 3500)}`), isError: false };
}

/* ------------------------------------------------------------------ */
/* Deterministic arg fixups — resolve phrases like "our Facebook page" */
/* to real ids BEFORE executing, using saved facts + Zapier enums.      */
/* ------------------------------------------------------------------ */

/** @returns {{args} | {clarify, args, options?, field?}} */
async function fixupZapierArgs(toolName, args) {
  const out = { ...args };

  // Zapier marks output_hint as REQUIRED in descriptions — always provide one
  if (!String(out.output_hint || '').trim()) out.output_hint = 'a short confirmation with the resulting ids/status';

  // --- Facebook: the `page` field needs a REAL page id from the connected account ---
  if (/^facebook_pages_/.test(toolName)) {
    const saved = getFact('facebookPage');
    const raw = String(out.page || '').trim();
    const isRealId = /^\d{5,}$/.test(raw);

    if (!isRealId) {
      // 1) saved fact covers generic phrases ("our facebook page") and matching names
      if (saved?.value && phraseMatchesPage(raw, saved.label)) {
        out.page = saved.value;
        out.__pageLabel = saved.label;
        return { args: out };
      }
      // 2) ask Zapier which pages the connected account can use
      const searchTerm = raw && !/\b(our|my|the|main|company|business)\b/i.test(raw) ? raw : '';
      let options = [];
      try { options = await listEnumValues(toolName, 'page', searchTerm); } catch { options = []; }
      if (raw && options.length) {
        const m = matchOption(raw, options);
        if (m) { out.page = m.value; out.__pageLabel = m.label; return { args: out }; }
      }
      if (!raw && options.length === 1) {
        out.page = options[0].value;
        out.__pageLabel = options[0].label;
        return { args: out };
      }
      if (options.length > 1 || (raw && options.length)) {
        return {
          clarify:
            `Which Facebook page should I use? Reply with the number or name:\n` +
            options.map((o, i) => `**${i + 1}. ${o.label}**`).join('\n'),
          args: out,
          options,
          field: 'page',
        };
      }
      if (!raw) {
        return { clarify: 'Which Facebook page should I use? I couldn\u2019t find any pages on the connected Zapier Facebook account \u2014 please check the Facebook connection in Zapier, then tell me the page name.', args: out };
      }
      // raw phrase with no enum match → leave as-is; Zapier returns a clear error if invalid
    }
  }

  // --- A page post with no actual content is a hard missing fact — never post the raw request text ---
  if (toolName === 'facebook_pages_create_page_post' && !String(out.message || '').trim()) {
    const where = out.__pageLabel ? ` to **${out.__pageLabel}**` : '';
    return {
      clarify: `What should the post say${where}? Give me the text (and a link if you want one) and I\u2019ll publish it.`,
      args: out,
      field: 'message',
    };
  }

  // --- photo/video posts need a real public media URL in `source` ---
  if (/^facebook_pages_create_page_(photo|video)$/.test(toolName)) {
    const src = String(out.source || '').trim();
    if (!/^https?:\/\//i.test(src)) {
      return { clarify: `I need a **publicly accessible ${toolName.endsWith('_video') ? 'video' : 'image'} URL** to upload (it must start with http/https). Which one should I use?`, args: out, field: 'source' };
    }
  }
  // a plain-text post must never carry a fake photo source
  if (toolName === 'facebook_pages_create_page_post' && out.source && !/^https?:\/\//i.test(String(out.source))) {
    delete out.source;
  }

  // --- Generic dynamic-enum fields (HubSpot stages/owners, Gmail labels…):
  // silently replace the value ONLY on a confident label match; never block ---
  try {
    const tools = await zapierListTools();
    const tool = tools.find((t) => t.name === toolName);
    const props = tool?.inputSchema?.properties || {};
    for (const [k, v] of Object.entries(out)) {
      if (k === 'output_hint' || k.startsWith('__')) continue;
      if (typeof v !== 'string' || !v.trim() || /^\d{5,}$/.test(v.trim())) continue;
      if (k === 'page' && /^facebook_pages_/.test(toolName)) continue; // handled above
      const desc = String(props[k]?.description || '');
      if (!desc.includes('list_dynamic_enum_values')) continue;
      const opts = await listEnumValues(toolName, k, v.trim());
      if (opts?.length) {
        const m = matchOption(v, opts);
        if (m) out[k] = m.value;
      }
    }
  } catch { /* schema unavailable — continue with raw args */ }

  // --- Required-but-missing fields: auto-fill single-choice dynamic enums, ask
  //     numbered questions for multi-choice enums, otherwise ask for the value.
  //     (Converts cryptic Zapier "Missing argument values" errors into a clear question.)
  try {
    const tools = await zapierListTools();
    const tool = tools.find((t) => t.name === toolName);
    const schema = tool?.inputSchema || {};
    const req = Array.isArray(schema.required) ? schema.required : [];
    const props = schema.properties || {};
    const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
    for (const k of req) {
      if (!isEmpty(out[k])) continue;
      const desc = String(props[k]?.description || '');
      if (!desc.includes('list_dynamic_enum_values')) continue; // free-text field → handled below
      const opts = await listEnumValues(toolName, k, '');
      if (opts.length === 1) { out[k] = opts[0].value; continue; }
      if (opts.length > 1) {
        const shown = opts.slice(0, 12);
        return {
          clarify:
            `Which **${k}** should I use for this? Reply with the number or name:\n` +
            shown.map((o, i) => `**${i + 1}. ${o.label || o.value}**`).join('\n'),
          args: out,
          options: shown,
          field: k,
        };
      }
    }
    const stillMissing = req.filter((k) => k !== 'output_hint' && isEmpty(out[k]));
    if (stillMissing.length) {
      return {
        clarify: `To run **${toolName}** I still need: ${stillMissing.map((k) => `**${k}**`).join(', ')}. Tell me the value(s) in your own words and I'll finish the action.`,
        args: out,
        field: stillMissing[0],
      };
    }
  } catch { /* schema unavailable — run as-is */ }

  return { args: out };
}

/** fixup → clarify-or-execute → remember facts. Central path for every Zapier action. */
async function runZapierPick(user, tool, args, originalText) {
  const fx = await fixupZapierArgs(tool, args);
  if (fx.clarify) {
    pendingClarify.set(user.id, {
      originalText,
      question: fx.clarify,
      at: Date.now(),
      tool,
      args: fx.args,
      options: fx.options || null,
      field: fx.field || null,
    });
    return clarifyEmbed(fx.clarify);
  }
  const label = fx.args.__pageLabel || null;
  const clean = { ...fx.args };
  delete clean.__pageLabel;
  const res = await executeZapierPick({ tool, args: clean });
  // remember the page that worked so "our Facebook page" needs no asking next time
  if (!res.isError && label && clean.page) setFact('facebookPage', { value: clean.page, label });
  if (!res.isError) addActivity('zapier', `${appLabel(tool.split('_')[0])} action: ${tool} — ${res.text.replace(/\s+/g, ' ').slice(0, 120)}`);
  return res.payload;
}

/* ------------------------------------------------------------------ */
/* Zapier MCP — stage-2 tool picker                                    */
/* ------------------------------------------------------------------ */

/** Build a compact catalog of the user's real Zapier tools for the LLM */
async function zapierCatalog() {
  const tools = await zapierListTools();
  return tools
    .filter((t) => !ZAPIER_INTERNAL.has(t.name))
    .map((t) => {
      const schema = t.inputSchema || {};
      const req = schema.required || [];
      const args = Object.keys(schema.properties || {})
        .map((p) => (req.includes(p) ? `${p}*` : p))
        .join(', ');
      const desc = String(t.description || '').split('\n')[0].replace(/\s+/g, ' ').slice(0, 140);
      return `- ${t.name} — ${desc}${args ? ` [args: ${args}]` : ''}`;
    })
    .join('\n');
}

/** Ask the LLM which Zapier tool to run + with what args. @returns {tool?, args?, clarify?} */
async function pickZapierTool(userText, user = null) {
  const catalog = await zapierCatalog();
  const savedPage = getFact('facebookPage');
  const savedProfile = getFact('agencyProfile');
  const factsLine =
    (savedPage?.value
      ? `Known workspace facts:\n- The user's Facebook Page is "${savedPage.label}" (id: ${savedPage.value}). When they say "our/my Facebook page", use this id as the page arg.\n`
      : '') +
    (savedProfile?.name
      ? `- The user's business: ${savedProfile.name} (${savedProfile.website || 'website unknown'}) — services: ${(savedProfile.services || []).join(', ')}. "our agency/our services" = this business.\n`
      : '');
  const instructions =
    `You route the user request to ONE tool on their Zapier MCP server.\n` +
    `Connected tools:\n${catalog}\n\n${factsLine ? factsLine + '\n' : ''}` +
    `RULES:\n` +
    `(1) Pick the single best tool and fill args strictly from the user's words. NEVER invent emails, names, domains, ids, phone numbers or numbers not present in the request or clearly implied by it.\n` +
    `(2) Only use clarify for missing HARD FACTS (recipient email/address, a record id) — never for wording you can write yourself. When the intent and topic are clear (e.g. "email X about our SEO services"), draft a short professional subject and body yourself directly in the args. For selector fields (page/account/sheet/stage), passing the user's own words is fine — the bot resolves them to real ids automatically. NEVER ask "which agency/business" if the facts above or the conversation already name it.\n` +
    `(2b) "email X about Y" means SEND it → gmail_send_email. Use gmail_create_draft ONLY when the user explicitly says draft/prepare/don't send yet.\n` +
    `(2c) facebook_pages_create_page_post: "message" must be the actual post text. If the request includes a topic, write a short engaging post yourself (emojis/hashtags where natural). If the request names NO topic or content at all (e.g. just "post on our Facebook page"), return the tool with message:"" — the bot will ask the user. Never put the raw request text in message, and never set "source" unless the user gave a real public image URL.\n` +
    `(3) For "who is / find / look up" requests prefer find/search tools.\n` +
    `(4) Destructive actions (delete/archive/trash) require the user to explicitly ask; otherwise clarify.\n` +
    `(5) If the message was meant as an answer to a previous clarification but is actually about something unrelated, reply {"abort":true}.\n` +
    `(6) Reply with ONLY a JSON object, no markdown:\n` +
    `{"tool":"<name>","args":{...}} or {"clarify":"..."} or {"abort":true}`;

  try {
    const raw = await complete([
      { role: 'assistant', content: instructions },
      { role: 'user', content: `${contextBlock(user)}REQUEST:\n${String(userText || '').slice(0, 1200)}` },
    ]);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('Tool selection returned no JSON');
    const parsed = JSON.parse(m[0]);
    return { tool: parsed.tool, args: parsed.args || {}, clarify: parsed.clarify, abort: parsed.abort };
  } catch (err) {
    console.error(`[zapier-pick] failed:`, err.message);
    throw err;
  }
}

/** Execute a routed action; returns a Discord reply payload or null (→ fall back to chat) */
export async function runAgent(text, user) {
  // 0a) Lead-outreach approval gate — "send" dispatches, feedback redrafts, "stop" cancels
  if (pendingLeadSend.has(user.id)) {
    const p = pendingLeadSend.get(user.id);
    const t = String(text || '').trim();
    if (Date.now() - p.at <= LEAD_TTL_MS && !looksLikeFreshCommand(t)) {
      pendingLeadSend.delete(user.id);
      if (/^(send|sned|sedn|send all|sned all|send them|send it|yes|yep|yeah|go|go ahead|approve|approved|dispatch|do it|ok|okay)\b/i.test(t)) {
        // Prefer DIRECT Gmail (free, no Zapier task cost) when configured; Zapier otherwise
        const sendVia = isGmailConfigured()
          ? async (d) => { try { await sendEmail(d.email, d.subject || 'Quick question', d.body); return { isError: false, text: 'sent via direct Gmail' }; } catch (err) { return { isError: true, text: friendlyError(err) }; } }
          : async (d) => zapierCallTool('gmail_send_email', { to: d.email, subject: d.subject || 'Quick question', body: d.body, output_hint: 'confirmation with the message id' });
        const results = [];
        for (const d of p.drafts.slice(0, MAX_LEADS)) {
          if (!d?.email || !d?.body) continue;
          try {
            const r = await sendVia(d);
            results.push(`${r.isError ? '❌' : '✅'} ${d.email}${r.isError ? ` — ${r.text.slice(0, 100)}` : ''}`);
          } catch (err) {
            results.push(`❌ ${d.email} — ${friendlyError(err).slice(0, 100)}`);
          }
          await sleep(1500); // gentle pace between sends
        }
        const sent = results.filter((r) => r.startsWith('✅')).length;
        addActivity('outreach', `${sent}/${p.drafts.length} outreach emails sent from Gmail to: ${p.drafts.map((d) => d.email).filter(Boolean).slice(0, 6).join(', ')}`);
        // Multi-intent follow-through: "send ... and save to hubspot ... and find more"
        const sendDesc = `**${sent}/${p.drafts.length}** emails sent from your Gmail:\n\n${results.join('\n')}\n\n📍 Watch your inbox for replies.`;
        const extra = [];
        if (/hubspot/i.test(t)) {
          const hs = await saveLeadsToHubspot(p.leads);
          extra.push({ name: `💾 HubSpot — ${hs.saved} saved`, value: hs.summary.slice(0, 1000) || 'done' });
        }
        const wantsMore = /\b(find|hunt|get|bring)\b[^.?!]{0,40}\bmore\b/i.test(t) || /more (leads|clients|prospects)/i.test(t);
        if (wantsMore) {
          try {
            const hunt = await leadHunt('find more clients for my agency', user);
            if (hunt?.embed) {
              hunt.embed.addFields({ name: '📤 Just dispatched', value: sendDesc.slice(0, 1000) }, ...extra);
              return { embed: hunt.embed };
            }
          } catch (err) {
            console.error('[agent:gate-hunt]', err.message);
            extra.push({ name: '🎯 Next hunt', value: 'The follow-up hunt hit a snag — say **find clients** to retry it.' });
          }
        }
        const reply = ok('📤 Outreach dispatched', sendDesc, sent ? OK_COLOR : 0xef4444);
        if (extra.length) reply.embed.addFields(...extra);
        else reply.embed.setDescription(sendDesc + '\n\n📍 Say **find clients** anytime for the next batch.');
        return reply;
      }
      if (/^(stop|cancel|no|nope|don't|dont|abort|forget it|not now|nevermind|never mind)\b/i.test(t)) {
        return ok('🛑 Outreach cancelled', 'No emails were sent. The leads are still in this conversation — say **send** if you change your mind, or "find clients" to restart the hunt.');
      }
      // otherwise treat the reply as feedback → redraft
      const drafts = await draftEmails(p.profile, p.leads, `The user reviewed the previous drafts and said: "${t.slice(0, 300)}". Apply this feedback strictly.`);
      if (drafts.length) {
        pendingLeadSend.set(user.id, { ...p, drafts, at: Date.now() });
        return leadPreviewEmbed(p.leads, drafts, p.profile);
      }
      pendingLeadSend.set(user.id, p); // keep alive for a retry
      return ok('✏️ Redraft failed', 'The writing model was busy — try again in a few seconds.', 0xef4444);
    }
    pendingLeadSend.delete(user.id); // expired or fresh command
  }

  // 0b) If I asked this user a clarifying question, treat their reply as the answer
  if (pendingClarify.has(user.id)) {
    const p = pendingClarify.get(user.id);
    pendingClarify.delete(user.id);
    if (Date.now() - p.at <= CLARIFY_TTL_MS && !looksLikeFreshCommand(text) && isMcpConfigured()) {
      try {
        if (p.tool) {
          // structured resume: I already know the tool + partial args
          if (Array.isArray(p.options) && p.options.length && p.field) {
            const chosen = matchOption(text, p.options);
            if (chosen) {
              const args = { ...(p.args || {}), [p.field]: chosen.value };
              if (p.field === 'page' && chosen.label) {
                args.__pageLabel = chosen.label;
                // the user explicitly picked this page — remember it immediately
                setFact('facebookPage', { value: chosen.value, label: chosen.label });
              }
              return await runZapierPick(user, p.tool, args, p.originalText);
            }
          }
          // free-text answer → merge it into the same tool call
          const merged =
            `CONTEXT — I am resuming an unfinished action.\n` +
            `Original request: "${p.originalText}"\n` +
            `Tool I chose: "${p.tool}"\n` +
            `Args so far: ${JSON.stringify(p.args || {}).slice(0, 700)}\n` +
            `Clarification I asked: "${p.question}"\n` +
            `The user's reply: "${text}"\n` +
            `Return the SAME tool with args updated using the reply. If a hard fact is still missing reply {"clarify":"..."}. If the reply is about something unrelated reply {"abort":true}.`;
          const pick = await pickZapierTool(merged);
          if (pick.tool) return await runZapierPick(user, pick.tool, pick.args, p.originalText);
          if (pick.clarify) {
            pendingClarify.set(user.id, { ...p, question: pick.clarify, at: Date.now() });
            return clarifyEmbed(pick.clarify);
          }
          // abort / no tool → user changed topic: fall through to normal routing
        } else {
          // legacy clarify from the pick phase (no tool chosen yet) — re-pick from merged text
          const merged =
            `Original request: "${p.originalText}"\n` +
            `Clarification I asked: "${p.question}"\n` +
            `The user's reply (use it to fill the missing arguments): "${text}"`;
          const pick = await pickZapierTool(merged);
          if (pick.clarify) {
            pendingClarify.set(user.id, { originalText: p.originalText, question: pick.clarify, at: Date.now() });
            return clarifyEmbed(pick.clarify);
          }
          if (pick.tool) return await runZapierPick(user, pick.tool, pick.args, p.originalText);
        }
      } catch (err) {
        console.error('[agent:clarify]', err); // fall through to normal routing
      }
    }
  }

  let intent;
  try {
    intent = await classify(text, user);
  } catch (err) {
    console.error('[agent] classify failed:', err.message);
    return null; // fall back to plain chat
  }

  const { action, params } = intent;
  console.log(`🧠 agent intent: ${action}`, JSON.stringify(params).slice(0, 120));

  try {
    switch (action) {
      case 'reminder.create': {
        const dueTs = await parseWhen(params.when || '');
        if (!dueTs) return ok('⏰ Couldn\u2019t understand that time', `I couldn't turn **"${params.when || '?'}"** into a date.\nTry like *"in 20 minutes"*, *"tomorrow 9am"*, or use /remind.`, 0xef4444);
        const r = addReminder({
          userId: user.id,
          username: user.username,
          channelId: user.channelId,
          guildName: user.guildName,
          text: params.what || user.rawText,
          dueTs,
        });
        addActivity('reminder', `Set reminder #${r.id}: "${String(r.text).slice(0, 80)}" (due ${fmtWhen(dueTs)})`);
        return ok('⏰ Reminder set!', `**#${r.id}** — ${r.text}\n🗓️ Due: **${fmtWhen(dueTs)}**\n\nI'll ping you here when it's time.`);
      }
      case 'reminder.list': {
        const list = listReminders(user.id);
        if (!list.length) return ok('⏰ No active reminders', 'You have zero upcoming reminders. Create one: *"remind me tomorrow at 8am to …"*');
        return ok('⏰ Your reminders', list.map((r) => `**#${r.id}** — ${r.text}\n　　🗓️ ${fmtWhen(r.dueTs)}`).join('\n\n'), INFO_COLOR);
      }
      case 'reminder.cancel': {
        const done = cancelReminder(user.id, parseInt(params.id));
        return done
          ? ok('🗑️ Reminder cancelled', `Reminder **#${params.id}** is gone.`)
          : ok('❌ Not found', `I couldn't find an active reminder **#${params.id}**. Use "my reminders" to list them.`, 0xef4444);
      }
      case 'note.add': {
        const n = addNote(user.id, params.text || '');
        addActivity('note', `Saved note #${n.id}: "${String(n.text).slice(0, 80)}"`);
        return ok('📝 Note saved!', `**#${n.id}** — ${n.text}\n\nAccess anytime: */notes*`);
      }
      case 'note.list': {
        const list = listNotes(user.id);
        if (!list.length) return ok('📝 No notes yet', 'Save your first one: *"note: my wifi password is 12345678"*');
        return ok('📝 Your notes', list.map((n) => `**#${n.id}** — ${n.text}`).join('\n\n'), INFO_COLOR);
      }
      case 'task.add': {
        const t = addTask(user.id, params.text || '');
        addActivity('task', `Added task #${t.id}: "${String(t.text).slice(0, 80)}"`);
        return ok('✅ Task added!', `**#${t.id}** — ${t.text}\n\nView all: */tasks*`);
      }
      case 'task.list': {
        const list = listTasks(user.id);
        if (!list.length) return ok('✅ No tasks yet', 'Add one: *"add task: finish the landing page"*');
        return ok(
          '✅ Your tasks',
          list.map((t) => `${t.done ? '☑️' : '⬜'} **#${t.id}** — ${t.text}${t.done ? ' _(done)_' : ''}`).join('\n'),
          INFO_COLOR
        );
      }
      case 'task.done': {
        const done = completeTask(user.id, parseInt(params.id));
        if (done) addActivity('task', `Completed task #${params.id}`);
        return done
          ? ok('🎉 Task completed!', `**#${params.id}** is done. Nice!`)
          : ok('❌ Not found', `No open task **#${params.id}**. Use "my tasks" to list them.`, 0xef4444);
      }
      case 'email.send': {
        if (!isGmailConfigured()) return ok('📧 Gmail not connected', 'Connect Gmail first (App Password setup), then I can send emails for you.', 0xef4444);
        const res = await sendEmail(params.to, params.subject, params.body);
        addActivity('email', `Sent direct email to ${params.to}: "${String(params.subject || '').slice(0, 80)}"`);
        return ok('📧 Email sent!', `To: **${params.to}**\nSubject: **${params.subject || '(none)'}**\n\n${res}`);
      }
      case 'email.inbox': {
        if (!isGmailConfigured()) return ok('📧 Gmail not connected', 'Connect Gmail first (App Password setup), then I can read your inbox.', 0xef4444);
        const msgs = await readInbox(params.query || '', 5);
        if (!msgs.length) return ok('📧 Inbox', 'No matching emails found.', INFO_COLOR);
        return ok('📧 Recent emails', msgs.map((m) => `**${m.subject}**\nfrom ${m.from}\n　${m.preview || '(no preview)…'}`).join('\n\n'), INFO_COLOR);
      }
      case 'zapier.list': {
        if (!isMcpConfigured()) return ok('⚡ Zapier not connected', 'Add ZAPIER_MCP_URL to the bot .env to enable Zapier actions.', 0xef4444);
        try {
          const tools = await zapierListTools();
          const groups = {};
          for (const t of tools) {
            if (ZAPIER_INTERNAL.has(t.name)) continue;
            const app = t.name.split('_')[0];
            groups[app] = (groups[app] || 0) + 1;
          }
          const lines = Object.entries(groups)
            .sort((a, b) => b[1] - a[1])
            .map(([a, n]) => `• **${appLabel(a)}** — ${n} action${n > 1 ? 's' : ''}`);
          return ok(
            '⚡ Zapier connected!',
            `**${tools.filter((t) => !ZAPIER_INTERNAL.has(t.name)).length} actions** available:\n${lines.join('\n')}\n\n` +
              `Just tell me what to do, e.g. *"email john@acme.com about the proposal"* or *"save this lead in Apollo"*, or use /zapier for details.`,
            INFO_COLOR
          );
        } catch (err) {
          return ok('❌ Zapier error', friendlyError(err), 0xef4444);
        }
      }
      case 'zapier': {
        if (!isMcpConfigured()) return ok('⚡ Zapier not connected', 'Add ZAPIER_MCP_URL to the bot .env to enable Zapier actions.', 0xef4444);
        try {
          const pick = await pickZapierTool(text, user);
          if (pick.abort) return null; // user changed topic → normal chat
          if (pick.clarify) {
            pendingClarify.set(user.id, { originalText: text, question: pick.clarify, at: Date.now() });
            return clarifyEmbed(pick.clarify);
          }
          if (!pick.tool) return null; // no tool matched → fall back to chat
          return await runZapierPick(user, pick.tool, pick.args, text);
        } catch (err) {
          console.error('[agent:zapier]', err);
          return ok('❌ Zapier error', friendlyError(err), 0xef4444);
        }
      }
      case 'hubspot.save': {
        if (!isMcpConfigured()) return ok('💾 HubSpot unavailable', 'Zapier must be connected to save contacts. Add ZAPIER_MCP_URL to the bot .env.', 0xef4444);
        try {
          const res = await saveLeadsToHubspot(collectLeads(user, intent.params));
          return res.embed;
        } catch (err) {
          console.error('[agent:hubspot]', err);
          return ok('❌ HubSpot save failed', friendlyError(err), 0xef4444);
        }
      }
      case 'lead.hunt': {
        try {
          return await leadHunt(text, user);
        } catch (err) {
          console.error('[agent:leadhunt]', err);
          return ok('❌ Lead hunt failed', friendlyError(err), 0xef4444);
        }
      }
      default:
        return null; // chat
    }
  } catch (err) {
    console.error(`[agent:${action}]`, err);
    return ok('❌ Action failed', friendlyError(err), 0xef4444);
  }
}

/** Internals exposed for testing (not used by the bot runtime) */
export const __test = { matchOption, phraseMatchesPage, listEnumValues, fixupZapierArgs, pickZapierTool, classify };
