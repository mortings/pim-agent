# PIM Agent Proxy

Thin Cloudflare Worker that lets the static demo at
[mortings.github.io/pim-agent](https://mortings.github.io/pim-agent/) call
the Bluestone PIM MCP server. The demo posts to this Worker; the Worker
forwards the call to your deployed MCP server using the standard
streamable-HTTP transport (JSON-RPC 2.0 over POST, with SSE responses
handled transparently).

## Deploy

```bash
cd worker
npm install -g wrangler   # if you don't have it
wrangler login

# Required secrets
wrangler secret put MCP_URL           # https URL of your MCP server
wrangler secret put SHARED_SECRET     # passphrase the demo will paste in Settings

# Optional — only if your MCP server requires auth
wrangler secret put MCP_AUTH_HEADER   # "HeaderName:HeaderValue", e.g. "Authorization:Bearer eyJ..."

wrangler deploy
```

Wrangler prints the deployed URL — something like
`https://pim-agent-proxy.<your-account>.workers.dev`.

## Configure the demo

Open the demo → Settings (gear icon) → **Backend**. Paste:

- **Worker URL** — the URL Wrangler printed
- **Shared Secret** — same passphrase you set above

Click **Save**. From then on, the **+ New Product** button (and the
chat command `create product …`) will hit the real Bluestone PIM via
this Worker.

## Endpoints

```
GET  /api/health           → { ok, mcpConfigured, authConfigured }
POST /api/create-product   → { success, result }
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

Point the demo's Worker URL setting at `http://localhost:8787` to test
without deploying.
