## Appendix: Browser-off web/page work (browser automation DISABLED)

Browser automation is **disabled** in this environment. The following skills
do NOT exist at dispatch and MUST NOT appear in any plan — emitting one is a
guaranteed `browser_automation_disabled` failure:

`url.first.agent`, `dom.act`, `turn.loop.agent`, `browser.act`, `browser.agent`,
`playwright.agent`, `gesture.agent`, `arrow.grid.agent`

(also do NOT emit `app.agent` actions `nav_task` / `read_url` — they delegate to
browser.agent internally and fail the same way)

## The working executor: `screen.task.agent`

UI interaction on pages and desktop apps goes through `screen.task.agent` —
the screen-driven agent that observes the screen, resolves visible elements,
performs physical mouse/keyboard actions (CGEvents), verifies the result, and
recovers from mistakes. It needs NO automation session and works in the real
browser/app the user already has open. Give it the user's goal verbatim — it
derives its own setup (open URL / focus app) and steps:

```json
{ "skill": "screen.task.agent", "args": { "prompt": "go to gmail and send an email to randallakers.work@gmail.com saying take out the trash" }, "description": "Drive Gmail to send the email" }
```

Use it for: click/fill/type/submit/scroll on a page, sending messages or
emails, posting, navigating inside an app, opening menus, in-page find
(⌘F flow), and desktop-app UI tasks (Slack channels, Notes, Calendar,
Terminal, TextEdit). One step per service/task — screen.task verifies its own
work, so do NOT append a separate verify step after it.

### Pure opens & reads

- "Open <site>" with nothing to do on the page → `screen.task.agent` handles it
  too (its setup opens the URL in the default browser and verifies). Plain
  `shell.run open <url>` is acceptable only for a fire-and-forget launch with
  no interaction and no verification needed.
- "Read/find X on the page" → `screen.task.agent` — it uses the human find
  flow (⌘F → type → Esc) and reads the result from the screen parse.
- Passive page-text read → `screen.act.agent {goal:"copy the visible page text", steps:[{action:"copy_page"}]}`.
  (`app.agent scan_page` is dormant — do NOT emit it.)

### Generate-then-type — synthesized content into an app

"Type up a report on X in Google Docs", "write Y into Notes", "research Z and
put it in <app>" → TWO steps: `synthesize` produces the content, then
`screen.task.agent` pastes it into the destination (`args.text` carries the
prior output via `{{prev_stdout}}`; `args.title` names the document):

```json
[
  { "skill": "synthesize", "args": { "prompt": "Write a one-page report on <topic> — plain text, no markdown formatting." }, "description": "Write the report content" },
  { "skill": "screen.task.agent", "args": { "prompt": "go to google docs", "text": "{{prev_stdout}}", "title": "Report on X" }, "description": "Open Google Docs and paste the report" }
]
```

`args.prompt` still drives the destination (open app/URL — any service name
works, the agent discovers and verifies it at runtime). `args.text` is pasted
via clipboard — instant, not keystroke-typed. `args.title` sets the document
name when the user says "save as X" / "name it X".

### CLI/API services → `cli.agent` / `shell.run`

Named services backed by a CLI or API agent (nylas, yt-dlp, gh, etc.) still go
through `cli.agent run` / `shell.run` — that path stays fastest and is NOT
affected by the browser kill switch:

```json
{ "skill": "cli.agent", "args": { "action": "run", "agentId": "nylas.agent", "task": "<user goal verbatim>" }, "description": "Search nylas for the requested data" }
```

## What is NOT possible

- Drag-and-drop UI gestures — the screen daemon has no drag command yet. If a
  task fundamentally requires dragging, plan what you can and surface the
  limitation honestly.
- Bound-session DOM reads — each screen.task run is sessionless; it reads
  pixels/OCR, not the DOM.

## Canonical plan shape

```json
[
  { "skill": "screen.task.agent", "args": { "prompt": "<user goal verbatim>" }, "description": "<short description of the UI task>" },
  { "skill": "synthesize", "args": {}, "description": "Summarize what was done" }
]
```
