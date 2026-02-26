needs_install|args:{tool:string,installCmd:string,reason:string,source?:string,description?:string}|pauses_plan_asks_user_to_confirm_install
api_suggest|args:{app:string,reason:string,apiDocsUrl?:string,apiSetupPrompt?:string,guidePrompt?:string}|surfaces_API_offer_when_task_is_better_served_by_API
guide.step|args:{instruction:string,sessionId:string,timeoutMs?:number}|pauses_plan_shows_instruction_card_polls_window.__tdGuideTriggered_auto_advances_when_user_clicks_highlighted_element
schedule|args:{time?:string,delayMs?:number,label?:string}|waits_until_clock_time_or_delay_then_continues_plan
list_skills|args:{}|returns_full_skill_registry

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

## Critical skill selection rules

- **Opening apps** — always `shell.run open -a AppName`, never `ui.findAndClick`
- **Reading/writing files** — always `shell.run bash -c`, never open a GUI app
- **Editing an existing file** — read it first, then synthesize, then write
- **`ui.moveMouse`** — last resort only, when `ui.axClick` and keyboard shortcuts both failed
- **`image.analyze`** — for local image files only; never use for live screenshots (use `ui.screen.verify` for that)

## browser.act key actions

navigate|click|hover|smartType|type|keyboard|select|scroll|screenshot|evaluate|sleep|waitForContent|discoverInputs|getText|getPageText|getAttribute|waitForSelector|waitForNavigation|newPage|back|forward|reload|close|waitForAuth|highlight|scanSite|smartFill

- `highlight` — injects glow border + speech bubble on element; clicking it sets `window.__tdGuideTriggered = true` to auto-advance `guide.step`
- `waitForAuth` — uses persistent browser profile at `~/.thinkdrop/browser-sessions/<profile>/`; waits for login on first run, instant on subsequent runs
- `smartFill` — fills a form with `{field: value}` pairs; auto-discovers fields including contenteditable areas (use for Gmail compose)
- `scanSite` — headless scan, returns `{title, url, elements:[{tag,type,label,selector}]}`; use returned labels in `highlight` steps

## guide.step — interactive walkthroughs

For government sites, CAPTCHAs, login walls, OAuth setup, or any task requiring manual user action between steps:
1. `browser.act navigate` — open URL in visible Playwright browser
2. `browser.act highlight` — inject glow + speech bubble on target element (same `sessionId`)
3. `guide.step` — show instruction card, poll `window.__tdGuideTriggered`, auto-advance on click
4. Repeat highlight → guide.step per step

**Form-filling rule:** Create one `highlight` + `guide.step` pair PER FORM FIELD. Never collapse a full form into a single step.

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
