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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
        bluestoneConfigured: !!(env.BLUESTONE_PAPI_KEY && env.BLUESTONE_MAPI_CLIENT_ID && env.BLUESTONE_MAPI_CLIENT_SECRET)
      }, 200, cors);
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
