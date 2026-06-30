// PIM Agent Proxy — drop-in replacement for worker/worker.js in the
// pim-agent / labs.bluestonepim.com demo repo.
//
// What's new compared to the current Worker:
//   - Keeps `GET  /api/health` and `POST /api/create-product` exactly as before
//     (so the existing index.html demo keeps working).
//   - Adds `POST /api/mcp-call` — a generic JSON-RPC proxy that lets any
//     fit-for-purpose UI built with the bluestone-pim-ui skill invoke any
//     Bluestone MCP tool without redeploying the Worker.
//   - Adds `POST /api/mcp-list` — lightweight wrapper around MCP `tools/list`
//     so a UI can discover what tools the server actually exposes before
//     hardcoding tool names.
//
// Deploy:
//   cp this file over worker/worker.js
//   wrangler deploy
//
// No new secrets needed. The existing MCP_URL, SHARED_SECRET, and three
// Bluestone secrets cover everything.

const ALLOWED_ORIGINS = [
  'https://mortings.github.io',
  'https://labs.bluestonepim.com',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const cors = {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Demo-Secret',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    // ── Health (unchanged) ────────────────────────────────────────────────
    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        mcpConfigured: !!env.MCP_URL,
        authConfigured: !!env.SHARED_SECRET,
        bluestoneConfigured: !!(env.BLUESTONE_PAPI_KEY && env.BLUESTONE_MAPI_CLIENT_ID && env.BLUESTONE_MAPI_CLIENT_SECRET),
        webhookConfigured: !!env.WEBHOOK_SECRET,
        rulesStoreConfigured: !!env.RULES
      }, 200, cors);
    }

    // ── Webhook receiver (Bluestone PIM → AI Conversion Engine) ───────────
    // This is the URL you paste into a Bluestone webhook's delivery target.
    // Verified by the HMAC `x-bs-signature` header (WEBHOOK_SECRET) — NOT the
    // shared secret, since Bluestone doesn't send X-Demo-Secret. Must read the
    // RAW body before parsing so the signature is checked over the exact bytes.
    // Optional single-rule routing: /api/webhook?rule=<id> or /api/webhook/<id>.
    if (url.pathname === '/api/webhook' || url.pathname.startsWith('/api/webhook/')) {
      return handleWebhook(request, env, url, cors);
    }

    // ── Conversion rules store (browser console ↔ engine), KV-backed ──────
    // Uses the shared secret like the other browser routes. GET reads the saved
    // rules, PUT replaces them. The webhook receiver reads the same KV key.
    if (url.pathname === '/api/rules') {
      if (!env.SHARED_SECRET) return json({ error: 'Worker is missing SHARED_SECRET' }, 500, cors);
      if (!constantTimeEqual(request.headers.get('X-Demo-Secret') || '', env.SHARED_SECRET)) {
        return json({ error: 'Unauthorized' }, 401, cors);
      }
      if (!env.RULES) return json({ error: 'Worker is missing the RULES KV namespace binding' }, 500, cors);
      if (request.method === 'GET') {
        const stored = await env.RULES.get('rules');
        return json({ success: true, rules: stored ? JSON.parse(stored) : [] }, 200, cors);
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        let b; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400, cors); }
        const list = Array.isArray(b.rules) ? b.rules : [];
        await env.RULES.put('rules', JSON.stringify(list));
        return json({ success: true, count: list.length }, 200, cors);
      }
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    // Everything below requires the shared secret.
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
    if (!env.SHARED_SECRET) return json({ error: 'Worker is missing SHARED_SECRET' }, 500, cors);
    if (!constantTimeEqual(request.headers.get('X-Demo-Secret') || '', env.SHARED_SECRET)) {
      return json({ error: 'Unauthorized' }, 401, cors);
    }
    if (!env.MCP_URL) return json({ error: 'Worker is missing MCP_URL' }, 500, cors);
    if (!env.BLUESTONE_PAPI_KEY || !env.BLUESTONE_MAPI_CLIENT_ID || !env.BLUESTONE_MAPI_CLIENT_SECRET) {
      return json({ error: 'Worker is missing Bluestone credentials' }, 500, cors);
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return json({ error: 'Invalid JSON body' }, 400, cors); }

    // ── Generic tool call (new) ───────────────────────────────────────────
    // Body: { tool: string, args?: object }
    if (url.pathname === '/api/mcp-call') {
      const tool = (body.tool || '').trim();
      const args = (body.args && typeof body.args === 'object') ? body.args : {};
      if (!tool) return json({ error: 'tool is required' }, 400, cors);
      try {
        const result = await callMcpTool(env, tool, args);
        return json({ success: true, result }, 200, cors);
      } catch (e) {
        return json({ error: e.message || 'MCP call failed' }, 502, cors);
      }
    }

    // ── List available tools (new) ────────────────────────────────────────
    if (url.pathname === '/api/mcp-list') {
      try {
        const result = await callMcpRpc(env, 'tools/list', {});
        return json({ success: true, result }, 200, cors);
      } catch (e) {
        return json({ error: e.message || 'MCP tools/list failed' }, 502, cors);
      }
    }

    // ── Bluestone Public API (PAPI) proxy ─────────────────────────────────
    // Read-only passthrough to the Public API, used to resolve media asset
    // IDs (from get_product) into displayable image URLs — the MCP only
    // returns asset IDs, not URLs. Runs server-side so the PAPI key never
    // touches the browser, and from Cloudflare's egress (Bluestone's gateway
    // blocks unknown datacenter IPs). Body: { path, header?, base?, key? }.
    if (url.pathname === '/api/papi') {
      const papiPath = (body.path || '').trim();
      if (!papiPath) return json({ error: 'path is required' }, 400, cors);
      const papiBase = (body.base || 'https://api.test.bluestonepim.com').replace(/\/+$/, '');
      const headerName = (body.header || 'x-api-key').trim();
      const key = body.key || env.BLUESTONE_PAPI_KEY;
      if (!key) return json({ error: 'No PAPI key (set BLUESTONE_PAPI_KEY or pass key)' }, 500, cors);
      try {
        const res = await fetch(papiBase + papiPath, { headers: { [headerName]: key, 'Accept': 'application/json' } });
        const text = await res.text();
        return json({ success: true, status: res.status, contentType: res.headers.get('content-type') || '', body: text.slice(0, 60000) }, 200, cors);
      } catch (e) {
        return json({ error: e.message || 'PAPI request failed' }, 502, cors);
      }
    }

    // ── Legacy named route (unchanged) ────────────────────────────────────
    if (url.pathname === '/api/create-product') {
      const name = (body.name || '').trim();
      const number = (body.number || '').trim() || undefined;
      const categoryId = (body.categoryId || '').trim() || undefined;
      if (!name) return json({ error: 'name is required' }, 400, cors);
      try {
        const result = await callMcpTool(env, 'create_product', { name, number, categoryId });
        return json({ success: true, result }, 200, cors);
      } catch (e) {
        return json({ error: e.message || 'MCP call failed' }, 502, cors);
      }
    }

    return json({ error: 'Not found' }, 404, cors);
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function callMcpTool(env, toolName, args) {
  return callMcpRpc(env, 'tools/call', { name: toolName, arguments: args });
}

async function callMcpRpc(env, method, params) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'x-papi-key': env.BLUESTONE_PAPI_KEY,
    'x-mapi-client-id': env.BLUESTONE_MAPI_CLIENT_ID,
    'x-mapi-client-secret': env.BLUESTONE_MAPI_CLIENT_SECRET
  };
  const requestBody = { jsonrpc: '2.0', id: Date.now(), method, params };
  const res = await fetch(env.MCP_URL, { method: 'POST', headers, body: JSON.stringify(requestBody) });
  if (!res.ok) throw new Error('MCP returned ' + res.status + ': ' + (await res.text()).slice(0, 400));
  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  const rpc = ct.includes('text/event-stream') ? await readSseUntilResult(res) : await res.json();
  if (rpc.error) throw new Error('MCP error: ' + (rpc.error.message || JSON.stringify(rpc.error)));
  return rpc.result;
}

async function readSseUntilResult(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let data = '';
      for (const line of event.split('\n')) if (line.startsWith('data:')) data += line.slice(5).trim();
      if (!data) continue;
      try {
        const j = JSON.parse(data);
        if (j.jsonrpc && (j.result !== undefined || j.error !== undefined)) return j;
      } catch (e) { /* keep buffering */ }
    }
  }
  throw new Error('MCP SSE stream ended without a JSON-RPC response');
}

// ════════════════════════════════════════════════════════════════════════
//  AI CONVERSION ENGINE — webhook receiver
//  Bluestone fires a product-change webhook here → we read the product, apply
//  the saved conversion rules, and write the converted value(s) back.
// ════════════════════════════════════════════════════════════════════════

async function handleWebhook(request, env, url, cors) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

  // 1. Verify HMAC over the RAW body (do not parse-then-reserialize).
  const raw = await request.text();
  if (env.WEBHOOK_SECRET) {
    const got = (request.headers.get('x-bs-signature') || '').replace(/^sha256=/i, '').trim().toLowerCase();
    const want = await hmacHex(env.WEBHOOK_SECRET, raw);
    if (!got || !constantTimeEqual(got, want)) {
      console.warn('[webhook] ✗ signature mismatch (header ' + (got ? 'present' : 'MISSING') + ') — the Bluestone webhook secret must equal WEBHOOK_SECRET');
      return json({ error: 'Invalid x-bs-signature' }, 401, cors);
    }
    console.log('[webhook] ✓ signature verified');
  } else {
    console.log('[webhook] no WEBHOOK_SECRET set — accepting unsigned call');
  }
  // (If WEBHOOK_SECRET is unset the engine accepts unsigned calls — fine for a
  //  local test, but set it before pointing a real Bluestone webhook here.)

  let payload; try { payload = JSON.parse(raw); } catch (e) { return json({ error: 'Invalid JSON body' }, 400, cors); }

  // 2. Load the saved rules from KV.
  if (!env.RULES) return json({ error: 'RULES KV namespace not bound' }, 500, cors);
  let rules = [];
  try { const s = await env.RULES.get('rules'); if (s) rules = JSON.parse(s); } catch (e) {}
  rules = rules.filter(r => r && r.enabled);

  // Optional single-rule routing (so one Bluestone webhook can map to one rule).
  const ruleParam = url.searchParams.get('rule') ||
    (url.pathname.startsWith('/api/webhook/') ? url.pathname.slice('/api/webhook/'.length) : '');
  if (ruleParam) rules = rules.filter(r => r.id === ruleParam);

  // 3. Collect affected product IDs + which were created (for loop-safe maths).
  const events = Array.isArray(payload.events) ? payload.events : [];
  const ids = new Set(); const created = new Set();
  for (const ev of events) {
    const ch = (ev && ev.changes) ? ev.changes : ev;
    const et = ch && ch.eventType;
    const list = (ch && Array.isArray(ch.entityIds)) ? ch.entityIds : [];
    for (const id of list) { ids.add(id); if (et === 'PRODUCT_CREATED') created.add(id); }
  }

  console.log('[webhook] received ' + events.length + ' event group(s); products: ' + JSON.stringify([...ids]) + '; enabled rules: ' + rules.length);

  // 4. Process. Return 2xx only after the work is accepted.
  const processed = [];
  for (const id of ids) {
    try {
      const applied = await processProduct(env, id, rules, created.has(id));
      console.log('[webhook] product ' + id + ' → ' + JSON.stringify(applied));
      processed.push({ id, applied });
    } catch (e) {
      console.warn('[webhook] product ' + id + ' error: ' + e.message);
      processed.push({ id, error: e.message });
    }
  }
  return json({ success: true, count: processed.length, processed }, 200, cors);
}

async function processProduct(env, productId, rules, isCreate) {
  const prod = extractAttributes(extractText(await callMcpTool(env, 'get_product', { productId })));
  console.log('[webhook] product ' + productId + ' attributes: ' + JSON.stringify(prod.attrs.map(a => a.name)));
  const applied = [];
  let defCache = null; // lazy list_attribute_definitions for target resolution

  for (const rule of rules) {
    const src = findAttr(prod, rule.source);
    if (!src) continue;
    const current = src.value == null ? '' : String(src.value);

    const inPlace = !rule.target || rule.target === rule.source;
    // Loop guard: in-place maths is not idempotent, so only run it on create.
    if (rule.type === 'math' && inPlace && !isCreate) { applied.push({ rule: rule.name, skipped: 'in-place math runs on create only' }); continue; }

    const next = applyRule(current, rule);

    let targetDefId = src.definitionId, targetName = rule.source, targetCurrent = current;
    if (!inPlace) {
      const tgt = findAttr(prod, rule.target);
      if (tgt) { targetDefId = tgt.definitionId; targetName = rule.target; targetCurrent = tgt.value == null ? '' : String(tgt.value); }
      else {
        if (!defCache) defCache = extractDefinitions(extractText(await callMcpTool(env, 'list_attribute_definitions', {})));
        const def = defCache.find(d => eqName(d.name, rule.target));
        if (!def) { applied.push({ rule: rule.name, skipped: 'target attribute "' + rule.target + '" not found' }); continue; }
        targetDefId = def.definitionId; targetName = rule.target; targetCurrent = '';
      }
    }

    // Loop guard: never write a value that's already there (also keeps the
    // write idempotent so the resulting attribute event is a server-side no-op).
    if (String(next) === String(targetCurrent)) { applied.push({ rule: rule.name, skipped: 'no change' }); continue; }
    if (!targetDefId) { applied.push({ rule: rule.name, skipped: 'no definitionId for target' }); continue; }

    await callMcpTool(env, 'set_product_attribute', { productId, definitionId: targetDefId, values: [String(next)], attributeName: targetName });
    applied.push({ rule: rule.name, attribute: targetName, from: current, to: next });
  }
  return applied;
}

async function hmacHex(secret, raw) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── MCP result → product attributes ──────────────────────────────────────
// get_product returns { content:[{type:'text', text:'…'}] }. The text is JSON.
// Bluestone's exact attribute shape can vary, so this probes the common keys
// (name/attributeName, definitionId/id, values/value). Verify against your
// tenant's get_product payload and tweak the key names if needed.
function extractText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) {
    return result.content.filter(c => c && c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
  }
  try { return JSON.stringify(result); } catch (e) { return ''; }
}
function safeParse(text) { try { return JSON.parse(text); } catch (e) { return null; } }
function extractAttributes(text) {
  const data = safeParse(text);
  const out = { attrs: [] };
  if (!data) return out;
  const root = data.product || data.data || data;
  const arr = root.attributes || root.attributeValues || root.metadata || [];
  const list = Array.isArray(arr) ? arr : [];
  out.attrs = list.map(a => normalizeAttr(a)).filter(Boolean);
  return out;
}
function normalizeAttr(a) {
  if (!a || typeof a !== 'object') return null;
  const name = a.name || a.attributeName || a.key || a.code || (a.definition && a.definition.name) || '';
  const definitionId = a.definitionId || a.id || a.attributeId || (a.definition && a.definition.id) || '';
  let value;
  if (Array.isArray(a.values)) value = a.values[0];
  else if (a.value !== undefined) value = (Array.isArray(a.value) ? a.value[0] : a.value);
  else if (a.values !== undefined) value = a.values;
  if (value && typeof value === 'object') value = value.value ?? value.text ?? value.label ?? JSON.stringify(value);
  return { name, definitionId, value };
}
function extractDefinitions(text) {
  const data = safeParse(text);
  const arr = Array.isArray(data) ? data : (data && (data.definitions || data.attributes || data.data)) || [];
  return (Array.isArray(arr) ? arr : []).map(d => ({ name: d.name || d.label || '', definitionId: d.id || d.definitionId || '' })).filter(d => d.definitionId);
}
function eqName(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function findAttr(prod, nameOrId) {
  const q = String(nameOrId || '').trim().toLowerCase();
  return prod.attrs.find(a => eqName(a.name, q) || String(a.definitionId).toLowerCase() === q) || null;
}

// ════════════════════════════════════════════════════════════════════════
//  TRANSFORM ENGINE — keep identical to the applyRule() in conversion-rules.html
// ════════════════════════════════════════════════════════════════════════
const UNITS = {
  mm:{dim:'length',f:1,sym:'mm'}, cm:{dim:'length',f:10,sym:'cm'}, m:{dim:'length',f:1000,sym:'m'}, km:{dim:'length',f:1000000,sym:'km'},
  in:{dim:'length',f:25.4,sym:'in'}, ft:{dim:'length',f:304.8,sym:'ft'}, yd:{dim:'length',f:914.4,sym:'yd'}, mi:{dim:'length',f:1609344,sym:'mi'},
  g:{dim:'mass',f:1,sym:'g'}, kg:{dim:'mass',f:1000,sym:'kg'}, oz:{dim:'mass',f:28.349523125,sym:'oz'}, lb:{dim:'mass',f:453.59237,sym:'lb'},
  ml:{dim:'volume',f:1,sym:'ml'}, l:{dim:'volume',f:1000,sym:'l'}, floz:{dim:'volume',f:29.5735,sym:'fl oz'}, gal:{dim:'volume',f:3785.41,sym:'gal'},
  C:{dim:'temp',sym:'°C'}, F:{dim:'temp',sym:'°F'}, K:{dim:'temp',sym:'K'}
};
function convertUnit(num, from, to) {
  const a = UNITS[from], b = UNITS[to];
  if (!a || !b || a.dim !== b.dim) return null;
  if (a.dim === 'temp') {
    let c = from === 'C' ? num : from === 'F' ? (num - 32) * 5 / 9 : num - 273.15;
    return to === 'C' ? c : to === 'F' ? (c * 9 / 5 + 32) : (c + 273.15);
  }
  return num * a.f / b.f;
}
function roundTo(n, d) { const f = Math.pow(10, d == null ? 2 : d); return Math.round((n + Number.EPSILON) * f) / f; }
function firstNumber(s) { const m = String(s).match(/-?\d+(?:[.,]\d+)?/); return m ? parseFloat(m[0].replace(',', '.')) : null; }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function evalMath(expr, x) {
  if (!/^[-+*/().,\sxX0-9]+$/.test(expr || '')) return NaN;
  try { return Function('x', '"use strict";return (' + String(expr).replace(/X/g, 'x').replace(/,/g, '.') + ')')(x); } catch (e) { return NaN; }
}
function applyRule(value, rule) {
  const v = value == null ? '' : String(value);
  try {
    if (rule.type === 'unit') {
      const num = firstNumber(v); if (num == null) return v;
      const out = convertUnit(num, rule.fromUnit, rule.toUnit); if (out == null) return v;
      const s = String(roundTo(out, rule.decimals));
      return rule.appendUnit ? s + ' ' + ((UNITS[rule.toUnit] || {}).sym || '') : s;
    }
    if (rule.type === 'math') {
      const num = firstNumber(v); if (num == null) return v;
      const out = evalMath(rule.expression, num);
      if (out == null || isNaN(out) || !isFinite(out)) return v;
      return String(roundTo(out, rule.decimals));
    }
    if (rule.type === 'replace') {
      if (rule.mode === 'whole') {
        const eq = rule.caseSensitive ? v === rule.find : v.toLowerCase() === String(rule.find || '').toLowerCase();
        return eq ? (rule.replace || '') : v;
      }
      if (!rule.find) return v;
      return v.replace(new RegExp(escapeRe(rule.find), rule.caseSensitive ? 'g' : 'gi'), rule.replace || '');
    }
    if (rule.type === 'advanced') {
      switch (rule.op) {
        case 'uppercase': return v.toUpperCase();
        case 'lowercase': return v.toLowerCase();
        case 'titlecase': return v.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
        case 'trim': return v.trim().replace(/\s+/g, ' ');
        case 'prefix': return (rule.text || '') + v;
        case 'suffix': return v + (rule.text || '');
        case 'regex': return v.replace(new RegExp(rule.pattern || '', rule.flags || 'g'), rule.replace || '');
        case 'lookup': {
          const hit = (rule.lookup || []).find(p => rule.caseSensitive ? p.from === v : String(p.from).toLowerCase() === v.toLowerCase());
          return hit ? hit.to : v;
        }
      }
    }
  } catch (e) { return v; }
  return v;
}
