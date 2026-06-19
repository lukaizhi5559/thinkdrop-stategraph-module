## Role
Extract content via clipboard with backup/restore and style preservation.

## Input
- App name: {appName}
- App category: {category} (browser|editor|chat|design|terminal|email|other)
- Current OCR state: {ocrText}
- Task: {task} (extract|edit)

## Mode: EXTRACT
Extract content from the active application without modifying it.

### Workflow
1. **Backup clipboard** — Save current clipboard content to temporary storage
2. **Clear clipboard** — Ensure clean state (optional, for large extractions)
3. **Select content** — Use category-specific strategy:
   - **browser**: `Cmd+L` (address bar) → `Tab` (content) → `Cmd+A` (select all page)
   - **editor**: `Cmd+1` (focus editor) → `Cmd+A` (select file content)
   - **chat**: Not recommended (use scroll + OCR instead — `Cmd+A` selects only input field)
   - **email**: Click reading pane → `Cmd+A` (select message content)
   - **other**: Conservative — verify before `Cmd+A`
4. **Copy** — `Cmd+C` to copy selected content
5. **Read clipboard** — `pbpaste` to get extracted content
6. **Restore original clipboard** — Restore from backup
7. **Save** — Store extracted content to `~/.thinkdrop/clipboard/{timestamp}_{app}_{action}.md`

### Output Format
```json
{
  "mode": "EXTRACT",
  "success": true,
  "content": "<extracted text>",
  "savedTo": "~/.thinkdrop/clipboard/2026-06-17T10-30-00_Chrome_extracted.md",
  "contentLength": 15234,
  "strategy": "Cmd+L then Tab then Cmd+A then Cmd+C",
  "clipboardRestored": true
}
```

## Mode: EDIT
Extract, modify, and paste back content while preserving formatting.

### Workflow
1. **Backup clipboard**
2. **Select and copy** content (category-specific strategy)
3. **Read clipboard** and save with RTF/HTML format detection
4. **Edit via LLM** — Provide edit instructions, get modified content
5. **Load to clipboard** — `pbcopy` with modified content
6. **Paste** — `Cmd+V` to replace original
7. **Verify** — OCR check: old content replaced with new
8. **Restore original clipboard**

### Output Format
```json
{
  "mode": "EDIT",
  "success": true,
  "originalLength": 15234,
  "modifiedLength": 14890,
  "formatPreserved": "markdown",
  "replacements": 3,
  "clipboardRestored": true
}
```

## Safety Rules
- **NEVER** lose clipboard content — always backup first
- **ALWAYS** restore clipboard even on error (try/finally pattern)
- **browser category**: `Cmd+A` selects ALL page content (safe for extraction)
- **chat category**: `Cmd+A` selects ONLY input field — use OCR scroll instead
- **Verify** before acting in "other" category apps

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
