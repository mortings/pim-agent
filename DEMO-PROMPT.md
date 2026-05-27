# Gartner demo — the build-a-UI-while-you-talk prompt

This prompt lets you start a Claude Code session at the **beginning** of a Gartner analyst meeting, switch back to the analyst, and have a working fit-for-purpose UI deployed by the **end** of the meeting (~10–15 min later). You don't watch Claude work — Claude works autonomously while you keep presenting.

## How to use it

### Option A — slash command (recommended)

If you're in this repo, the slash command is already installed:

```
/build-demo-ui merchandiser quick-edit
```

or just:

```
/build-demo-ui
```

(no argument → defaults to Merchandiser quick-edit, the persona that visually contrasts most with what's already deployed.)

### Option B — paste the prompt

If you're not in this repo (e.g. fresh demo machine), copy the contents of [`.claude/commands/build-demo-ui.md`](.claude/commands/build-demo-ui.md) and paste it as your first message in Claude Code. Replace `$ARGUMENTS` with the persona name (or just delete that line to take the default).

## What happens

1. You say to the analyst: *"This is the Bluestone PIM UI skill on top of our MCP server. Watch how easy it is to build a fit-for-purpose UI for a specific role."*
2. You start a Claude Code session, paste/type the command, hit Enter.
3. You switch back to the analyst and keep presenting whatever you had planned.
4. Claude autonomously:
   - Reads the skill's persona recipes + tool catalog + the existing `pm-shoes.html` as a reference (which has every production pattern figured out — defensive MCP parsing, optimistic save with background polling, CORS-correct port, etc.)
   - Picks a sensible persona if you didn't specify one
   - Writes a single self-contained HTML file
   - Tests it on `localhost:8000` against your real Bluestone tenant
   - Updates `demos.html` to surface the new UI
   - Commits and pushes to `main` (GitHub Pages auto-deploys)
   - Replies with a 5-line summary: file name, deployed URL, persona, one-sentence demo script, caveats
5. By the end of your demo (10–15 min), the URL is live at `https://mortings.github.io/pim-agent/<file>.html`.
6. You click back to your Claude Code screen, read the 5-line summary, then switch to the deployed URL and show the analyst:
   *"While we've been talking, Claude built this fit-for-purpose UI on top of our MCP. Real data, live tenant, single file, ~10 minutes."*

## What the prompt bakes in (so you don't get interrupted)

Every gotcha from the session that produced `pm-shoes.html` is baked into the prompt:

| Gotcha (and what it cost last time) | How the prompt handles it |
|---|---|
| Claude asks "which catalog?" | Auto-discover, default to first / one matching the persona |
| KPIs blank because field names don't match | Defensive parsing with multiple candidate paths + regex extract from prose |
| "Save" appears to do nothing for 15s | Optimistic score update + background polling, never blocks UI |
| CORS error on `localhost:8765` | Use port 8000 (the Worker's allow-list) |
| Worker URL prompts every time | Baked in; only the secret is interactive |
| Drawer fields rendered as "unfixable" | Bucket by `definitionId` presence, not strict type-string match |
| Page title hardcoded to one persona | Catalog-agnostic from the start |
| Generic "Settings button does not work" | Defensive `addEventListener` alongside inline handlers |

## Tweaking the persona

The prompt template's default is **Merchandiser quick-edit** (grid view, inline editing). Other strong demo personas from the skill:

- `/build-demo-ui store associate phone-sized lookup` — touch-target search, scan barcodes, product detail. Phone-shape contrast is dramatic.
- `/build-demo-ui agentic command bar` — slash-style `/list`, `/create`, `/setattr`. Looks most overtly "agentic" — strong for AI-focused analysts.
- `/build-demo-ui content enrichment workbench` — Original vs Suggested copy side-by-side, accept/reject AI suggestions. Best if the analyst is into the AI-augmentation angle.
- `/build-demo-ui buyer dashboard` — KPI-heavy executive view. Best for buyer/CFO conversations.

You can also just write your own persona description in your own words — the prompt is robust to that.

## Pre-demo checklist (do this once, ahead of the meeting)

- [ ] Clone the repo to your demo machine
- [ ] Confirm your browser's `localStorage` has the secret saved on `https://mortings.github.io` — paste `localStorage.getItem('pim-workerSecret')` in DevTools console on the existing demo to check
- [ ] Open Claude Code in this repo
- [ ] Type `/build-demo-ui` and Tab — confirm the command shows up

That's it. On the day of the demo, you only need to type one command and switch tabs.
