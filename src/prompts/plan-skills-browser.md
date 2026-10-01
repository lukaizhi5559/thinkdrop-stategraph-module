## Appendix: Browser Automation (Atomic Agents)

Domain-specific guidance for the atomic browser agents and `web.agent`. General skill list, routing hierarchy, output format, and template variables are in the base prompt.

### The browser task pattern (MANDATORY shape)

Interactive browser tasks decompose into **one step per tier** — the plan is the orchestrator, not the agent:

1. **`url.first.agent`** — the ONLY step that navigates. Resolves the best URL for the task (deep-link), opens the shared session, detects auth walls. One step per destination.
   ```json
   { "skill": "url.first.agent", "args": { "agentId": "<service>.agent", "task": "go to <service> <section>" }, "description": "Navigate to <service>" }
   ```
2. **`dom.act`** — ONE on-page action per step (click, type, fill, submit, select, drag). A deterministic router picks the executor (just.type/meta.find/shortcut.keys/tab.map/gesture/arrow.grid/turn.loop) from live DOM state — you do NOT need to pick it.
   ```json
   { "skill": "dom.act", "args": { "task": "fill the To field with <recipient>", "agentId": "<service>.agent" }, "description": "Fill recipient" }
   ```
   - `agentHint` (optional): only when you KNOW the right executor — `"shortcut.keys.agent"` for apps with known hotkeys (Calendar `c`, Slack `Cmd+K`), `"turn.loop.agent"` for dense product/commerce pages (Amazon/eBay grids).
3. **`turn.loop.agent { mode:'verify' }`** — confirm a result holds without mutating ("confirm the email was sent", "check the item is in the cart"). Observes only.
   ```json
   { "skill": "turn.loop.agent", "args": { "goal": "confirm the email to <recipient> was sent", "mode": "verify" }, "description": "Confirm email sent" }
   ```
4. **`synthesize`** — summarize for the user.

Consecutive steps reuse the same browser session automatically — no `sessionId` needed, no `synthesize` between browser steps.

### Canonical examples

**Send an email:**
```json
[
  { "skill": "url.first.agent", "args": { "agentId": "gmail.agent", "task": "open Gmail compose", "url": "https://mail.google.com/mail/u/0/#inbox?compose=new" }, "description": "Open Gmail compose" },
  { "skill": "dom.act", "args": { "agentId": "gmail.agent", "task": "Fill in the email fields — To: <recipient>, Subject: <subject>, Body: <body> — then click Send" }, "description": "Fill and send the email" },
  { "skill": "turn.loop.agent", "args": { "goal": "confirm the email to <recipient> was sent (compose closed, confirmation toast or sent state visible)", "mode": "verify" }, "description": "Confirm email sent" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the email was sent to <recipient>" }, "description": "Confirm email delivery" }
]
```

**Look up + add to cart (commerce):**
```json
[
  { "skill": "url.first.agent", "args": { "agentId": "amazon.agent", "task": "search Amazon for <query>" }, "description": "Search Amazon for <query>" },
  { "skill": "dom.act", "args": { "agentId": "amazon.agent", "agentHint": "turn.loop.agent", "task": "open the first result and add it to the cart" }, "description": "Add first result to cart" },
  { "skill": "turn.loop.agent", "args": { "goal": "confirm the item was added to the cart (cart count incremented or confirmation banner)", "mode": "verify" }, "description": "Confirm added to cart" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the <query> item was added to the cart" }, "description": "Confirm" }
]
```

**Create a calendar event (shortcut-driven app):**
```json
[
  { "skill": "url.first.agent", "args": { "agentId": "google_calendar.agent", "task": "open Google Calendar" }, "description": "Open Google Calendar" },
  { "skill": "dom.act", "args": { "agentId": "google_calendar.agent", "agentHint": "shortcut.keys.agent", "task": "open the create-event dialog (shortcut 'c')" }, "description": "Open create-event dialog" },
  { "skill": "dom.act", "args": { "agentId": "google_calendar.agent", "task": "fill the event: title <title>, date <date>, time <time>, location <location> — then save" }, "description": "Fill and save event" },
  { "skill": "turn.loop.agent", "args": { "goal": "confirm the event '<title>' appears on the calendar", "mode": "verify" }, "description": "Confirm event created" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the calendar event was created" }, "description": "Confirm" }
]
```

### `browser.agent` is for MANAGEMENT actions only

Use `browser.agent` ONLY for: `build_agent` (create a new agent descriptor), `extract_items` (structured card extraction for display), `list_agents`, `resolve_deep_link`. NEVER emit `browser.agent { action: 'run' }` — navigation is `url.first.agent`, on-page actions are `dom.act`, verification is `turn.loop.agent`.

### `dom.act` rules

- **ONE action per step.** "Fill the form and submit" is fine in one step (one continuous form fill). "Add 3 items" is THREE steps. Block-based editors (page builders, wiki editors, note apps) get one step per block type.
- **`agentHint` is optional** — the router reads live DOM state and picks the right executor. Only hint when you're certain: `shortcut.keys.agent` (known app hotkey), `turn.loop.agent` (dense commerce/product grids), `arrow.grid.agent` (spreadsheet cell entry).
- If a `dom.act` step fails, the graph replans with a different agent automatically — keep steps atomic so failures stay small.

### `url.first.agent` rules

- Provide `url` when you know the deep link (e.g. Gmail compose `?compose=new`); otherwise give `task` and the resolver finds it.
- It returns `needsAuth` on sign-in walls — the graph surfaces auth to the user automatically.

### extract_items (display tasks)

"Show me / list / find items in my account" → `url.first.agent` (navigate to list view) → `browser.agent { action:'extract_items', agentId }` → `synthesize` (brief summary — cards render automatically, do not re-list items).

### Public read/search tasks — NO browser agents

Public research, public pages, downloads → `web.agent` / `web.crawl` / `shell.run curl` — no session needed. See the webfetch appendix. Escalate to `url.first.agent` only when `web.crawl` is bot-blocked or the task needs login/interaction.

### Multi-agent plans (independent services)

Steps for different services each get their own `url.first.agent` step with that service's `agentId` — never reuse a URL across agents:

```json
[
  {"skill":"url.first.agent","args":{"agentId":"<service-a>.agent","task":"open <service-a>"},"description":"Open <service-a>"},
  {"skill":"dom.act","args":{"agentId":"<service-a>.agent","task":"<action-a>"},"description":"<action-a>"},
  {"skill":"url.first.agent","args":{"agentId":"<service-b>.agent","task":"open <service-b>"},"description":"Open <service-b>"},
  {"skill":"dom.act","args":{"agentId":"<service-b>.agent","task":"<action-b>"},"description":"<action-b>"},
  {"skill":"synthesize","args":{"prompt":"Compare the results."},"description":"Compare"}
]
```

### Browser → shell.run data passing

When a later step needs a browser step's text output, insert `synthesize` and use `{{synthesisAnswer}}` / `{{PREV_OUTPUT}}` as usual.
