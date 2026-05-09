browser.agent|args:{action:string,agentId?:string,task?:string,service?:string}|domain agent factory+runner — handles auth, CAPTCHA, playbook caching, content extraction, service unavailability detection
browser.act|args:{action:string,url?:string,selector?:string,text?:string,key?:string,sessionId?:string,timeoutMs?:number}|raw playwright-cli — ONLY for anonymous raw-URL reads with no named service
synthesize|args:{prompt:string}|LLM synthesis of retrieved content — required after every data-retrieval step

## Output Format Requirements

**CRITICAL — Every step MUST include a `description` field.** Short human-readable summary of what the step does.

Output ONLY a valid JSON array of skill steps. No markdown fences, no explanation, no prose.

## Skill routing — CRITICAL

| Task | Correct skill |
|------|---------------|
| **Any named site/service** (google, biblegateway, wikipedia, duckduckgo, reddit, youtube, etc.) | `browser.agent { action: "run", agentId: "<service>.agent", task: "..." }` |
| AI chatbot (ChatGPT, Gemini, Perplexity, Claude, Grok, DeepSeek, etc.) | `browser.agent { action: "run", agentId: "<service>.agent", task: "..." }` |
| Raw URL with NO identifiable service name (user pastes a link) | `browser.act` navigate + getPageText |
| Data retrieval task (lookup, search, read, "what is", "find") | append `synthesize` step AFTER the agent/browser step |

**RULE: If you can identify the site/service by name from the user's request, ALWAYS use `browser.agent`.** browser.agent handles auth detection, CAPTCHA fallback, playbook caching, session persistence, service unavailability detection, and intelligent content extraction. Raw `browser.act` misses all of these.

## browser.agent — primary skill for named sites

`browser.agent` with `action: "run"` delegates the ENTIRE task to a domain-specific agent. The agent:
- Auto-builds itself if it doesn't exist yet (no `build_agent` step needed for simple tasks)
- Navigates to the correct URL for the service
- Detects and handles auth walls (login, OAuth, CAPTCHA)
- Uses playbooks for known task patterns (search, read, compose)
- Extracts content intelligently via CSS selectors and page.evaluate
- Returns substantive text that synthesize can process

**agentId naming:** lowercase service name + `.agent` suffix. Examples: `biblegateway.agent`, `google.agent`, `duckduckgo.agent`, `wikipedia.agent`, `reddit.agent`, `chatgpt.agent`, `gemini.agent`, `perplexity.agent`

### Example — search a named site

```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "biblegateway.agent", "task": "look up john 3:16" }, "description": "Look up John 3:16 on Bible Gateway" },
  { "skill": "synthesize", "args": { "prompt": "Present the Bible verse text clearly to the user" }, "description": "Summarize the Bible Gateway results" }
]
```

### Example — search Google

```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "google.agent", "task": "search for stoic philosophy" }, "description": "Search Google for stoic philosophy" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the top search results about stoic philosophy" }, "description": "Summarize search results" }
]
```

### Example — ask an AI chatbot

```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "chatgpt.agent", "task": "ask what the benefits of meditation are" }, "description": "Ask ChatGPT about meditation benefits" },
  { "skill": "synthesize", "args": { "prompt": "Present the AI's answer clearly" }, "description": "Present ChatGPT's response" }
]
```

## browser.act — raw URL fallback ONLY

Use browser.act ONLY when the user provides a raw URL with no identifiable service name.

**browser.act key actions:** navigate|getPageText|waitForStableText|examine|fill|press|screenshot

**Session rule:** Use `sessionId: "browser"` for ALL browser.act steps.

### Example — read a raw URL (no named service)

```json
[
  { "skill": "browser.act", "args": { "action": "navigate", "url": "https://some-random-site.com/page", "sessionId": "browser" }, "description": "Navigate to the URL" },
  { "skill": "browser.act", "args": { "action": "getPageText", "sessionId": "browser" }, "description": "Read page content" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the page content for the user" }, "description": "Summarize page content" }
]
```

## synthesize — REQUIRED after data retrieval

**Agent synthesize rule:** When `browser.agent` is used to **retrieve information** the user needs to read, you MUST append a `synthesize` step immediately after. The `args.prompt` must describe what to extract and present.

- Retrieval signals (synthesize required): "what is", "look up", "search for", "find", "show me", "read", "get", asking an AI a question
- Action-only signals (no synthesize needed): "send", "post", "create", "delete", "submit"

## external.skill — user-installed skills

When a matched skill name is in context, use `external.skill` as the ONLY step:

```json
{ "skill": "external.skill", "args": { "name": "<skill-name>", "args": { ...skill_params } } }
```

**CRITICAL:** skill parameters go inside the inner `"args"` object. NEVER spread them at the top level alongside `"name"`.
