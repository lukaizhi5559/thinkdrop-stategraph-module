## LOCAL FILE EDITING — MANDATORY RULES

A local file is attached or resolved for this task. These rules override any conflicting guidance in the base prompt or other appendices.

### edit.agent is the ONLY skill that modifies existing local files

`edit.agent { goal, filePath, mode?, draftPath? }` — file I/O + LLM edit with safety rails: backup before write, atomic write, unified diff, open-document detection, draft/apply workflow.

- **Semantic/structural edits** — fix typos/grammar/spelling, rephrase, expand, refactor, restructure, add/remove sections → `edit.agent`. Name the target in the goal: a section title ("Section 1"), a line range ("lines 40-60"), or a few verbatim words from the text.
- **Office formats** (.docx/.xlsx/.doc/.rtf) → `edit.agent` — structured ops to a draft copy, never raw text writes.
- **Literal user-specified replacement only** ("change 'x' to 'y'") → `shell.run` sed/python3. Quality passes are semantic → `edit.agent`.
- **Creating NEW files** → `synthesize`+`saveToFile` or `file.write` — edit.agent is for existing files.

### Default to draft mode for interactive edits

- Emit `mode:"draft"` on edit.agent steps unless the user explicitly asked for immediate in-place modification (`mode:"inplace"`) or the run is unattended automation.
- A draft result (`draftPath` + `diff`, original untouched) is a **successful deliverable**, not a partial result — the user reviews the diff in the draft card and clicks Apply. Do NOT plan extra steps to "check whether the draft applied."
- Never plan a trailing `synthesize` step that just confirms a file edit — it cannot inspect the file and confabulates failure reports.

### Hard prohibitions

- **NEVER use `app.agent` keystrokes, shortcuts, `type_text`, paste, or run_app_flow to modify file contents.** app.agent is for app UI (open, close, navigate, focus) — not file editing. A plan that pastes or types content into TextEdit/VS Code to change a file bypasses every safety rail and can corrupt the user's live document.
- **NEVER modify an existing file via `synthesize` + `saveToFile`** or an inline write script — no backup, no diff, no open-doc protection.
- **NEVER `shell.run` writes to an attached file** (`>`, `tee`, `sed -i`, `rm`, `mv`, python `open(w)`) — the kernel sandbox denies them and the step auto-reroutes to edit.agent anyway.

### Plan shape for a file edit

Single step: `[{ "skill": "edit.agent", "args": { "goal": "<what to change, naming the target>", "filePath": "<resolved path>", "mode": "draft" } }]`. One edit.agent call handles locating, editing, and drafting — do not split into read → transform → write steps.
