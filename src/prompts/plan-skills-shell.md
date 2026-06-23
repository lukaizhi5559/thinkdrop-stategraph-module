## Appendix: Shell & File Operations

Domain-specific patterns for `shell.run`. The base prompt already establishes the skill hierarchy (CLI/shell first, app second, browser last) and general `shell.run` usage. This appendix adds concrete file-operation, install, and clipboard patterns.

## Python-First for File Operations

**Default to Python for file system work.** Bash is only for simple one-liners or when Python is unavailable.

| Task | Pattern |
|-----------|----------|
| **Move files** | `python3 -c "import shutil, pathlib; shutil.move(..., ...)"` |
| **Copy files** | `python3 -c "import shutil; shutil.copy2(..., ...)"` |
| **Create directories** | `python3 -c "import pathlib; pathlib.Path(...).mkdir(parents=True, exist_ok=True)"` |
| **List directories** | `python3 -c "import pathlib; [print(p) for p in pathlib.Path(...).iterdir()]"` |
| **Delete files** | `python3 -c "import pathlib; pathlib.Path(...).unlink()"` |
| **File existence check** | `python3 -c "import pathlib; exit(0 if pathlib.Path(...).exists() else 1)"` |
| **Edit file in-place** | `python3 -c` inline script |
| **JSON mutation** | `python3 -c 'import json...'` |
| **CSV/Excel processing** | Python temp script |
| **Simple pipeline (`grep | sort`)** | `shell.run` bash (exception) |
| **Open app** | `shell.run` bash with `open -a` (exception) |

### Python Temp Script Pattern (for complex logic)

```json
[
  { "skill": "synthesize", "args": { "prompt": "Write a Python script that [TASK]. Use only stdlib unless packages are needed. Output ONLY the Python code, no markdown fences.", "saveToFile": "/tmp/thinkdrop_task.py" } },
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "python3 /tmp/thinkdrop_task.py"] } }
]
```

### Python Inline Pattern (≤3 lines of logic)

```json
{ "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "python3 -c \"import pathlib,json; p=pathlib.Path('/path/file.json'); d=json.loads(p.read_text()); d['version']='2.0.0'; p.write_text(json.dumps(d,indent=2))\""] } }
```

## Installing Tools

### pip3 install pattern — ALWAYS audit before installing

```json
[
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "pip3 install pip-audit --quiet --user 2>/dev/null; pip-audit 2>/dev/null | grep -i PACKAGE | grep -i vuln && echo 'BLOCKED: vulnerability found' || pip3 install PACKAGE --quiet --user"] } },
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "python3 /tmp/thinkdrop_task.py"] } }
]
```

**NEVER install a package flagged with known CVEs.** Offer the user an alternative package instead.

### brew install pattern — auto-install missing CLI tools

```json
{ "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "command -v ffmpeg >/dev/null 2>&1 || brew install ffmpeg && ffmpeg -i input.mp4 output.mp3"] } }
```

**Rules:**
- Use `brew install` for macOS system tools (imagemagick, ffmpeg, pdftotext/poppler, jq, wget, gh, awscli, etc.)
- Use `pip3 install --user` (with pip-audit check) for Python packages
- Always check with `command -v TOOL` before installing — never unconditionally install
- Chain the guard inline with the real command using `&&`
- **NEVER use `sudo brew install`** — brew on macOS never requires sudo
- **NEVER use `apt-get` or `yum`** — macOS only; use brew for all system package installs

## Reading files by type

| Format | How to read |
|--------|-------------|
| `.txt` `.md` `.json` `.csv` `.js` `.py` etc. | `bash -c "cat '/path/to/file'"` |
| `.rtf` `.docx` `.pages` | `bash -c "textutil -convert txt -stdout '/path/to/file'"` |
| `.pdf` | `bash -c "pdftotext '/path/to/file' -"` (requires poppler) |
| Images (`.jpg` `.png` `.webp` etc.) | `image.analyze` with `filePath` and `query` |
| `.zip` `.tar.gz` | `bash -c "unzip -l '/path/to/file.zip'"` to list |

## Writing / saving files

Use `synthesize` with `saveToFile` for plain text formats. The `synthesize` prompt MUST NOT include file content — it is auto-injected from prior `shell.run` stdout. Always instruct it to output the COMPLETE replacement content, no preamble.

## Clipboard → File Pattern

When a prior step (e.g., `app.agent extract_content_via_clipboard`) has placed content on the clipboard and you need to save it to a file:

```json
[
  { "skill": "app.agent", "args": { "action": "extract_content_via_clipboard", "appName": "<AppName>", "category": "browser" }, "description": "Copy all text from the current page to the clipboard" },
  { "skill": "shell.run", "args": { "goal": "Write the clipboard contents to a plain-text file on the desktop: pbpaste > ~/Desktop/<filename>.txt" }, "description": "Save clipboard content to a desktop file" },
  { "skill": "synthesize", "args": { "prompt": "Confirm to the user that the file was saved and report the exact full path." }, "description": "Confirm file saved" }
]
```

**Rules:**
- Use `pbpaste` to read the system clipboard (not `{{PREV_OUTPUT}}` — the clipboard content is not stdout of the app.agent step)
- The filename MUST be derived from the current page/app title or use a generic timestamped name (e.g., `saved_clip_<timestamp>.txt`). NEVER hardcode a context-specific filename from a prior turn.
- Prefer a simple `pbpaste > /path/to/file.txt` or `pbpaste | python3 -c "...
- Use `synthesize` only if the user needs a confirmation message; otherwise the shell.run step is sufficient
- When a file is saved, the final `synthesize` step MUST include the exact file path (e.g., `Saved to ~/Desktop/SpaceX_IPO.txt`). Never omit the filename.

## Critical shell.run rules

- **Get repo owner/name from git remote (when not provided by user):**
```bash
git remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/\.git$//'
```

- **Locating a file by name:** `mdfind -name 'filename' | head -1` (Spotlight, <1s). NEVER use `find /Users` or `find ~` — hangs on network volumes.
- **Finding a file then reading it:** always 3 steps: (1) `mdfind`, (2) `cat`, (3) `synthesize`.
- **`find` on user directories — ALWAYS `-maxdepth 1` by default.** No recursion unless user says "recursively / subfolders / children / nested". Use `-exec {} +` (batch) NOT `-exec {} \;` (per-item subprocess, hangs on large trees). Example: `find ~/Desktop -maxdepth 1 -exec CMD {} +`.
- **macOS Finder color tags** — color labels are stored in THREE keys: `com.apple.FinderInfo` (primary), `com.apple.metadata:_kMDItemUserTags`, and `com.apple.metadata:kMDLabel_*`. Must clear ALL of them. NEVER use `find ... -exec xattr -d {} \;` — recurses + hangs.
- **`synthesize` with `saveToFile`** — ONLY when user explicitly asks to save/write/create a file.
- **NEVER use `shell.run curl` to call external API services** — use `browser.agent` or `cli.agent` for ALL external services.
- **Safe file move/copy — NEVER use wildcards that include the destination:** When moving files from a directory to a subfolder, the `*` wildcard includes the destination folder itself. Use specific file patterns OR exclude the destination:
  - CORRECT: `bash -c "mv ~/Desktop/*.txt ~/Desktop/dest/"`
  - CORRECT: `bash -c "find ~/Desktop -maxdepth 1 -type f ! -path '*thinkdrop-files*' -exec mv {} ~/Desktop/thinkdrop-files/ +"`
  - WRONG: `mv ~/Desktop/* ~/Desktop/thinkdrop-files/`

- **NEVER hard-code source directory paths in move operations when path is uncertain:** If the exact absolute path of the source directory was NOT explicitly provided by the user, resolve it at runtime with `mdfind`. Do NOT guess or derive paths from directory names.
