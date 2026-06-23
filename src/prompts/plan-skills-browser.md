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
