## Appendix: Browser Automation

Domain-specific guidance for `browser.agent` and `web.agent`. General skill list, routing hierarchy, output format, and template variables are in the base prompt.

### When to use `web.agent` before `browser.agent`

- **Known bot blockers / CAPTCHA:** stackoverflow, reddit, twitter/X, paywalled news
- **Unknown or uncertain domain:** the LLM may guess the wrong URL
- **Pattern:** `web.agent search_and_navigate` → `browser.agent { action: 'run', url: '{{bestUrl}}' }` → `synthesize`

### Agent ID naming

Lowercase service name + `.agent` suffix:
`biblegateway.agent`, `google.agent`, `duckduckgo.agent`, `wikipedia.agent`, `reddit.agent`, `chatgpt.agent`, `gemini.agent`, `perplexity.agent`

### Examples

**Search a named site:**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "biblegateway.agent", "task": "look up john 3:16" }, "description": "Look up John 3:16 on Bible Gateway" },
  { "skill": "synthesize", "args": { "prompt": "Present the Bible verse text clearly to the user" }, "description": "Summarize the Bible Gateway results" }
]
```

**Ask an AI chatbot:**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "chatgpt.agent", "task": "ask what the benefits of meditation are" }, "description": "Ask ChatGPT about meditation benefits" },
  { "skill": "synthesize", "args": { "prompt": "Present the AI's answer clearly" }, "description": "Present ChatGPT's response" }
]
```

**Read a raw URL:**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "task": "read and extract the main content from the page", "url": "https://some-random-site.com/page" }, "description": "Navigate and read the URL" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the page content for the user" }, "description": "Summarize page content" }
]
```

**Bypass a bot blocker:**
```json
[
  { "skill": "web.agent", "args": { "action": "search_and_navigate", "query": "latest mars news site:space.com", "preferDomain": "space.com" }, "description": "Find a direct article URL on Space.com" },
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "space.com.agent", "task": "extract the main article text", "url": "{{bestUrl}}" }, "description": "Read the article directly" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the Mars news article" }, "description": "Summarize the article" }
]
```

### Content creation tasks (playlists, documents, posts, boards)

When the user asks to CREATE something on a web service (playlist, document, board, post, event), the `task` string MUST be step-by-step — not a high-level description. The browser agent fills forms and clicks buttons; it cannot infer multi-step workflows from a vague task.

**Wrong (too vague — the agent will just search, not create):**
```json
{ "skill": "browser.agent", "args": { "action": "run", "agentId": "spotify.agent", "task": "Create a playlist named 'Christian Music' and add top songs from Lecrae, KB, and Newsboys" } }
```

**Right (step-by-step — the agent knows exactly what to do):**
```json
{ "skill": "browser.agent", "args": { "action": "run", "agentId": "spotify.agent", "task": "Go to https://open.spotify.com/. Click the '+' or 'Create playlist' button in the left sidebar. A new playlist will appear — click its title/name field and rename it to 'Christian Music'. Then for each artist (Lecrae, KB, Newsboys): click the search bar, type the artist name, press Enter, click on the artist, find their top 3 songs, and click the '...' menu → 'Add to playlist' → 'Christian Music' for each song." } }
```

**Key rules for content creation tasks:**
- ALWAYS start with the navigation step (go to the service's main page)
- ALWAYS include the "create" step explicitly (click Create/New/+, name the item)
- ALWAYS include each sub-step as a separate instruction (search for X, add Y, select Z)
- Use the gathered answers from prior context (e.g., playlist name, artist list, song preferences) directly in the task string
- The task string can be long — that's fine. Precision beats brevity for browser agents.
