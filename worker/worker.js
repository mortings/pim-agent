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
  try { const s = await env.RULES.get('rules'); if (s) rules = JSON.parse(s); }
  catch (e) { console.warn('[webhook] KV read/parse error: ' + e.message); }
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
  // get_product returns a summary line + the product JSON. attributes are
  // [{ definitionId, values:[...] }] — identified by id, not name.
  const product = parseMcpJson(extractText(await callMcpTool(env, 'get_product', { productId })));
  if (!product) return [{ skipped: 'could not parse get_product response' }];
  const attrs = Array.isArray(product.attributes) ? product.attributes : [];
  const valOf = (defId) => { const a = attrs.find(x => x.definitionId === defId); return (a && Array.isArray(a.values) && a.values.length) ? String(a.values[0]) : ''; };

  let defsMap = null; // definitionId/name/number map, fetched once per product
  const applied = [];
  for (const rule of rules) {
    if (!defsMap) defsMap = await getDefsMap(env);
    const srcDef = resolveDef(defsMap, rule.source);
    if (!srcDef) { applied.push({ rule: rule.name, skipped: 'source "' + rule.source + '" not in data model' }); continue; }
    const current = valOf(srcDef.id);
    if (current === '') { applied.push({ rule: rule.name, skipped: 'source attr "' + (srcDef.name || rule.source) + '" empty on this product' }); continue; }

    const inPlace = !rule.target || rule.target === rule.source;
    // Loop guard: in-place maths is not idempotent, so only run it on create.
    if (rule.type === 'math' && inPlace && !isCreate) { applied.push({ rule: rule.name, skipped: 'in-place math runs on create only' }); continue; }

    const next = applyRule(current, rule);
    const targetDef = inPlace ? srcDef : resolveDef(defsMap, rule.target);
    if (!targetDef) { applied.push({ rule: rule.name, skipped: 'target "' + rule.target + '" not in data model' }); continue; }

    // Loop guard: never re-write a value that's already there (keeps the write
    // idempotent, so the resulting attribute event is a server-side no-op).
    if (String(next) === valOf(targetDef.id)) { applied.push({ rule: rule.name, skipped: 'no change (already ' + next + ')' }); continue; }

    // The MCP's set_product_attribute uses add-semantics (409s on an attribute
    // that already exists), so update the value directly via the MAPI PUT.
    try {
      const status = await mapiUpdateAttribute(env, productId, targetDef.id, [String(next)], product.context);
      applied.push({ rule: rule.name, attribute: targetDef.name, from: current, to: next, status });
    } catch (e) {
      applied.push({ rule: rule.name, attribute: targetDef.name, from: current, to: next, writeError: e.message });
    }
  }
  return applied;
}

async function hmacHex(secret, raw) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(raw));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Bluestone MAPI direct write (OAuth2 client-credentials) ───────────────
// The MCP's set_product_attribute uses add-semantics and 409s on an attribute
// that already exists on the product, so value UPDATES go straight to the
// Management API's PUT /products/{id}/attributes/{definitionId} (returns 204).
let _mapiToken = null; // { token, exp } cached per isolate
async function getMapiToken(env) {
  if (_mapiToken && _mapiToken.exp > Date.now() + 5000) return _mapiToken.token;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.BLUESTONE_MAPI_CLIENT_ID,
    client_secret: env.BLUESTONE_MAPI_CLIENT_SECRET,
    scope: 'openid profile systemRoles permissions organization email name nickname'
  });
  const r = await fetch('https://idp.test.bluestonepim.com/op/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  });
  const txt = await r.text();
  if (!r.ok) throw new Error('token ' + r.status + ': ' + txt.slice(0, 160));
  const j = JSON.parse(txt);
  _mapiToken = { token: j.access_token, exp: Date.now() + (j.expires_in ? j.expires_in * 1000 : 300000) };
  return _mapiToken.token;
}
async function mapiUpdateAttribute(env, productId, definitionId, values, context) {
  const token = await getMapiToken(env);
  const url = 'https://api.test.bluestonepim.com/pim/products/' + productId + '/attributes/' + definitionId;
  const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
  if (context) headers['context'] = context;
  const r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ values }) });
  if (r.status === 204 || r.ok) return r.status;
  throw new Error('PUT ' + r.status + ': ' + (await r.text()).slice(0, 160));
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
// MCP tools return "<summary sentence>\n\n<JSON>". Grab the JSON body.
function parseMcpJson(text) {
  const i = text.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i)); } catch (e) { return null; }
}
// Build { lowercased name|number -> { id, name, dataType } } from the data model.
async function getDefsMap(env) {
  const dj = parseMcpJson(extractText(await callMcpTool(env, 'list_attribute_definitions', {})));
  const list = (dj && Array.isArray(dj.definitions)) ? dj.definitions : [];
  const map = {};
  for (const d of list) {
    const def = { id: d.id, name: d.name || d.number || '', dataType: d.dataType };
    if (d.name) map[String(d.name).trim().toLowerCase()] = def;
    if (d.number) map[String(d.number).trim().toLowerCase()] = def;
  }
  return map;
}
// Resolve a rule's attribute label to a definition. Tolerates the UI's
// "Name [unit]" format and matches by display name or machine number.
function resolveDef(map, source) {
  if (!source) return null;
  const s = String(source).trim().toLowerCase();
  if (map[s]) return map[s];
  const stripped = s.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  if (map[stripped]) return map[stripped];
  for (const k in map) { if (k && (s.startsWith(k) || stripped === k)) return map[k]; }
  return null;
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
// Safe arithmetic evaluator — NO eval/Function (Cloudflare Workers blocks
// dynamic code generation). Supports numbers, x, + - * / and parentheses.
function evalMath(expr, x) {
  if (!/^[-+*/().,\sxX0-9]+$/.test(expr || '')) return NaN;
  const toks = String(expr).replace(/X/g, 'x').replace(/,/g, '.').match(/\d+\.?\d*|\.\d+|[x()+\-*/]/g);
  if (!toks) return NaN;
  let i = 0; const peek = () => toks[i], eat = () => toks[i++];
  function expr_() { let v = term(); while (peek() === '+' || peek() === '-') { const o = eat(), r = term(); v = o === '+' ? v + r : v - r; } return v; }
  function term() { let v = fac(); while (peek() === '*' || peek() === '/') { const o = eat(), r = fac(); v = o === '*' ? v * r : v / r; } return v; }
  function fac() { const t = peek(); if (t === '+') { eat(); return fac(); } if (t === '-') { eat(); return -fac(); } if (t === '(') { eat(); const v = expr_(); if (peek() === ')') eat(); return v; } if (t === 'x') { eat(); return x; } eat(); return parseFloat(t); }
  try { const v = expr_(); return (i === toks.length && isFinite(v)) ? v : NaN; } catch (e) { return NaN; }
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
