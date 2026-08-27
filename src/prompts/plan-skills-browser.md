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
