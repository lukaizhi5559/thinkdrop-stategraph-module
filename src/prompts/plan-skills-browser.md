## Appendix: Browser Automation

Domain-specific guidance for `browser.agent` and `web.agent`. General skill list, routing hierarchy, output format, and template variables are in the base prompt.

### When to use `web.agent` before `browser.agent`

- **Public research / search / look-up (no login needed):** `web.agent` (`research_domain` or `search_and_navigate`) → `synthesize`. NEVER use `browser.agent` — no session needed. Use `web.crawl {{bestUrl}}` first if the full page text is required.
- **Public file download:** `web.agent { action: 'find_download', query, fileExt }` → `shell.run curl -sL -o <dest> {{bestUrl}}` → `shell.run file <dest>` verify. If `find_download` returns `isPage:true`, `web.crawl {{bestUrl}}` to find the real media link first.
- **Known bot blockers / CAPTCHA:** sites that block automated browsing or present CAPTCHA challenges
- **Unknown or uncertain domain:** the LLM may guess the wrong URL
- **Pattern (interactive only):** `web.agent search_and_navigate` → `browser.agent { action: 'run', url: '{{bestUrl}}' }` → `synthesize`

### Agent ID naming

Lowercase service name + `.agent` suffix:
`<service>.agent` (e.g., `<search-service>.agent`, `<wiki-service>.agent`, `<social-service>.agent`, `<chatbot-service>.agent`)

### Examples

**Search a named site — public look-up (NO login/interaction):**
```json
[
  { "skill": "web.agent", "args": { "action": "search_and_navigate", "query": "<query> site:<service>", "preferDomain": "<service>" }, "description": "Look up <query> on <service>" },
  { "skill": "synthesize", "args": { "prompt": "Present the results clearly to the user" }, "description": "Summarize the <service> results" }
]
```

**Search a named site — interactive (filter UI, add to cart, logged-in results):**
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

**Read a raw PUBLIC URL:**
```json
[
  { "skill": "web.crawl", "args": { "url": "https://<site>/page", "maxChars": 12000 }, "description": "Fetch readable text from the page" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the page content for the user" }, "description": "Summarize page content" }
]
```
Use `browser.agent` for a URL only when reading it requires login or page interaction.

**Bypass a bot blocker:**
```json
[
  { "skill": "web.agent", "args": { "action": "search_and_navigate", "query": "<search query> site:<site>", "preferDomain": "<site>" }, "description": "Find a direct article URL on <site>" },
  { "skill": "web.crawl", "args": { "url": "{{bestUrl}}", "maxChars": 12000 }, "description": "Read the article (public — no login needed)" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the article" }, "description": "Summarize the article" }
]
```
If `web.crawl` returns bot-blocked or empty content, escalate to `browser.agent { action: 'run', url: '{{bestUrl}}' }`.

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
- **Block-based document editors** (apps where content is built from discrete blocks via slash commands, `/` menus, or Enter-to-new-block — e.g. page builders, wiki editors, note apps with structured blocks): ALWAYS separate "create the page/document" from "add structured blocks" (todo lists, tables, headings, embeds). Each block type and each set of items is a distinct step. The browser agent cannot reliably create a page AND add multiple blocks in one continuous task — the editor's focus shifts after the title is set, and the agent loses track of where to type.

**WRONG (page + todo list in one step — agent gets stuck after the title):**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "[name].agent", "task": "Open <service>, create a new page called 'Weekly Goals', and add a todo list containing Buy pizza, Take out the Trash, and Go fishing" }, "description": "Create page and add todos" }
]
```

**RIGHT (decomposed — page creation and block content are separate steps):**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "[name].agent", "task": "Open <service> and create a new page called 'Weekly Goals'", "url": "https://<service>.new" }, "description": "Create 'Weekly Goals' page" },
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "[name].agent", "task": "On the 'Weekly Goals' page, add a todo list block with the items: Buy pizza, Take out the Trash, Go fishing" }, "description": "Add todo list items" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the 'Weekly Goals' page was created with the todo items: Buy pizza, Take out the Trash, Go fishing" }, "description": "Confirm page and todos" }
]
```

### Simple single-action exception (DO NOT decompose these)

The decompose rule above applies to tasks with **multiple independent actions** where the agent must search or gather content, OR where the task involves a block-based document editor (page builders, wiki editors, note apps with structured blocks) or structured content (lists, tables, boards, playlists). It does NOT apply to simple single-field forms where the user provides all content and there is only one logical "submit" action.

**Do NOT decompose these — use ONE `browser.agent` step:**
- **Email/message**: "send email to X with subject Y and body Z"
- **Social post**: "post 'Hello world' on <service>"
- **Reply**: "reply to this email/thread/message with '...'"
- **Comment**: "comment 'Nice work!' on this post/video"
- **Status/bio update**: "update my status to '...'"
- **Simple form fill**: "fill out this form with name=X, email=Y and submit"

**RIGHT (one step — user provided all content):**
```json
[
  { "skill": "browser.agent", "args": { "action": "run", "agentId": "[name].agent", "task": "Open <app-name> and send an email to <recipient> with the subject '<subject>' and the body '<body>'" }, "description": "Send the email to <recipient>" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the email was sent to <recipient>" }, "description": "Confirm email delivery" }
]
```

**Key rule:** Only decompose if the task has multiple INDEPENDENT actions, requires the agent to SEARCH for content to add, OR involves a block-based document editor where the agent must create a document and then add structured blocks. Simple "send/post/reply/comment X to Y" with a single form and submit does NOT need decomposition — the agent can fill all fields and submit in one continuous flow.

### Multi-agent browser.agent (independent — NO synthesize between steps)

When steps use different agents and are independent, no synthesize needed between them. Add a final `synthesize` to combine all results.

```json
[
  {"skill":"browser.agent","args":{"action":"run","agentId":"[name].agent","task":"What are the best vegan foods to try?"},"description":"Ask <app-name>"},
  {"skill":"browser.agent","args":{"action":"run","agentId":"[name].agent","task":"What are the best vegan foods to try?"},"description":"Ask <app-name>"},
  {"skill":"browser.agent","args":{"action":"run","agentId":"[name].agent","task":"What are the best vegan foods to try?"},"description":"Ask <app-name>"},
  {"skill":"synthesize","args":{"prompt":"Compare the answers from <app-name>, <app-name>, and <app-name> about the best vegan foods."},"description":"Compare all answers"}
]
```

**MULTI-AGENT URL RULE:** When a plan has multiple `browser.agent` steps with different `agentId` values, each step MUST have its own URL appropriate for that agent's service. Do NOT copy the URL from one step to another step with a different agentId. If you don't know the correct URL for a service, omit the `url` field — the system will inject the correct deep-link URL per agent from preflight.

### browser.agent → shell.run (data passing — synthesize between steps)

When step 2 (different skill) needs the text output of step 1, insert `synthesize` and use `{{synthesisAnswer}}`.

```json
[
  {"skill":"browser.agent","args":{"action":"run","agentId":"[name].agent","task":"Find the top 5 bestselling <items> and their prices"},"description":"Scrape <ecommerce-service> for <items>"},
  {"skill":"synthesize","args":{"prompt":"Format the <items> data as a CSV with columns: name, price, rating. Data: {{PREV_OUTPUT}}"},"description":"Format as CSV"},
  {"skill":"shell.run","args":{"goal":"Save this CSV to ~/Desktop/<items>.csv: {{synthesisAnswer}}"},"description":"Save CSV file"},
  {"skill":"synthesize","args":{"prompt":"Confirm the <items> data was saved to ~/Desktop/<items>.csv."},"description":"Confirm"}
]
```
