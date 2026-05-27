---
description: Build a new fit-for-purpose Bluestone PIM UI end-to-end in one shot (Gartner-demo mode). Optional arg = persona, e.g. "merchandiser quick-edit", "store associate lookup", "agentic command bar".
---

# Build a fit-for-purpose Bluestone PIM UI — Gartner demo mode

I am running a live Gartner analyst demo right now. After I hit Enter on this command I will switch back to the analyst and continue presenting. You have **~10–15 minutes of wall clock** to ship a working, committed, deployed fit-for-purpose UI **without asking me anything**. By the end of our demo I will return to show the analyst what you built.

This means: pick defaults, lift heavily from prior work, ship one thing well rather than three things half-done.

## Persona

$ARGUMENTS

If no persona is specified above (i.e. you see literally `$ARGUMENTS` or an empty line), default to **Merchandiser quick-edit** — table view of one category with inline price/stock/label editing. Reason: this repo already has the scorecard (`pm-shoes.html`), the supplier portal (`supplier-intake.html`), and the chat-driven AI PIM (`index.html`). A grid-shaped merchandiser UI gives the strongest visual contrast for the "same backend, different UI per role" story.

## Reference — read this BEFORE writing anything

`pm-shoes.html` in this repo is the gold-standard reference. It has every production pattern figured out from a previous session. **Lift code freely.** Specifically reuse:

- The Settings modal + `mcpCall(tool, args)` helper + defensive `addEventListener` rewiring
- Catalog auto-discovery via `list_catalogs` + a Catalog dropdown that updates ALL labels (page title, header crumb, KPI tile captions) when changed
- Defensive MCP JSON parsing: prose-preamble + JSON object, with `parseMcpJson()` trying `structuredContent`, `content[].json`, then regex `/[\{\[][\s\S]*[\}\]]/` + JSON.parse
- Score field-name fallbacks (different MCP servers use different names): `completenessScore | score | completeness?.score | percentage`
- Server-side filter pills — do NOT pass `completenessScoreMin/Max` for the "All" filter (it excludes products with no scores)
- The drawer's save flow: **optimistic** score update from requirement counts → close drawer → **background** polling of `list_product_completeness_scores` with exponential backoff (1s → 6s, ~21s total) → silent correction toast if Bluestone's eventual score differs from optimistic
- Fixable vs unfixable bucketing: `!!definitionId && !/MEDIA/i.test(type)` (NOT exact type-string match — the actual MCP doesn't return `ATTRIBUTE_HAS_VALUE`)
- The pulsing blue dot pattern for "Bluestone verifying" indicator
- The pre-filled Worker URL + auto-open Settings on first load + focus-the-secret-field UX

## Hard rules (NON-NEGOTIABLE)

- **No `AskUserQuestion` calls. No `ExitPlanMode`.** Pick defaults and write code.
- **Worker URL is `https://pim-agent-proxy.mortings.workers.dev`** — bake as the localStorage default. (Public per skill rules.)
- **Shared secret stays out of source.** It's already in my browser's localStorage on the GitHub Pages origin; it'll work for the live deployed URL. If you preview locally, use port **8000** — it's in the Worker's CORS allow-list. **8765 is NOT.**
- **Single self-contained HTML file**, same shape as the existing demos. No build step, no framework.

## Workflow

1. **Invoke the `bluestone-pim-ui` skill** so its references are available. Then read in this order:
   - The skill's `references/persona-recipes.md` (just the recipe section for the persona you chose)
   - The skill's `references/mcp-tools.md` (Recipe-to-tool mapping for that recipe)
   - `pm-shoes.html` in this repo (the entire file — every fix lives here)
2. Decide on file name: lowercase-hyphen, e.g. `merchandiser-grid.html`, `store-associate.html`, `command-bar.html`.
3. Write the new file. Copy the Settings + MCP wiring + visual primitives wholesale from `pm-shoes.html`; replace the persona-specific `<main>` content and the persona-specific bits of the script.
4. **Verify it works.** Start a preview on port 8000 (`launch.json` already exists with that port). Use the preview tools to click through the hero flow end-to-end against real PIM data. If you see "Failed to fetch" the port is wrong; if you see "Unauthorized" the secret isn't carried — both are recoverable, log and continue.
5. Update `demos.html` — add a 4th card linking to the new file. Use a non-clashing accent color (the existing three use blue / green / purple — try `--orange` or `--yellow`). Match the existing card structure exactly.
6. Commit and push to `main` in two clean commits:
   - "Add [persona] demo built with the bluestone-pim-ui skill"
   - "Update demos.html landing page with [persona] card"
7. GitHub Pages auto-deploys from main; takes ~30–90 seconds. By the time I'm back you can give me the deployed URL.

## Final message format

When done, reply to me with EXACTLY this shape — nothing else:

```
✓ Shipped: <file-name>.html
Live: https://mortings.github.io/pim-agent/<file-name>.html
Persona: <one sentence>
Show the analyst: <one-sentence demo script — what to click, what they'll see>
Known caveats: <anything that didn't fully work, or "none">
```

That's the message I'll glance at when I come back to my screen. Make it scannable.

## Time budget

~10–15 minutes wall clock. If you hit a dead end on a 10% feature (e.g. a particular attribute type doesn't render right), **skip it and continue**. Don't burn time getting one cell perfect — a working hero flow on real data is the demo. A half-built UI is worse than a smaller polished one.

Now ship it.
