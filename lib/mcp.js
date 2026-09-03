// lib/mcp.js — minimal MCP (Model Context Protocol) client over streamable HTTP.
// Connects the bot to the user's Zapier MCP server so Discord can drive
// Apollo / HubSpot / Gmail / Facebook Pages / GA4 actions.
//
// Requires ZAPIER_MCP_URL in .env (the full mcp.zapier.com URL incl. token).

const PROTOCOL_VERSION = '2025-03-26';
const REQUEST_TIMEOUT_MS = 90_000;

let url = null;
let sessionId = null;
let initialized = false;
let connecting = null; // in-flight connect promise (avoid double init)
let toolsCache = null;
let toolsCacheAt = 0;
const TOOLS_TTL_MS = 10 * 60 * 1000;
let reqId = 0;

/** Simple lock so we never interleave two requests on one session */
let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

export function isMcpConfigured() {
  if (url === null) url = (process.env.ZAPIER_MCP_URL || '').trim() || null;
  return Boolean(url);
}

function parseSseOrJson(text) {
  // Streamable HTTP servers reply either with plain JSON or SSE frames.
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const msgs = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (l.startsWith('data:')) {
      const payload = l.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try { msgs.push(JSON.parse(payload)); } catch { /* skip bad frame */ }
      }
    }
  }
  return msgs.find((m) => m && (m.result || m.error)) || null;
}

async function post(body, { expectResponse = true } = {}) {
  if (!isMcpConfigured()) throw new Error('Zapier MCP is not configured.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (res.headers.get('mcp-session-id')) sessionId = res.headers.get('mcp-session-id');

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      const e = new Error(`MCP HTTP ${res.status}: ${errText.slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }

    if (!expectResponse) return null;
    const text = await res.text();
    if (!text.trim()) return null; // 202-style empty ack
    return parseSseOrJson(text);
  } finally {
    clearTimeout(timer);
  }
}

async function handshake() {
  sessionId = null;
  initialized = false;
  const res = await post({
    jsonrpc: '2.0',
    id: ++reqId,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'zai-discord-agent', version: '1.0.0' },
    },
  });
  if (!res || res.error) throw new Error(res?.error?.message || 'MCP initialize failed');
  // notification — server replies 202 empty
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { expectResponse: false });
  initialized = true;
  return res.result?.serverInfo || { name: 'zapier' };
}

async function ensureConnected() {
  if (!isMcpConfigured()) throw new Error('Zapier MCP is not configured (missing ZAPIER_MCP_URL).');
  if (initialized) return;
  if (!connecting) {
    connecting = handshake()
      .then((info) => {
        console.log(`🔌 Zapier MCP connected — server: ${info.name} v${info.version || '?'}`);
        return info;
      })
      .finally(() => { connecting = null; });
  }
  return connecting;
}

async function rpc(method, params) {
  return serialized(async () => {
    await ensureConnected();
    const id = ++reqId;
    try {
      const res = await post({ jsonrpc: '2.0', id, method, params });
      if (!res) throw new Error('MCP returned no response');
      if (res.error) {
        const e = new Error(res.error.message || 'MCP call failed');
        e.mcpCode = res.error.code;
        throw e;
      }
      return res.result;
    } catch (err) {
      // Session likely expired → re-handshake once and retry
      if (err.status === 404 || err.status === 400 || /session/i.test(err.message)) {
        console.warn('[mcp] session lost — reconnecting once…');
        await handshake();
        const res = await post({ jsonrpc: '2.0', id: ++reqId, method, params });
        if (!res || res.error) throw new Error(res?.error?.message || 'MCP call failed after reconnect');
        return res.result;
      }
      throw err;
    }
  });
}

/* ---------------- public API ---------------- */

export async function zapierServerInfo() {
  await ensureConnected();
  return { connected: true, url: url };
}

export async function zapierListTools(force = false) {
  if (!force && toolsCache && Date.now() - toolsCacheAt < TOOLS_TTL_MS) return toolsCache;
  const result = await rpc('tools/list', {});
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  toolsCache = tools;
  toolsCacheAt = Date.now();
  return tools;
}

/** Extract readable text from a tools/call result */
export function toolResultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts = [];
  for (const c of content) {
    if (c?.type === 'text' && c.text) parts.push(c.text);
    else if (c?.type === 'resource_link' && c.uri) parts.push(`${c.title || c.name || ''} ${c.uri}`.trim());
    else if (c?.type === 'resource' && c.resource?.text) parts.push(c.resource.text);
  }
  if (result?.isError && parts.length) return `⚠️ ${parts.join('\n')}`;
  return parts.join('\n').trim();
}

/** Coerce LLM-provided args to match the tool's schema (e.g. string → [string] for array fields) */
function coerceArgs(tool, args) {
  const props = tool?.inputSchema?.properties || {};
  const out = { ...args };
  for (const [key, val] of Object.entries(out)) {
    const prop = props[key];
    if (!prop || Array.isArray(val)) continue;
    const types = new Set();
    if (prop.type) types.add(prop.type);
    if (Array.isArray(prop.anyOf)) for (const s of prop.anyOf) if (s?.type) types.add(s.type);
    if (types.has('array')) {
      if (typeof val === 'string') out[key] = val.split(',').map((s) => s.trim()).filter(Boolean);
      else out[key] = [val];
    }
  }
  return out;
}

export async function zapierCallTool(toolName, args = {}) {
  // auto-fix arg types against the tool's real schema before calling
  let finalArgs = args;
  try {
    const tools = await zapierListTools();
    const tool = tools.find((t) => t.name === toolName);
    if (tool) finalArgs = coerceArgs(tool, args);
  } catch { /* schema unavailable — call with raw args */ }
  const result = await rpc('tools/call', { name: toolName, arguments: finalArgs });
  return {
    isError: Boolean(result?.isError),
    text: toolResultText(result) || '(no output returned)',
  };
}

/** The URL where the user manages their Zapier MCP actions */
export async function zapierConfigUrl() {
  const tools = await zapierListTools();
  const cfg = tools.find((t) => t.name === 'get_configuration_url');
  if (!cfg) return null;
  const r = await zapierCallTool('get_configuration_url', {});
  const m = r.text.match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[)\].]+$/, '') : null;
}
