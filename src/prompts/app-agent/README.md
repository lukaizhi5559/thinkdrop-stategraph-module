# app.agent Sub-Agents

7 sub-agent architecture for desktop app automation via keyboard shortcuts + OCR.

## Sub-Agents

| Agent | Prompt File | Purpose |
|-------|-------------|---------|
| **Clipboard Agent** | `clipboard.md` | Extract content via clipboard with backup/restore |
| **Shortcut Agent** | `shortcut-keys.md` | Execute shortcuts with "what was there is no longer" verification |
| **Boundary Agent** | `boundary-box.md` | Position mouse for scrolling/clicks |
| **Monitoring Agent** | `monitoring.md` | Hybrid polling for screen state changes |
| **Recovery Agent** | `recovery.md` | Retry with alternative methods on failure |
| **State Validation Agent** | `state-validation.md` | Verify app is in expected state |
| **Interaction Agent** | `interaction.md` | Multi-step interactions (dialogs, wizards) |
| **Routing** | `routing.md` | Select appropriate sub-agent(s) |

## Implementation Status

| Phase | Component | Status |
|-------|-----------|--------|
| 1 | LiteParse + GhostLayer | ✅ Complete |
| 2 | App Taxonomy + Category System | ⚠️ Partial (needs background enrichment) |
| 3 | Monitoring + Scroll | ⚠️ Partial (needs scroll modes A-D) |
| 3.5 | "What was there is no longer" verification | ✅ Just added |
| 4 | Clipboard Agent | ✅ Complete |
| 5 | Virtual Document | ❌ Not started |
| 6 | Full Integration + Per-App Agents | ❌ Not started |

## Usage

```javascript
// Clipboard extraction
const result = await actionExtractContentViaClipboard({
  appName: 'Google Chrome',
  category: 'browser'
});

// Verified shortcut with target/placeholder check
const result = await actionVerifyShortcut({
  shortcutStr: 'Cmd+L',
  targetText: 'google.com',
  placeholder: 'Search or type a URL'
});

// Generic action verification
const result = await actionVerifyAction({
  beforeState: beforeOCR.text,
  afterState: afterOCR.text,
  targetText: 'hello'
});
```

## Category-Specific Clipboard Behavior

| Category | Cmd+A Behavior | Extraction Strategy |
|----------|----------------|---------------------|
| browser | Select all page content | `Cmd+L` → `Tab` → `Cmd+A` → `Cmd+C` |
| editor | Select current file content | `Cmd+1` → `Cmd+A` → `Cmd+C` |
| chat | Select only input field | Use scroll + OCR accumulation |
| design | Select all canvas objects | Specific element selection only |
| terminal | N/A (interrupt signal) | Selection copy only |
| email | Select all messages in list | Focus reading pane then `Cmd+A` |
| other | Unknown | Verify before acting |
