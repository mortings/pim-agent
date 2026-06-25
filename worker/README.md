# PIM Agent Proxy

Thin Cloudflare Worker that lets the static demo at
[mortings.github.io/pim-agent](https://mortings.github.io/pim-agent/) call
the Bluestone PIM MCP server (e.g. `https://bluestone-mcp-unofficial.vercel.app/mcp`).
The demo posts to this Worker with a shared-secret header; the Worker
forwards the call to the MCP server using its three Bluestone auth
headers (`x-papi-key`, `x-mapi-client-id`, `x-mapi-client-secret`),
which never leave the server.

## Why a proxy?

The MCP server requires real Bluestone PIM credentials and doesn't send
CORS headers, so a browser can't call it directly. Embedding those
credentials in the demo's JavaScript would expose them to anyone with
DevTools. The Worker holds them as Cloudflare secrets and only forwards
calls signed with a demo passphrase.

## Deploy

```bash
cd worker
npm install -g wrangler   # if you don't have it
wrangler login

# Required secrets — wrangler will prompt for each value
wrangler secret put MCP_URL                       # e.g. https://bluestone-mcp-unofficial.vercel.app/mcp
wrangler secret put SHARED_SECRET                 # pick a passphrase; you'll paste it into the demo
wrangler secret put BLUESTONE_PAPI_KEY            # your Bluestone PAPI key
wrangler secret put BLUESTONE_MAPI_CLIENT_ID      # your Bluestone MAPI client id
wrangler secret put BLUESTONE_MAPI_CLIENT_SECRET  # your Bluestone MAPI client secret
wrangler secret put WEBHOOK_SECRET                # AI Conversion Engine only: the Bluestone webhook's signing secret

# AI Conversion Engine only — rules store (skip if not using conversion-rules.html):
wrangler kv namespace create RULES                # then uncomment [[kv_namespaces]] in wrangler.toml and paste the printed id

wrangler deploy
```

Wrangler prints the deployed URL — something like
`https://pim-agent-proxy.<your-account>.workers.dev`. That URL **must match**
the Worker URL in the demo's Settings. If `wrangler whoami` shows a different
account than the one hosting your live Worker, `wrangler deploy` lands on a
*different* Worker and the live one never changes — the usual reason a deploy
"succeeds" but `/api/health` still shows the old fields.

## Configure the demo

Open the demo → Settings (gear icon) → **Backend (Bluestone PIM MCP)**:

- **Worker URL** — the URL Wrangler printed
- **Shared Secret** — the same passphrase you set above

Click **Test** to verify (should turn green), then **Save**. After that, the
**+ New Product** button in the Data Viewer writes to the real Bluestone
PIM via this Worker.

## Endpoints

```
GET     /api/health         → { ok, mcpConfigured, authConfigured, bluestoneConfigured, webhookConfigured, rulesStoreConfigured }
POST    /api/create-product → { success, result }
POST    /api/mcp-call       → generic MCP tools/call: { tool, args }
POST    /api/mcp-list       → MCP tools/list
POST    /api/papi           → read-only Bluestone PAPI passthrough
POST    /api/webhook        → AI Conversion Engine receiver (Bluestone webhook target; verifies x-bs-signature)
GET/PUT /api/rules          → AI Conversion Engine rules store (KV-backed)
```

`POST /api/create-product` body:

```json
{ "name": "Product Name", "number": "OPTIONAL-SKU", "categoryId": "OPTIONAL-PIM-CATEGORY-ID" }
```

Headers:

- `Content-Type: application/json`
- `X-Demo-Secret: <SHARED_SECRET>`

## CORS

The Worker accepts requests from `https://mortings.github.io` and from
`localhost`/`127.0.0.1` on common dev ports. To allow another origin,
edit `ALLOWED_ORIGINS` at the top of `worker.js`.

## Local development

```bash
wrangler dev    # serves on http://localhost:8787
```

Point the demo's Worker URL at `http://localhost:8787` to test without deploying.
