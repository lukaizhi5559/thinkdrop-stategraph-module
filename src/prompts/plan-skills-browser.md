## Appendix: Browser Automation

Domain-specific guidance for `browser.agent` and `web.agent`. General skill list, routing hierarchy, output format, and template variables are in the base prompt.

### When to use `web.agent` before `browser.agent`

- **Known bot blockers / CAPTCHA:** sites that block automated browsing or present CAPTCHA challenges
- **Unknown or uncertain domain:** the LLM may guess the wrong URL
- **Pattern:** `web.agent search_and_navigate` → `browser.agent { action: 'run', url: '{{bestUrl}}' }` → `synthesize`

### Agent ID naming

Lowercase service name + `.agent` suffix:
`<service>.agent` (e.g., `<search-service>.agent`, `<wiki-service>.agent`, `<social-service>.agent`, `<chatbot-service>.agent`)

### Examples

**Search a named site:**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "<service>.agent", "task": "look up <query>" }, "description": "Look up <query> on <service>" },
  { "skill": "synthesize", "args": { "prompt": "Present the results clearly to the user" }, "description": "Summarize the <service> results" }
]
```

**Ask an AI chatbot:**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "<chatbot-service>.agent", "task": "ask <question>" }, "description": "Ask <chatbot-service> <question>" },
  { "skill": "synthesize", "args": { "prompt": "Present the AI's answer clearly" }, "description": "Present <chatbot-service> response" }
]
```

**Read a raw URL:**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "task": "read and extract the main content from the page", "url": "https://<site>/page" }, "description": "Navigate and read the URL" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the page content for the user" }, "description": "Summarize page content" }
]
```

**Bypass a bot blocker:**
```json
[
  { "skill": "web.agent", "args": { "action": "search_and_navigate", "query": "<search query> site:<site>", "preferDomain": "<site>" }, "description": "Find a direct article URL on <site>" },
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "<service>.agent", "task": "extract the main article text", "url": "{{bestUrl}}" }, "description": "Read the article directly" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the article" }, "description": "Summarize the article" }
]
```

### Content creation tasks (playlists, documents, posts, boards)

When the user asks to CREATE something on a web service (playlist, document, board, post, event), DECOMPOSE the task into MULTIPLE `browser.agent` steps — each with ONE clear action. The browser agent fills forms and clicks buttons; a single monolithic step with many actions will get stuck. Breaking it into steps ensures each action is independently verifiable and recoverable.

**WRONG (one monolithic step — agent gets stuck):**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "<service>.agent", "task": "Open <service>, create a <collection> named <name>, and add <items> from <source-A>, <source-B>, and <source-C>" }, "description": "Create <collection> and add <items>" }
]
```

**RIGHT (decomposed — browser state carries over between steps):**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "<service>.agent", "task": "Open <service> and create a new <collection> named <name>" }, "description": "Create <collection>" },
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "<service>.agent", "task": "Search for <source-A> and add 3 top <items> to the <name> <collection>" }, "description": "Add <source-A> <items>" },
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "<service>.agent", "task": "Search for <source-B> and add 3 top <items> to the <name> <collection>" }, "description": "Add <source-B> <items>" },
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "<service>.agent", "task": "Search for <source-C> and add 3 top <items> to the <name> <collection>" }, "description": "Add <source-C> <items>" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the <name> <collection> was created with <items> from <source-A>, <source-B>, and <source-C>." }, "description": "Confirm <collection>" }
]
```

**Key rules for content creation tasks:**
- ALWAYS decompose into multiple `browser.agent` steps — one step per distinct action
- ALWAYS start with the navigation + creation step (go to the service, click Create/New/+, name the item)
- ALWAYS include each sub-action as a separate step (search for X, add Y, select Z)
- Consecutive same-agent steps reuse the same browser session automatically — no synthesize between them
- Use the gathered answers from prior context (e.g., collection name, item list, preferences) directly in the task strings
- Each task string should be clear and specific — the browser agent follows it literally
- Always add a final `synthesize` step to confirm the overall task
