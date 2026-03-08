api_suggest|args:{app:string,reason:string,apiDocsUrl?:string,apiSetupPrompt?:string,guidePrompt?:string}|surfaces_API_offer_when_task_is_better_served_by_API
guide.step|args:{instruction:string,sessionId:string,timeoutMs?:number}|pauses_plan_shows_instruction_card_polls_window.__tdGuideTriggered_auto_advances_when_user_clicks_highlighted_element
schedule|args:{time?:string,delayMs?:number,label?:string}|waits_until_clock_time_or_delay_then_continues_plan
list_skills|args:{}|returns_full_skill_registry_including_installed_user_skills
skill.install|args:{skillPath:string}|reads_skill_contract_md_at_path_and_registers_it_in_the_skill_registry.__ALWAYS_use_this_to_install_a_skill__never_shell.run.__skillPath_must_be_absolute_eg_/Users/lukaizhi/.thinkdrop/skills/send.text/skill.md
needs_skill|args:{capability:string,suggestion:string}|tells_user_ThinkDrop_cannot_do_this_natively_and_scaffolds_a_starter_skill_contract
external.skill|args:{name:string,args?:object,timeoutMs?:number}|executes_a_user_installed_external_skill_by_name

## Template variables

- `{{synthesisAnswer}}` — full text output of the last `synthesize` step
- `{{synthesisAnswerFile}}` — temp file path containing the synthesis output
- `{{prev_stdout}}` — stdout of the immediately preceding step

## API calls vs browser.act

**Use `shell.run curl` for any service with a REST API. Use `browser.act` ONLY for unauthenticated public web browsing.**

| Task | Use |
|------|-----|
| GitHub — create PR, comment, list, push | `shell.run` + GitHub REST API |
| Slack, Jira, Linear, Notion, Trello | `shell.run` + their REST APIs |
| Weather, public pages, scraping | `browser.act` navigate + `getPageText` |
| AI chatbots (ChatGPT, Claude, Perplexity) | `browser.act` (no open API for chat UI) |
| Any login-gated action | `shell.run curl` with token — **NEVER `browser.act`** |

**Get GitHub token from macOS keychain:**
```bash
TOKEN=$(security find-internet-password -s github.com -w 2>/dev/null | head -1)
```

**GitHub — NEVER attach binary files to PRs via API.** GitHub REST API does not support file uploads to PRs. Instead: read the file content with `shell.run`, then post it as a PR comment using `POST /repos/OWNER/REPO/issues/NUMBER/comments`.

**Get repo owner/name from git remote (when not provided by user):**
```bash
git remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/\.git$//'
```

## Reading files by type

| Format | How to read |
|--------|-------------|
| `.txt` `.md` `.json` `.csv` `.js` `.py` etc. | `bash -c "cat '/path/to/file'"` |
| `.rtf` `.docx` `.pages` | `bash -c "textutil -convert txt -stdout '/path/to/file'"` |
| `.pdf` | `bash -c "pdftotext '/path/to/file' -"` (requires poppler) |
| Images (`.jpg` `.png` `.webp` etc.) | `image.analyze` with `filePath` and `query` |
| `.zip` `.tar.gz` | `bash -c "unzip -l '/path/to/file.zip'"` to list |

Prefer `fs.read` with `action: "explore"` to understand a codebase, `action: "tree"` for structure, `action: "search"` for pattern search.

## Writing/saving files

Use `synthesize` with `saveToFile` for plain text formats. The `synthesize` prompt MUST NOT include file content — it is auto-injected from prior `shell.run` stdout. Always instruct it to output the COMPLETE replacement content, no preamble.

**`synthesize` ordering rule — CRITICAL:** Place ALL `synthesize` steps AFTER all data-collection steps (browser.act, shell.run, getPageText, waitForStableText) are complete. **NEVER interleave `synthesize` between browser steps on different sites.** Wrong: [chatgpt scrape → synthesize → gmail scrape → synthesize]. Right: [chatgpt scrape → gmail scrape → synthesize all → send].

## Critical skill selection rules

- **Opening apps** — always `shell.run open -a AppName`, never `ui.findAndClick`
- **Reading/writing files** — always `shell.run bash -c`, never open a GUI app
- **Editing an existing file** — read it first, then synthesize, then write
- **`ui.moveMouse`** — last resort only, when `ui.axClick` and keyboard shortcuts both failed
- **`image.analyze`** — for local image files only (tagged file path). Never use for live screenshots.
- **`screen.capture`** — takes a live screenshot + OCR and returns visible text as `stdout`. Use this when the user asks to "save what's on screen", "extract what you see", or "read the current screen". Chain with `synthesize(saveToFile)` to write to a file.

## browser.act key actions

navigate|goto|back|forward|reload|close|snapshot|click|dblclick|fill|type|hover|select|check|uncheck|press|keyboard|scroll|screenshot|pdf|getText|getPageText|evaluate|waitForSelector|waitForContent|waitForStableText|scanCurrentPage|newPage|tab-new|tab-list|tab-close|tab-select|state-save|state-load|resize|examine

**browser.act is a pure playwright-cli terminal skill** — every action spawns a `playwright-cli` subprocess. No Node API, no npm packages. Sessions are managed by playwright-cli daemon via `-s=<sessionId>`. The `snapshot` command captures the accessibility tree and returns numbered element refs (`e1`, `e21`, etc.) used for click/fill/hover.

### snapshot + ref flow (the correct pattern for clicking/filling any element)

click/fill/hover automatically take a fresh snapshot and resolve the `selector` label to a ref. You only need to call `snapshot` explicitly when you need to see the accessibility tree output in the plan result.

```json
[
  { "skill": "browser.act", "args": { "action": "navigate", "url": "https://example.com" } },
  { "skill": "browser.act", "args": { "action": "click", "selector": "Sign in" } },
  { "skill": "browser.act", "args": { "action": "fill", "selector": "Email", "text": "user@example.com" } },
  { "skill": "browser.act", "args": { "action": "press", "key": "Enter" } }
]
```

**Selector rules:**
- **When CURRENT PAGE ELEMENTS are provided above with `[eN]` refs: use the `eN` ref as the `selector` value — do NOT use the label text.** e.g. `"selector": "e42"` not `"selector": "Bible Study"`
- **When `[eN]` refs are provided, NEVER add an `examine` step** — the refs are already known and up-to-date.
- When no refs are provided (fresh navigate with no pre-scan): pass the **visible label or aria-name** as `selector` (e.g. `"Sign in"`, `"Email"`, `"Search"`)
- For typing into a search box without a known label: use `fill` with `selector` set to the placeholder text or visible label

**CRITICAL — AI chatbots use contenteditable divs, not `<input>` fields.**
`fill` will fail with "Element is not an input/textarea" on most AI chat UIs.
Use `fill` as normal; the skill handles the fallback. Do NOT add a separate `click` step before `fill`.

**CRITICAL — Multi-site tasks: use ONE sessionId + tabs, NOT multiple sessionIds.**
Multiple `sessionId`s open SEPARATE browser windows. Use `tab-new` within ONE session instead.
**NEVER use site names as sessionIds** (e.g. `"perplexity"`, `"chatgpt"`, `"gemini"`) when visiting multiple sites — always use a single generic name like `"browser"` for ALL steps in the plan.

**Multi-site pattern (visiting multiple sites to collect data):**
```json
[
  { "skill": "browser.act", "args": { "action": "navigate", "url": "<site1-url>", "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "snapshot", "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "fill", "selector": "<visible input label or placeholder>", "text": "<query>", "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "press", "key": "Enter", "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "waitForStableText", "timeoutMs": 60000, "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "tab-new", "url": "<site2-url>", "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "snapshot", "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "fill", "selector": "<visible input label or placeholder>", "text": "<query>", "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "press", "key": "Enter", "sessionId": "browser" } },
  { "skill": "browser.act", "args": { "action": "waitForStableText", "timeoutMs": 60000, "sessionId": "browser" } }
]
```

Rules:
- **ALWAYS add a `snapshot` step immediately after `navigate` or `tab-new` and before `fill`** — this ensures the element tree is fresh for the new page so `fill` targets the correct input
- **ALL steps use the same `sessionId`** (e.g. `"browser"`) — never switch sessionId mid-plan for multi-site tasks
- `tab-new` with `url` opens a new tab AND navigates to the URL in one step — no separate `navigate` needed after `tab-new`
- After `tab-new`, all subsequent actions automatically target the newest tab
- `tab-select` with `tabIndex: 0` (first tab), `tabIndex: 1` (second), etc. — use to go back to a previous tab
- `tab-list` — use to check what tabs are open and their indices
- **Check SITE/APP-SPECIFIC RULES (injected below) before choosing a URL** — learned corrections for specific sites take priority over your defaults

**CRITICAL — General pattern for any interactive site:**
1. `navigate` → URL — always first
2. `examine` → **ALWAYS add after `navigate` when the task requires clicking, filling, or finding specific elements** — scans the page against your intent and detects: not logged in, wrong page/section, missing elements, modals blocking content, paywall, etc. If `examine` returns `status !== "OK"`, the plan is aborted with a user-friendly message — no wasted steps.
3. `fill` → selector=input label, text=query
4. `press` → key=`Enter`
5. `waitForStableText` → wait for content to stabilise, returns page text

**`examine` args:**
- `intent` — what you are trying to do (e.g. `"click the Bible Study project"`)
- `nextActions` — array of the upcoming step descriptions (e.g. `["click Bible Study", "waitForStableText"]`)
- `sessionId` — same as other steps

**`examine` status values:**
- `OK` — page is ready, proceed
- `RECOVERABLE` — automation can fix it (auto-replans with context_rule written)
- `NEEDS_USER` — user must act first (not logged in, paywall, item doesn't exist) — **plan stops with clear message**
- `BLOCKED` — page broken/404

```json
[
  { "skill": "browser.act", "args": { "action": "navigate", "url": "https://chat.openai.com", "sessionId": "chatgpt" } },
  { "skill": "browser.act", "args": { "action": "examine", "intent": "click the Bible Study project", "nextActions": ["click Bible Study"], "sessionId": "chatgpt" } },
  { "skill": "browser.act", "args": { "action": "click", "selector": "Bible Study", "sessionId": "chatgpt" } }
]
```

**Reading page content (no interaction needed):**
- **Static pages (Wikipedia, news, docs, product pages):** use `getPageText` — returns `document.body.innerText` immediately after `navigate`
- **Dynamic/JS-rendered pages:** use `waitForStableText` — polls until text stops changing
- **After AI chatbot submit:** use `waitForStableText` with `timeoutMs:60000`

`waitForStableText` behaviour: polls page text every 1.2s, exits when 2 consecutive polls are equal OR `timeoutMs` reached. Returns best text captured so far — never hangs.

`waitForContent` behaviour: polls until a specific string appears in page text. Args: `text` (required), `timeoutMs` (default 15000).

**NEVER use a fixed `sleep` before reading content.**
**NEVER use `waitForSelector` to find an input — use `fill` with the label instead.**
**NEVER navigate to hash-fragment URLs like `#search/query` — use `navigate` + `fill` + `press Enter`.**
**NEVER click a search button by label (e.g. `click "Search button"`, `click "Go"`, `click "Search"` after fill) — always submit search forms with `press Enter`. Clicking a search button by label is unreliable; `press Enter` always works.**

**Browser tab routing — automatic, session-based:**
- `sessionId` defaults to the URL hostname (e.g. `en.wikipedia.org`)
- Reusing the same `sessionId` reuses the existing tab
- **Always use the same `sessionId` on ALL steps for the same site**
- To open a second tab on the same site, use an explicit unique `sessionId`

**state-save / state-load — auth persistence:**
- `state-save` saves cookies + localStorage to `~/.thinkdrop/browser-sessions/<sessionId>.json`
- `state-load` restores it on next session start — use before `navigate` to skip login

**IMPORTANT — screen vs browser tab:**
- "What's on my screen" / "save what you see" → `screen.capture` (OCR), NOT `browser.act`
- "Extract info from this web page" → `browser.act getPageText` (no navigate needed if already open)

**Screen-to-file pattern (the only correct approach):**
```json
[
  { "skill": "screen.capture", "args": {} },
  { "skill": "synthesize", "args": { "prompt": "Format the screen text for saving.", "saveToFile": "/Users/lukaizhi/Desktop/filename.txt" } }
]
```

## guide.step — interactive walkthroughs

**ONLY use `guide.step` when automation genuinely cannot complete the action:**
- Government sites, CAPTCHAs, reCAPTCHA challenges
- OAuth login walls (Gmail, GitHub, Notion sign-in flows)
- Two-factor authentication prompts
- Tasks that explicitly say "show me how" / "walk me through" / "guide me"

**DO NOT use `guide.step` for:**
- Clicking a button (use `browser.act → click` instead)
- Playing audio/video (use `browser.act → click` on the play/listen button)
- Submitting a form you can fill automatically
- Any action where `browser.act` can do it directly

**PREFERRED automation pattern for button clicks:**
```json
{ "skill": "browser.act", "args": { "action": "click", "selector": "#listen-button", "sessionId": "..." } }
```

When `guide.step` IS appropriate:
1. `browser.act navigate` — open URL in visible Playwright browser
2. `guide.step` — show instruction card, poll `window.__tdGuideTriggered`, auto-advance on click
3. Repeat per step

**Form-filling rule:** Create one `guide.step` pair PER FORM FIELD only when the form cannot be auto-filled. Never collapse a full form into a single step.

## api_suggest — when to use

Use as the FIRST step when the task is recurring, scheduled, or would be fragile via UI automation. Almost all major platforms have REST APIs (Slack, GitHub, Jira, Gmail, Notion, Linear, Stripe, etc.). Do NOT use for one-off tasks — just do the action directly.

## file.bridge — key action rules

- "check the bridge" / "any ThinkDrop instructions?" → `action: "read"` + `synthesize`. Never write anything back for read-only checks.
- "act on the bridge" → `action: "read"` to get pending blocks, execute each, then `file.bridge write` with `prefix: "TD"`, `blockType: "RESULT"`, `status: "done"`
- "tell Windsurf/Cursor to X" → `action: "write"`, `message: "<instruction>"`
- "wait for Windsurf response" → `action: "poll"`, `filterPrefix: "WS"`

## IDE setup onboarding

| IDE | Rules file |
|-----|-----------|
| Windsurf | `.windsurfrules` in project root |
| Cursor | `.cursorrules` in project root |
| VS Code + Copilot | `.github/copilot-instructions.md` |
| Warp | Settings → AI → Custom Instructions |
| Zed | `.zed/settings.json` → `assistant.default_context` |

For unknown IDEs: plan a `web.search` step first to find the rules file location, then `synthesize` with setup instructions.

## schedule — deferred execution

Use as the FIRST step when user says "at 8pm", "in 30 minutes", "wait an hour then". Use `time` for clock time or `delayMs` for a duration. Do not use for recurring tasks (suggest cron/launchd via `api_suggest` instead).

## external.skill — user-installed skills

When `matchedSkillName` is set in context, use `external.skill` as the ONLY step with `name` matching exactly.

```json
{ "skill": "external.skill", "args": { "name": "check.weather.daily", "args": { "city": "New York" } } }
```

The skill contract's "What this skill does" section describes inputs — extract them from the user message.

## needs_skill — capability gap

**Use `needs_skill` as the FIRST AND ONLY step (no browser.act, no shell.run, no api_suggest before it) when the request requires ongoing background automation that ThinkDrop cannot do natively.**

ThinkDrop will automatically build, install, and configure the skill — including resolving any API credentials. You do NOT need to scaffold files or add a `shell.run` step after `needs_skill`.

### Always use `needs_skill` immediately for these task types — do NOT attempt browser.act or api_suggest first:

| Task type | Example |
|-----------|---------|
| Email / inbox monitoring | "watch my Gmail and summarize daily", "alert me when I get mail from X" |
| Scheduled SMS / text notifications | "send me a daily text summary at 9pm", "text me my schedule every morning" |
| Calendar monitoring & reminders | "check my Google Calendar and remind me of events", "daily calendar briefing" |
| Slack / Discord / messaging monitoring | "watch my Slack and summarize daily", "alert me on new Discord messages" |
| Any recurring/scheduled background task | "every day at X", "every night", "every morning", "weekly digest" |
| Third-party service sync | "sync Notion", "poll Airtable", "monitor my Jira issues" |
| OAuth-gated data access requiring a long-running daemon | Gmail API, Google Calendar API, Twilio SMS, etc. |

**Why:** These tasks require a persistent background process (cron job, daemon, or webhook) with API credentials. ThinkDrop's browser.act is session-based and cannot run in the background. A custom skill (installed at `~/.thinkdrop/skills/`) is the correct mechanism. ThinkDrop's agent pipeline handles credential setup automatically.

**Rule:** If the user asks to **watch / monitor / track / poll / summarize on a schedule / send daily/weekly/nightly notifications** involving any external service → emit `needs_skill` immediately. Never navigate to the service's website, never add a `shell.run` scaffold step, and never suggest an API setup as a substitute.

`capability` should be a concise description of what the skill will do (max 10 words). `suggestion` should name the service(s) involved.

```json
[
  {
    "skill": "needs_skill",
    "args": {
      "capability": "send daily SMS weather alerts at 9pm",
      "suggestion": "twilio + openweathermap"
    }
  }
]
```

```json
[
  {
    "skill": "needs_skill",
    "args": {
      "capability": "watch Gmail inbox and send daily SMS summary",
      "suggestion": "gmail + twilio"
    }
  }
]
```

## Installing and removing skills

User-memory service is at `http://localhost:3001`.

**Install** — "install skill at \<path\>":
```json
[
  {
    "skill": "shell.run",
    "args": { "cmd": "bash", "argv": ["-c", "cat '<path>'"] },
    "description": "Read skill contract"
  },
  {
    "skill": "shell.run",
    "args": {
      "cmd": "bash",
      "argv": ["-c", "curl -s -X POST http://localhost:3001/skill.install -H 'Content-Type: application/json' -d \"{\\\"payload\\\":{\\\"contractMd\\\":$(cat '<path>' | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')},\\\"requestId\\\":\\\"install-$(date +%s)\\\"}\""]
    },
    "description": "Register skill in DB"
  }
]
```

**Remove** — "remove skill \<name\>":
```json
{ "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "curl -s -X POST http://localhost:3001/skill.remove -H 'Content-Type: application/json' -d '{\"payload\":{\"name\":\"<name>\"},\"requestId\":\"remove-1\"}'"] } }
```

**List** — "list my skills" / "what skills do I have":
```json
[
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "curl -s -X POST http://localhost:3001/skill.list -H 'Content-Type: application/json' -d '{\"payload\":{},\"requestId\":\"list-1\"}'"] } },
  { "skill": "synthesize", "args": { "prompt": "List the installed skills from this JSON, showing name and description for each." } }
]
```
