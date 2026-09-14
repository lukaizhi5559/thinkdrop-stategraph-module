## Appendix: Public Web Fetch & Download

Domain-specific patterns for PUBLIC web tasks — downloading files and reading public pages. These tasks need NO browser session, NO service agent, and NO authentication. Use `web.agent`, `web.crawl`, and `shell.run` (curl). Only escalate to `browser.agent` when the task requires an account, login, or page interaction — the recovery system escalates automatically if a cheap path gets bot-blocked.

### Download a public file (mp3, pdf, image, zip, csv, video, font, ...)

**Pattern B — find then download (default):**
```json
[
  { "skill": "web.agent", "args": { "action": "find_download", "query": "<description of asset> filetype:<ext>", "fileExt": "<ext>" }, "description": "Find a direct <ext> download link" },
  { "skill": "shell.run", "args": { "cmd": "curl", "argv": ["-sL", "-o", "~/Downloads/<filename>.<ext>", "{{bestUrl}}"] }, "description": "Download the file" },
  { "skill": "shell.run", "args": { "cmd": "file", "argv": ["~/Downloads/<filename>.<ext>"] }, "description": "Verify the downloaded file type" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the file was downloaded to ~/Downloads/<filename>.<ext> and report what `file` says it is." }, "description": "Confirm download" }
]
```

**Pattern A — direct asset URL given by the user:**
```json
[
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "curl -sIL '<url>' | grep -i '^content-type'"] }, "description": "Check the URL's content type" },
  { "skill": "shell.run", "args": { "cmd": "curl", "argv": ["-sL", "-o", "~/Downloads/<filename>", "<url>"] }, "description": "Download the file" },
  { "skill": "shell.run", "args": { "cmd": "file", "argv": ["~/Downloads/<filename>"] }, "description": "Verify the downloaded file type" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the download and report the verified file type and path." }, "description": "Confirm download" }
]
```

**Pattern C — asset is behind a page (find_download returned isPage, or page URL given):**
```json
[
  { "skill": "web.crawl", "args": { "url": "<page-url>", "maxChars": 12000 }, "description": "Fetch the page and look for media/download links" },
  { "skill": "synthesize", "args": { "prompt": "Extract the direct media file URL (ending in .<ext>) from this page content. Output ONLY the URL." }, "description": "Extract media URL" },
  { "skill": "shell.run", "args": { "goal": "Download this URL to ~/Downloads/<filename>.<ext> using curl -sL -o: {{synthesisAnswer}} then run `file` on it to verify" }, "description": "Download and verify" },
  { "skill": "synthesize", "args": { "prompt": "Confirm the download and report the verified file type and path." }, "description": "Confirm download" }
]
```

**Download rules:**
- ALWAYS run `file <dest>` after downloading — `HTML document` or `ASCII text` output means the download FAILED (bot wall, redirect, or a page instead of the asset). Do NOT claim success; the failure will trigger recovery which escalates to web.crawl/browser.agent.
- Default destination: `~/Downloads` unless the user specifies a path.
- Derive a sensible filename from the asset description (e.g. `internet-connect.mp3`, `bird-chirp.mp3`) — never leave a query-string or hash as the filename.
- curl IS allowed and preferred for public downloads — the "no curl for external services" ban applies ONLY to authenticated API services (OAuth, api_key, bearer tokens).

### Public web research ("look up X", "find X on <site>", "read this article")

**Research without a named site:**
```json
[
  { "skill": "web.agent", "args": { "action": "research_domain", "query": "<the user's research question>" }, "description": "Search the web for <topic>" },
  { "skill": "synthesize", "args": { "prompt": "Answer the user's question using these search results." }, "description": "Present findings" }
]
```

**Research on a named site (search/browse/read listings or articles):**
```json
[
  { "skill": "web.agent", "args": { "action": "site_search", "domain": "<domain>", "query": "<user's search terms>" }, "description": "Resolve <domain> search URL for <query>" },
  { "skill": "web.crawl", "args": { "url": "{{bestUrl}}", "fallbackUrls": "{{fallbackUrls}}", "maxChars": 12000, "extractItems": true }, "description": "Fetch the page content and extract listing cards from <domain>" },
  { "skill": "synthesize", "args": { "prompt": "Give a brief summary of the results. The listing cards (image, title, price, link) are shown to the user automatically — do not re-list every item." }, "description": "Present findings" }
]
```

**Find a link only (answer IS the URL, no content needed):**
```json
[
  { "skill": "web.agent", "args": { "action": "search_and_navigate", "query": "<query> site:<domain>", "preferDomain": "<domain>" }, "description": "Find <query> on <domain>" },
  { "skill": "synthesize", "args": { "prompt": "Present the best results (title, link, snippet) to the user." }, "description": "Present findings" }
]
```

**Read a specific public page (full text needed):**
```json
[
  { "skill": "web.crawl", "args": { "url": "<url>", "maxChars": 12000 }, "description": "Fetch readable text from the page" },
  { "skill": "synthesize", "args": { "prompt": "Summarize/answer using the page content." }, "description": "Summarize page" }
]
```

**Extract videos/media from a page:**
```json
[
  { "skill": "web.crawl", "args": { "url": "<url>", "maxChars": 12000, "extractMedia": true }, "description": "Fetch the page and extract video/media cards" },
  { "skill": "synthesize", "args": { "prompt": "Give a brief summary. Video cards (thumbnail, title, duration, external-open link) are shown to the user automatically — do not re-list every video." }, "description": "Present findings" }
]
```

**Research rules:**
- NEVER use `browser.agent` for public research — it needs no session. `web.agent` + `web.crawl` + `synthesize` covers it.
- For "search <site> for X" / "show pics of X on <site>" / "find X for sale on <site>" tasks, use `web.agent { action: "site_search", domain: "<domain>", query: "<user's search terms>" }`. This resolves directly to the site's search-results URL (e.g. amazon.com/s?k=…) so the crawl lands on the SERP, not a single product page. Fall back to `search_and_navigate` only for sites without a known search template.
- When the user asks to search/browse a specific site for items/listings/content, ALWAYS add `web.crawl {{bestUrl}}` between `web.agent` and `synthesize`. `site_search`/`search_and_navigate` returns a URL pointer, not page content — `synthesize` cannot present results it doesn't have.
- When the user asks to find/list/browse/show items, products, listings, or search results on a site, set `"extractItems": true` on the `web.crawl` step. The renderer shows the extracted items as cards (image, title, price, link) automatically — the `synthesize` step should give a brief text summary, NOT re-list every item.
- When the user asks to find/show/watch videos on a page, set `"extractMedia": true` on the `web.crawl` step. Video cards (thumbnail with play badge, duration, external-open link) are shown automatically.
- Use the "Find a link only" pattern (no `web.crawl`) ONLY when the answer IS the URL itself ("where can I find X", "find me a link to Y").
- If the user wants deeper detail than the crawled page provides, add another `web.crawl` step on a specific result URL.
- `web.agent` `site_search` returns `{bestUrl, fallbackUrls, isSiteSearch, trust}` — use `{{bestUrl}}` to feed the URL into a `web.crawl` step. `search_and_navigate` returns `{bestUrl, title, snippet, fallbackUrls, allResults}` — use `{{fallbackUrls}}` as the `fallbackUrls` arg so web.crawl auto-retries alternate result URLs when the top pick lands on an error page, and `{{allResults}}` for fallback snippets.
- Naming a site does NOT mean the task needs an account — only route to `browser.agent` when the task requires login, posting, purchasing, or clicking through site UI.
