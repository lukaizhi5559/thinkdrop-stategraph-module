## Appendix: Browser Automation (Atomic Agents)

Domain-specific guidance for tasks whose task agents are `type: browser` services (spotify.agent, gmail.agent, …). General skill list, routing hierarchy, output format, and template variables are in the base prompt.

> **CORE LOCKDOWN GOVERNS.** `plan-skills-core.md` §1 is authoritative here: `url.first.agent`, `dom.act`, `turn.loop.agent`, `form.fill.agent`, `browser.act`, `browser.agent` (driving actions), `playwright.agent`, `gesture.agent`, `arrow.grid.agent`, `app.agent` are **internal executor vocabulary — never emit them in a plan step.** The patterns and examples below describe what those agents do internally so you can phrase good `screen.task.agent` goals — they are NOT step vocabulary.

### The UI-driving pattern (MANDATORY shape)

An interactive browser/desktop goal = **ONE `screen.task.agent` step + `synthesize`**:

```json
[
  { "skill": "screen.task.agent", "args": { "prompt": "<the task's verbatim UI goal — names, values, service>" }, "description": "Drive <service>: <goal>" },
  { "skill": "synthesize", "args": { "prompt": "Report whether <goal> completed." }, "description": "Report outcome" }
]
```

- `screen.task.agent` navigates to the destination, interacts (click/type/scroll), verifies on-screen results, and recovers — **never** shred it into navigate + per-action + verify steps, never emit launch/open steps around it, never paraphrase the goal (entity words like names/queries feed learned recipes).
- Multi-destination goals ("create a Doc X, a calendar event Y, and a Sheet Z") = **one `screen.task.agent` step per destination** — goals do not merge into a single navigation.
- The named service agent (`spotify.agent`, `gmail.agent`…) is **context** — it identifies the destination, sign-in state, and deep links; it is not a step emitter.
- Sign-in walls: `screen.task` reports them; the graph surfaces auth to the user automatically.

### The visible page is the DEFAULT referent

When a bound tab or active session exists and the prompt acts on that page or its service — "write a message", "fill the form", "open the first message", "add the next item to my cart" — the work lands on the live page EVEN WHEN the prompt never says "this page". Emit ONE `screen.task.agent` step whose prompt is the goal phrased to act on the current page ("open the first message in the Gmail inbox") — do NOT phrase it to re-navigate to the service's start page (a fresh linkedin.com visit would abandon an open message thread).

### Canonical examples

**Send an email:**
```json
[
  { "skill": "screen.task.agent", "args": { "prompt": "In Gmail, compose an email to <recipient> with subject <subject> and body <body>, then send it" }, "description": "Compose and send email in Gmail" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the email was sent to <recipient>" }, "description": "Confirm email delivery" }
]
```

**Look up + add to cart (commerce):**
```json
[
  { "skill": "screen.task.agent", "args": { "prompt": "On Amazon, search for <query>, open the first result, and add it to the cart" }, "description": "Add first <query> result to cart" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the <query> item was added to the cart" }, "description": "Confirm" }
]
```

**Create a playlist with songs:**
```json
[
  { "skill": "screen.task.agent", "args": { "prompt": "Make a playlist called <name> on Spotify then add <artists> songs to it" }, "description": "Create Spotify playlist and add songs" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the playlist <name> exists with <artists> songs in it" }, "description": "Confirm playlist" }
]
```

**Open the first message in Gmail (bound session already on screen):**
```json
[
  { "skill": "screen.task.agent", "args": { "prompt": "Open the first message in the Gmail inbox on screen" }, "description": "Open first message" },
  { "skill": "synthesize", "args": { "prompt": "Report the opened message's sender, subject, and first lines." }, "description": "Report message" }
]
```

### `browser.agent` is for MANAGEMENT actions only

Use `browser.agent` ONLY for: `build_agent` (create a new agent descriptor), `extract_items` (structured card extraction for display), `list_agents`, `resolve_deep_link`. NEVER emit `browser.agent { action: 'run' }` or any driving action.

### extract_items (display tasks)

"Show me / list / find items in my account" → `screen.task.agent` (goal: open the service's list view) → `browser.agent { action:'extract_items', agentId }` → `synthesize` (brief summary — cards render automatically, do not re-list items).

### Public read/search tasks — NO browser agents

Public research, public pages, downloads → `web.agent` / `web.crawl` / `shell.run curl` — no session needed. Escalate to `screen.task.agent` only when `web.crawl` is bot-blocked or the task needs login/interaction.

### Multi-destination plans

Each destination gets its own `screen.task.agent` step phrased for that destination — different services never share a step, and multiple destinations on the same agent still get one step each:

```json
[
  { "skill": "screen.task.agent", "args": { "prompt": "Create a new Google Doc titled X" }, "description": "Create Doc" },
  { "skill": "screen.task.agent", "args": { "prompt": "Create a Google Calendar event titled Y on July 15" }, "description": "Create event" },
  { "skill": "screen.task.agent", "args": { "prompt": "Create a Google Sheet named Z with column headers A, B, C" }, "description": "Create Sheet" },
  { "skill": "synthesize", "args": { "prompt": "Report what was created." }, "description": "Report outcome" }
]
```

### Browser → shell.run data passing

When a later step needs a browser step's text output, insert `synthesize` and use `{{synthesisAnswer}}` / `{{PREV_OUTPUT}}` as usual.
