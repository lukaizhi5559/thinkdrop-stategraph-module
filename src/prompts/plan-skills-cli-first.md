## CLI-First Strategy for command_automate Tasks

For ANY task that could be served by a CLI tool, REST API, or Python script — try those paths FIRST before `browser.agent`. This applies to: media extraction, file conversion, data processing, messaging, cloud ops, IoT, spreadsheets, documents, image processing, audio, and more.

**Priority order:**
1. `cli.agent` — discovered CLI binary (yt-dlp, ffmpeg, imagemagick, pandoc, csvkit, gh, aws, etc.)
2. `cli.agent` with API key flow (curl/REST services with no browser needed)
3. `shell.run` Python script (local processing, pip-installable tools)
4. `browser.agent` — ONLY when no CLI/API path exists, or when the task requires OAuth login/account interaction

---

## REQUIRED: cli.agent arg contract

Every `cli.agent` step MUST include the `action` field. Valid values:
- `"action": "run"` — execute an existing registered agent (also requires `agentId` and `task`)
- `"action": "build_agent"` — discover, install, and generate a new agent (also requires `service`)

A `cli.agent` step WITHOUT an `action` field will **always fail** with `Unknown action: "undefined"`. Never omit it.

---

## CLI Discovery Pattern (use for ANY domain)

When a task could be served by a CLI but no agent is registered yet:

### Step 1: Check AVAILABLE AGENTS block first
If a matching `[cli]` agent is listed → use it directly:
```json
{ "skill": "cli.agent", "args": { "action": "run", "agentId": "<exact-id>", "task": "<user goal verbatim>" } }
```

### Step 2: If no agent exists → discover and build
The planner identifies the best CLI tool for the task based on domain knowledge, then lets `build_agent` discover, install, and configure it via web search + `--help`:
```json
{ "skill": "cli.agent", "args": { "action": "build_agent", "service": "<best-cli-name>" } }
```
Then run it:
```json
{ "skill": "cli.agent", "args": { "action": "run", "agentId": "<best-cli-name>.agent", "task": "<user goal verbatim>" } }
```

`build_agent` automatically:
- Searches for the CLI tool via npm/brew/pip
- Installs it if missing
- Reads `--help` to understand capabilities
- Generates a descriptor with `pre_steps` if needed (e.g. URL resolution via web.agent)
- Stores the agent in the registry for reuse

### Step 3: Fallback to browser.agent if CLI unavailable
```json
{ "skill": "browser.agent", "args": { "action": "run", "agentId": "<domain>.agent", "task": "<user goal verbatim>" } }
```

---

## CLI Tool Reference by Domain

| Task type | Best CLI to discover | Install hint |
|---|---|---|
| Video/audio extraction, transcript, subtitles | `yt-dlp` | brew |
| Audio/video conversion, encoding, merging | `ffmpeg` | brew |
| Image resize, convert, watermark | `imagemagick` (magick) | brew |
| Document convert (docx, pdf, epub, md) | `pandoc` | brew |
| CSV/spreadsheet processing | `csvkit` or `miller` | pip/brew |
| GitHub operations | `gh` | brew |
| AWS operations | `aws` (awscli) | brew |
| Cloud deploy (Heroku, Netlify, Vercel) | service CLI | npm |
| Send SMS via API | `curl` with provider REST API | — |
| Screen capture to file | `screencapture` (built-in macOS) | — |

The planner should identify the right service name and pass it to `build_agent` — web search discovery will find the right binary and install method automatically.

---

## pre_steps — LLM-Inferred Input Resolution

When a CLI agent is built via `build_agent`, the LLM analyzes the tool's `--help` output and automatically infers what external inputs it needs. These are stored as `pre_steps` in the agent descriptor and executed automatically before the agentic loop.

**Three inferred types:**

| Purpose | What it resolves | Injected as | Example tools |
|---|---|---|---|
| `resolve_url` | Web search → extracts first URL from results | `{{resolvedUrl}}` or appends `URL: <url>` | yt-dlp, wget, gallery-dl, curl |
| `resolve_file` | Extracts filename from task → resolves absolute path (~/Downloads, ~/Desktop, etc.) | `{{resolvedFile}}` or appends `FILE: <path>` | ffmpeg, pandoc, imagemagick, exiftool |
| `resolve_query` | Web search → extracts structured query from top result title | `{{resolvedQuery}}` or appends `QUERY: <text>` | Tools needing structured search strings |

The planner does NOT need separate steps for this — `cli.agent run` executes all declared `pre_steps` automatically before the loop starts. If the LLM is unavailable during `build_agent`, regex fallback detection handles common cases.

**Example flow (yt-dlp):** "Extract transcript from Natashas Kitchen sourdough tutorial"
1. `build_agent` runs `yt-dlp --help` → LLM infers `resolve_url` pre_step
2. `run` executes pre_step: web search → resolves `https://youtube.com/watch?v=...`
3. Loop task becomes: `"Extract transcript... URL: https://youtube.com/watch?v=..."`
4. yt-dlp agent uses the resolved URL directly

**Example flow (ffmpeg):** "Convert my lecture recording to mp3"
1. `build_agent` runs `ffmpeg --help` → LLM infers `resolve_file` pre_step
2. `run` executes pre_step: finds `lecture-recording.mp4` in ~/Downloads
3. Loop task becomes: `"Convert... FILE: /Users/you/Downloads/lecture-recording.mp4"`
4. ffmpeg agent uses the resolved path directly

---

## When NOT to Use CLI-First

Skip `cli.agent` and go directly to `browser.agent` when:
- The user explicitly names a registered browser agent: `"using my gmail.agent"`, `"via youtube.agent"`
- The task is pure browser navigation: `"go to"`, `"visit"`, `"navigate to"`, `"log into"`
- The task requires OAuth account interaction that has no CLI equivalent
- The user says `"open"` / `"browse to"` a specific website (not extraction/processing)

---

## Common CLI-First Plans

**Video/audio extraction:**
```json
[
  { "skill": "cli.agent", "args": { "action": "build_agent", "service": "yt-dlp" } },
  { "skill": "cli.agent", "args": { "action": "run", "agentId": "yt-dlp.agent", "task": "<user goal>" } },
  { "skill": "synthesize", "args": { "prompt": "Present the extracted content clearly" } }
]
```

**Image processing:**
```json
[
  { "skill": "cli.agent", "args": { "action": "build_agent", "service": "imagemagick" } },
  { "skill": "cli.agent", "args": { "action": "run", "agentId": "imagemagick.agent", "task": "<user goal>" } }
]
```

**File/document conversion:**
```json
[
  { "skill": "cli.agent", "args": { "action": "build_agent", "service": "pandoc" } },
  { "skill": "cli.agent", "args": { "action": "run", "agentId": "pandoc.agent", "task": "<user goal>" } }
]
```

**REST API call (no CLI binary, API key service):**
```json
[
  { "skill": "cli.agent", "args": { "action": "build_agent", "service": "<service-name>" } },
  { "skill": "cli.agent", "args": { "action": "run", "agentId": "<service-name>.agent", "task": "<user goal>" } }
]
```
