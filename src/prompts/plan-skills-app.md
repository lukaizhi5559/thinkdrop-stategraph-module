## Appendix: Desktop App Automation (app.agent)

Domain-specific guidance for `app.agent`. General skill list, routing hierarchy, output format, and template variables are in the base prompt. For desktop tasks, prefer `shell.run` first; use `app.agent` only when the task requires direct app interaction.

## Three-Tier Priority

| Tier | Skill | When to use |
|------|-------|-------------|
| **1 — Shell (most stable)** | `shell.run` | Any task achievable via unix/macOS CLI command |
| **2 — Shortcut** | `app.agent execute_shortcut` | Only when shell cannot do it AND app is verified focused |
| **3 — NutJS / low-level** | `app.agent` low-level | Only when no shortcut exists or shortcut fails twice |

## Actions Reference

### Phase 1 — Screen Parsing & Highlighting

| Action | When to use |
|--------|-------------|
| `get_recent_ocr` | Read current screen state (text + app metadata) |
| `find_elements` | Search for UI elements matching text in parsed OCR data |
| `highlight_all` | Highlight every visible text element on screen via GhostLayer overlay |
| `highlight_boundaries` | Draw bounding boxes around text clusters/sections on screen |
| `highlight_assets` | Highlight inferred icon/asset gaps on screen |
| `highlight_search` | Highlight specific text matches — requires `searchText` arg |
| `highlight_elements` | Draw GhostLayer boxes around specific element bounding boxes |
| `clear_highlights` | Remove all GhostLayer highlights from screen |
| `analyze_spatial_grid` | Analyze visible screen and return labeled spatial sections |

### Phase 2 — App Taxonomy & Context

| Action | When to use |
|--------|-------------|
| `enrich_app_context` | Warm boundary + shortcut caches for an app — call on first interaction |
| `discover_shortcuts` | Look up known keyboard shortcuts for an app + category combo |
| `get_boundaries` | Retrieve cached boundary layout for the current app/window |
| `infer_main_region` | Find the main content region center coordinates |
| `clear_boundary_cache` | Force-clear cached boundary layout after major UI change |

### Phase 3 — Shortcuts, Scroll & Monitoring

| Action | When to use |
|--------|-------------|
| `verify_app_focused` | Wait for app to open/load/be ready (OCR polls, no LLM calls) |
| `execute_shortcut` | Keyboard shortcuts (after focus verified) |
| `teleport_to_element` | Cmd+F navigation to jump to and focus an anchor text element |
| `scroll` | Auto-routes to correct scroll mode based on app category |
| `search_scroll` | Scroll up/down to find content by keyword (run `enrich_app_context` first) |
| `ai_response_scroll` | Scroll and use LLM to detect when AI assistant stops responding |
| `live_chat_scroll` | Watch for new incoming messages via monitorService watchMode |
| `passive_read_scroll` | Scroll down accumulating all visible text |
| `monitor_with_backoff` | ONLY for waiting on AI streaming responses to finish (uses LLM diff, expensive) |
| `monitor_file_upload` | Watch for upload progress/completion indicators on screen |
| `monitor_build_completion` | Watch terminal/IDE output for build success or failure patterns |
| `monitor_form_submission` | Watch for form submit success/error state changes |

### Phase 4 — Clipboard Agent

| Action | When to use |
|--------|-------------|
| `extract_content_via_clipboard` | Select-all + copy page text via clipboard (automatically backs up and restores clipboard) |
| `clipboard_backup` | Save current clipboard contents to DB before overwriting |
| `clipboard_restore` | Restore previously backed-up clipboard from DB |

## Common Patterns

**Open app then run shortcut:**
```json
[
  { "skill": "shell.run", "args": { "goal": "open -a '<AppName>'" }, "description": "Launch or focus <AppName>" },
  { "skill": "app.agent", "args": { "action": "verify_app_focused", "appName": "<AppName>", "waitMs": 5000 }, "description": "Confirm <AppName> is focused" },
  { "skill": "app.agent", "args": { "action": "execute_shortcut", "appName": "<AppName>", "shortcutOverride": "<Shortcut>" }, "description": "Execute shortcut in <AppName>" }
]
```

**Scroll to find content in an app (search scroll — Mode A):**
```json
[
  { "skill": "app.agent", "args": { "action": "enrich_app_context", "appName": "<AppName>", "category": "<category>" }, "description": "Capture boundaries so scroll targets the correct panel" },
  { "skill": "app.agent", "args": { "action": "search_scroll", "scrollPlan": { "scrollMode": "search", "direction": "<up|down>", "stopKeyword": "", "purposeStatement": "<describe what should be visible on screen when the goal is achieved>", "maxScrolls": 20 }, "appName": "<AppName>", "category": "<category>" }, "description": "Scroll to find target content" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the content visible at the scroll target" }, "description": "Report findings" }
]
```

**Wait for AI to finish responding:**
```json
[
  { "skill": "app.agent", "args": { "action": "monitor_with_backoff", "goal": "Wait for the AI assistant to finish responding", "mode": "passive", "maxDurationMs": 60000, "appName": "<AppName>" }, "description": "Monitor until response is complete" },
  { "skill": "synthesize", "args": { "prompt": "Summarize what changed on screen after the response completed" }, "description": "Report result" }
]
```

## Browser Content Extraction (Copy Page Text via Clipboard)

When user asks to "copy all text", "extract text from page", "get page content", "copy all the text on this site", or anything that requires copying/extracting text from a browser tab or app page:

**CRITICAL — ALWAYS use the single `extract_content_via_clipboard` action.**
- NEVER generate a multi-step `execute_shortcut` chain (Cmd+L, Tab, Cmd+A, Cmd+C) for this purpose.
- NEVER use `browser.act` to focus the browser window first.
- `extract_content_via_clipboard` handles app focus, the shortcut chain, clipboard backup/restore, and the `pbpaste` retrieval internally.

**Example plan for "Copy all the text on this page":**
```json
[
  { "skill": "app.agent", "args": { "action": "extract_content_via_clipboard", "appName": "<AppName>", "category": "browser" }, "description": "Select-all + copy page text via clipboard (backs up and restores clipboard)" },
  { "skill": "synthesize", "args": { "prompt": "Present the extracted page text to user in a clear, organized format. Include headings if the page had clear section structure." }, "description": "Present extracted text to user" }
]
```

**Cross-domain example — "Copy all text and save to a file on the desktop":**
```json
[
  { "skill": "app.agent", "args": { "action": "extract_content_via_clipboard", "appName": "<AppName>", "category": "browser" }, "description": "Copy all text from the current browser page to the clipboard" },
  { "skill": "shell.run", "args": { "goal": "Write the clipboard contents to a plain-text file on the desktop: pbpaste > ~/Desktop/<filename>.txt" }, "description": "Save clipboard content to a file on the desktop" },
  { "skill": "synthesize", "args": { "prompt": "Confirm to the user that the file was saved to the desktop and report the file path." }, "description": "Confirm desktop file saved" }
]
```

## Screen Highlighting — GhostLayer Overlay

ThinkDrop has a built-in screen highlighting system. These `app.agent` actions are single-step and self-contained — no OCR pre-step or synthesize post-step is needed.

**CRITICAL RULES:**
- NEVER use `get_recent_ocr` → `synthesize` for highlight requests — use the direct highlight action
- NEVER add a pre-step to "capture screen first"
- NEVER add a synthesize step after highlighting — the visual overlay IS the output
- Use `clear_highlights` when user asks to remove/clear/dismiss highlights

| User intent | Action to use |
|-------------|---------------|
| "highlight all text", "highlight everything" | `highlight_all` |
| "highlight sections", "show text boundaries" | `highlight_boundaries` |
| "highlight icons", "show assets" | `highlight_assets` |
| "highlight [word/phrase]" | `highlight_search` + `searchText` |
| "clear highlights" | `clear_highlights` |

## Keyboard Shortcuts Discovery Pattern

When user asks "what are the keyboard shortcuts for [AppName]?":

```json
[
  { "skill": "app.agent", "args": { "action": "discover_shortcuts", "appName": "<AppName>" }, "description": "Look up known keyboard shortcuts for <AppName>" },
  { "skill": "synthesize", "args": { "prompt": "Present the keyboard shortcuts for <AppName> in a well-organized table grouped by category. Show shortcut key combination and what it does." }, "description": "Present <AppName> keyboard shortcuts to user" }
]
```
