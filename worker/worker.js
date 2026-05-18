// PIM Agent Proxy — thin Cloudflare Worker that bridges the static demo at
// https://mortings.github.io/pim-agent/ to a deployed Bluestone PIM MCP server.
//
// Env (set as Worker secrets via `wrangler secret put ...`):
//   MCP_URL          — HTTPS URL of the MCP server (streamable HTTP transport)
//   MCP_AUTH_HEADER  — optional, "HeaderName:HeaderValue" sent to the MCP server
//                      e.g. "Authorization:Bearer eyJhbGciOi..."
//   SHARED_SECRET    — passphrase the demo must send in X-Demo-Secret
//
// Routes:
//   POST /api/create-product   { name, number?, categoryId? }
//   GET  /api/health           sanity check (no auth)

const ALLOWED_ORIGINS = [
  'https://mortings.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
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

    if (url.pathname === '/api/health') {
      return json({ ok: true, mcpConfigured: !!env.MCP_URL, authConfigured: !!env.SHARED_SECRET }, 200, cors);
    }

    if (url.pathname !== '/api/create-product') {
      return json({ error: 'Not found' }, 404, cors);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, cors);
    }

    // Auth gate
    const providedSecret = request.headers.get('X-Demo-Secret') || '';
    if (!env.SHARED_SECRET) {
      return json({ error: 'Worker is missing SHARED_SECRET. Run `wrangler secret put SHARED_SECRET`.' }, 500, cors);
    }
    if (!constantTimeEqual(providedSecret, env.SHARED_SECRET)) {
      return json({ error: 'Unauthorized' }, 401, cors);
    }

    if (!env.MCP_URL) {
      return json({ error: 'Worker is missing MCP_URL. Run `wrangler secret put MCP_URL`.' }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'Invalid JSON body' }, 400, cors);
    }

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
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Invoke an MCP tool over the streamable HTTP transport. The server may
// answer with either a JSON body or an SSE stream; we handle both.
async function callMcpTool(env, toolName, args) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  };
  if (env.MCP_AUTH_HEADER) {
    const colon = env.MCP_AUTH_HEADER.indexOf(':');
    if (colon > 0) {
      headers[env.MCP_AUTH_HEADER.slice(0, colon).trim()] = env.MCP_AUTH_HEADER.slice(colon + 1).trim();
    }
  }

  const requestBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args }
  };

  const res = await fetch(env.MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MCP server returned ${res.status}: ${errText.slice(0, 400)}`);
  }

  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  const rpc = ct.includes('text/event-stream') ? await readSseUntilResult(res) : await res.json();

  if (rpc.error) {
    const msg = rpc.error.message || JSON.stringify(rpc.error);
    throw new Error(`MCP error: ${msg}`);
  }
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
      const lines = event.split('\n');
      let data = '';
      for (const line of lines) {
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const json = JSON.parse(data);
        if (json.jsonrpc && (json.result !== undefined || json.error !== undefined)) return json;
      } catch (e) {
        // not JSON yet, keep buffering
      }
    }
  }
  throw new Error('MCP SSE stream ended without a JSON-RPC response');
}
