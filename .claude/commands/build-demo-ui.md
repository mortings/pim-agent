---
description: Build a new fit-for-purpose Bluestone PIM UI end-to-end in one shot (Gartner-demo mode, transparent). Optional arg = persona, e.g. "merchandiser quick-edit", "store associate lookup", "agentic command bar".
---

# Build a fit-for-purpose Bluestone PIM UI — Gartner demo mode

I am presenting to a Gartner analyst right now. The Claude Code window is **on screen the whole time** — the analyst will be watching your work as part of the demo. The "build a fit-for-purpose UI in an afternoon" claim is the point of the demo, so your visible execution **is** the demo.

You have ~10–15 minutes of wall clock to ship a working, committed, deployed UI **without asking me anything**. I will narrate to the analyst as you work, then take over at the end to show the deployed result.

## Transparency rules (the analyst is watching)

This is the most important part of the prompt. **Your visible activity is the demo.** Follow these:

1. **First action: post a 2-sentence plan, then create the TaskCreate list.** The analyst should see a clean checklist appear that previews the next 10 minutes. Pick 6–8 concrete steps. Don't be cute — the steps should read like a project plan.
2. **Update tasks as you go.** Mark each `in_progress` as you start it, `completed` as you finish. The analyst is watching the checklist evolve.
3. **One terse sentence per transition.** Before each step, post ONE sentence (≤15 words) saying what you're about to do and *why*. Example: *"Calling `list_catalogs` to see what's on this tenant — we'll target whichever fits the persona."* Then do it. Don't pad. Don't apologize.
4. **Surface real-world findings as one-liners.** When MCP returns something interesting, say it: *"Tenant has 5 catalogs: Clothes, Skincare, Outputs, Intake-ERP, Enrichment Structure. Using Clothes."* The analyst sees real data flowing.
5. **Don't paste code into your text.** Edit/Write tool calls are already visible — let them speak. Your prose is for context only.
6. **Don't speculate or hedge.** No "I think this might…" — either you tried it or you haven't. The analyst is watching efficient execution.
7. **No silent stretches longer than 60s.** If a tool call is slow, say "Waiting on `search_products`…" so the analyst knows the screen isn't frozen.

## Persona

$ARGUMENTS

If no persona is specified above (empty line or literal `$ARGUMENTS`), default to **Merchandiser quick-edit** — table view of one category with inline price / stock / label editing. Why this default: the repo already has the scorecard, supplier portal, and chat-driven PIM. A grid-shaped merchandiser UI gives the strongest visual contrast for the "same backend, different UI per role" story.

## Reference: pm-shoes.html

`pm-shoes.html` in this repo is the gold-standard reference from a previous session. It has every production pattern figured out. **Read it once and lift code freely.** Specifically reuse:

- Settings modal + `mcpCall(tool, args)` helper + defensive `addEventListener` rewiring
- Catalog auto-discovery via `list_catalogs` + dynamic page title / crumb / KPI labels
- Defensive MCP JSON parsing (prose preamble + JSON; tries `structuredContent`, `content[].json`, regex extract)
- Server-side completeness filtering — **don't pass `completenessScoreMin/Max` for an "All" filter** (excludes products without scores)
- Save flow: **optimistic** score update from req counts → close drawer → **background** polling with exponential backoff (1s → 6s, ~21s total) → silent correction if mismatch
- Fixable bucketing: `!!definitionId && !/MEDIA/i.test(type)` (NOT exact type-string match)
- Pulsing blue dot pattern for "Bluestone verifying"
- Worker URL pre-filled + auto-open Settings + focus secret field

## Hard rules

- **No `AskUserQuestion`. No `ExitPlanMode`.** Pick defaults and ship.
- **Worker URL is `https://pim-agent-proxy.mortings.workers.dev`.** Bake as the localStorage default. Public per skill rules.
- **Shared secret stays out of source.** It's already in my browser localStorage on the GitHub Pages origin.
- **Preview on port 8000** — in the Worker's CORS allow-list. 8765 is NOT.
- **Single self-contained HTML file.** No build step, no framework.

## Workflow (use as your TaskCreate template)

1. Plan: post plan + create task list
2. Read: skill's persona-recipes.md (just the relevant recipe) + mcp-tools.md (recipe-to-tool mapping) + pm-shoes.html
3. Discover: call `list_catalogs` + `list_contexts` to see what's actually on the tenant
4. Scaffold: write the new HTML file by lifting structure from pm-shoes.html
5. Persona-specific UI: replace the `<main>` content + persona-specific script bits
6. Verify: preview on port 8000, click through the hero flow end-to-end against real data
7. Update landing page: add a 4th card to demos.html (use `--orange` or `--yellow` accent for variety)
8. Ship: two clean commits to main, push, confirm Pages will deploy

## Final message format

When done, reply with EXACTLY this shape — nothing else:

```
✓ Shipped: <file-name>.html
Live: https://mortings.github.io/pim-agent/<file-name>.html
Persona: <one sentence>
Show the analyst: <one-sentence demo script — what to click, what they'll see>
Known caveats: <anything that didn't fully work, or "none">
```

This is the message I'll read aloud when I take the screen back. Make it scannable.

## Time budget

~10–15 minutes wall clock. If a 10% feature is stuck, **skip it and continue** — log it under caveats. A working hero flow on real data is the demo. A half-built UI is worse than a smaller polished one.

Now ship it, transparently.
