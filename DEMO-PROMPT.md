# Gartner demo — the transparent build-along

This prompt lets you build a fit-for-purpose UI **live in front of the analyst**, with your Claude Code window on screen the whole time. You don't disappear and run a script — the analyst watches Claude actually plan, read docs, call MCP, write code, test, and ship.

The proof point you're selling is *"a working UI in an afternoon, on top of our MCP."* The visible execution **is** the demo.

## How to run the demo

### The pitch (your spoken intro, ~30 seconds)

> "Before I show you our regular PIM, I want to show you something different. This is the **Bluestone PIM UI skill** — a Claude Code skill that knows how to build UIs on top of our MCP server. I'm going to ask Claude to build a fit-for-purpose UI for a specific role right now. You'll watch it happen. By the end of our conversation, we'll have a working, deployed UI to look at — talking to live data on our real tenant."

### The command

In Claude Code, in this repo, type:

```
/build-demo-ui merchandiser quick-edit
```

or just `/build-demo-ui` (defaults to merchandiser, which contrasts most with the three demos already deployed).

Press Enter. The analyst sees the prompt expand inline — they can read what you're asking for, including the constraints.

### What happens next (visible to the analyst)

Claude will, **in this exact order, visibly**:

1. **Post a 2-sentence plan** — what it's going to build and why this persona.
2. **Create a checklist** with TaskCreate — 6-8 concrete steps. The analyst sees the project plan crystallize.
3. **Read the skill's persona recipes** — *"Reading the merchandiser quick-edit recipe to confirm the layout."* The Read tool calls are visible.
4. **Call the live MCP** — *"Calling `list_catalogs` to see what's on this tenant."* Real network activity, real data comes back.
5. **Surface findings** — *"Tenant has 5 catalogs: Clothes, Skincare, Outputs, Intake-ERP, Enrichment Structure. Using Clothes."*
6. **Write the HTML file** — Edit/Write tool calls scroll by, code is visible.
7. **Test it on a preview server** — opens a browser, exercises the flow, screenshots if needed.
8. **Update demos.html** — the landing page gets a 4th card.
9. **Commit + push** — Git commands visible, GitHub Pages auto-deploys.
10. **Post a 5-line summary** — file name, URL, persona, one-sentence demo script, caveats.

Your job during this is to **narrate** as you point at the screen. Easy talking points:

- *"See — Claude's reading the skill's documentation. The skill encodes how to build a PIM UI."*
- *"Now it's calling our MCP server to see what's on the tenant. That's a real API call."*
- *"It's writing the file. This isn't a template — it's adapting to what it found."*
- *"It's testing the UI in a real browser before declaring it done."*
- *"Pushing to GitHub. The site will auto-deploy."*

### When Claude is done

Claude posts the 5-line summary. You read it aloud, switch tabs to the deployed URL, and demo the result:

> *"Here it is — a merchandiser-shaped UI for the Clothes category, built start-to-finish in the time we've been talking. Same PIM tenant, same MCP, completely different shape. Watch — I can change a price right here and it lands in Bluestone."*

## Backup: conversational mode (if the analyst wants Q&A during the build)

Sometimes the analyst will interrupt with questions: *"Why that persona?"*, *"How does the skill work?"*, *"What if we wanted X?"* — these are good interruptions to lean into.

To handle that, **pause Claude** at any time:

- Use Ctrl-C / Esc to interrupt the current turn
- Answer the analyst's question
- Resume with: *"OK Claude, continue from where you were — keep the same plan."*

Claude will pick up where it left off. The TaskCreate checklist is your safety net — it knows what's pending.

You can also actively involve the analyst:

- *"Claude, what catalogs did you find?"* → Claude shows the list, you discuss with the analyst
- *"Claude, why did you pick that recipe?"* → Claude explains; the analyst sees real reasoning
- *"Show the analyst the code you just wrote."* → Claude opens the file

These interruptions don't break the demo — they make it more credible.

## What the prompt bakes in so you don't get interrupted by Claude

| Past gotcha (from the session that produced pm-shoes.html) | Pre-empted by |
|---|---|
| Claude asks "which catalog?" | Auto-discover, default to one fitting persona |
| KPIs blank because field names don't match | Defensive parser baked in via pm-shoes.html reference |
| Save appears to do nothing for 15s | Optimistic update + background poll baked in |
| CORS error on localhost:8765 | Prompt explicitly says port 8000 |
| Worker URL prompts every time | Baked into HTML |
| Drawer fields rendered as "unfixable" | Bucket by `definitionId`, not strict type-string |
| Hardcoded persona/catalog names | Catalog-agnostic from start |
| Settings button mystery | `addEventListener` redundancy alongside `onclick` |

## Pre-demo checklist (do this once, ahead of the meeting)

- [ ] Clone the repo to your demo machine
- [ ] Open it in Claude Code; type `/build-demo-ui` and Tab — confirm the command shows up
- [ ] Confirm your browser has the shared secret in localStorage for the GitHub Pages origin (paste `localStorage.getItem('pim-workerSecret')` in DevTools on the existing demo to check)
- [ ] **Do one dry run** with a persona you won't use in the real demo, e.g. `/build-demo-ui buyer dashboard`. This both warms you up and lets you discover any environment quirk *before* an analyst is watching.
- [ ] When the dry-run UI is deployed, delete the dry-run HTML file + its demos.html card so the real demo starts from a clean state.

## Other personas to try

Anything from the skill's `persona-recipes.md` works. Strong choices:

- `/build-demo-ui store associate phone lookup` — touch-target search, mobile shape. Most dramatic visual contrast.
- `/build-demo-ui agentic command bar` — slash-style `/list`, `/create`, `/setattr`. Best for AI-curious analysts.
- `/build-demo-ui content enrichment workbench` — Original vs Suggested copy side-by-side. Best for AI-augmentation narrative.
- `/build-demo-ui buyer dashboard` — KPI-heavy exec view. Best for CFO / category-director audiences.

The default is `merchandiser quick-edit` which contrasts most strongly with the existing three demos.

You can also write a custom persona in your own words: `/build-demo-ui in-store kiosk for self-checkout with our PIM as the backend` — the prompt is robust to free-form descriptions.
