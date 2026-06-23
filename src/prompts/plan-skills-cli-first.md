## Appendix: cli.agent Usage

Domain-specific guidance for `cli.agent`. The base prompt already establishes CLI-first routing and the general priority order (CLI → API → browser). This appendix covers the `cli.agent` action contract and common patterns.

## Required Action Contract

Every `cli.agent` step MUST include the `action` field. Valid values:
- `"action": "run"` — execute an existing registered agent (also requires `agentId` and `task`)
- `"action": "build_agent"` — discover, install, and generate a new agent (also requires `service`)

A `cli.agent` step WITHOUT an `action` field will always fail with `Unknown action: "undefined"`. Never omit it.

## Discovery Pattern

When a task could be served by a CLI but no agent is registered yet:

### Step 1: Check AVAILABLE AGENTS block first
If a matching `[cli]` agent is listed → use it directly:
```json
{ "skill": "cli.agent", "args": { "action": "run", "agentId": "<exact-id>", "task": "<user goal verbatim>" } }
```

### Step 2: If no agent exists → discover and build
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
- Generates a descriptor with `pre_steps` if needed
- Stores the agent in the registry for reuse

### Step 3: Fallback to browser.agent if CLI unavailable
```json
{ "skill": "browser.agent", "args": { "action": "run", "agentId": "<domain>.agent", "task": "<user goal verbatim>" } }
```

## pre_steps — LLM-Inferred Input Resolution

When a CLI agent is built via `build_agent`, the LLM analyzes the tool's `--help` output and automatically infers what external inputs it needs. These are stored as `pre_steps` in the agent descriptor and executed automatically before the agentic loop.

| Purpose | What it resolves | Injected as | Example tools |
|---|---|---|---|
| `resolve_url` | Web search → extracts first URL from results | `{{resolvedUrl}}` or appends `URL: <url>` | yt-dlp, wget, gallery-dl |
| `resolve_file` | Extracts filename from task → resolves absolute path | `{{resolvedFile}}` or appends `FILE: <path>` | ffmpeg, pandoc, imagemagick |
| `resolve_query` | Web search → extracts structured query from top result title | `{{resolvedQuery}}` or appends `QUERY: <text>` | Tools needing structured search strings |

The planner does NOT need separate steps for this — `cli.agent run` executes all declared `pre_steps` automatically before the loop starts.

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
