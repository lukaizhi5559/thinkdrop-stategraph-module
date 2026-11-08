## Appendix: Browser-off web/page work (browser automation DISABLED)

Browser automation is **disabled** in this environment. The following skills
do NOT exist at dispatch and MUST NOT appear in any plan — emitting one is a
guaranteed `browser_automation_disabled` failure:

`url.first.agent`, `dom.act`, `turn.loop.agent`, `browser.act`, `browser.agent`,
`playwright.agent`, `gesture.agent`, `arrow.grid.agent`

(also do NOT emit `app.agent` actions `nav_task` / `read_url` — they delegate to
browser.agent internally and fail the same way)

## The working substitutes

### Navigation → `shell.run open`

Opening a page uses the OS, not an automation session. Bake the destination
URL with the task's query filled in (search URLs carry it in params):
`youtube.com/results?search_query=<q>`, `google.com/search?q=<q>`,
`amazon.com/s?k=<q>` — emit the LITERAL url, never a placeholder.

```json
{ "skill": "shell.run", "args": { "cmd": "open", "argv": ["https://www.youtube.com/results?search_query=preaching%20videos"] }, "description": "Open YouTube search for preaching videos" }
```

### Page reads → `app.agent scan_page`

After a `shell.run open`, read what landed with `scan_page` (OS-level screen
read — no automation session needed):

```json
{ "skill": "app.agent", "args": { "action": "scan_page", "appName": "Google Chrome", "preferOs": true }, "description": "Read the loaded page" }
```

### CLI/API services → `cli.agent` / the registered service agent

Named services backed by a CLI or API agent (nylas, yt-dlp, gh, etc.) go
through `cli.agent run` — never through a browser-shaped step:

```json
{ "skill": "cli.agent", "args": { "action": "run", "agentId": "nylas.agent", "task": "<user goal verbatim>" }, "description": "Search nylas for the requested data" }
```

### Verification → `app.agent scan_page`

"Confirm it opened", "check the page shows X" → another `scan_page` step.
There is no verify-only browser loop in this environment.

## What is NOT possible

- DOM interaction (click, fill, submit, scroll-in-page) — no executor exists.
  If the task fundamentally requires it, plan the read-only portion and let
  the run surface the limitation honestly rather than emitting a disabled
  step that will fail at dispatch.
- Bound-session follow-ups — each `shell.run open`/`scan_page` is sessionless.

## Canonical plan shape

```json
[
  { "skill": "shell.run", "args": { "cmd": "open", "argv": ["<literal-url>"] }, "description": "Open <destination>" },
  { "skill": "app.agent", "args": { "action": "scan_page", "preferOs": true }, "description": "Read the loaded page" },
  { "skill": "synthesize", "args": {}, "description": "Summarize what was found" }
]
```
