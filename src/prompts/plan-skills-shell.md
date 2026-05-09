## Python scripts for data and file tasks

Python is the preferred tool for: file patching, JSON/CSV/Excel mutation, data analysis, complex conditional logic, and any task requiring packages. Use bash only for simple single-command system ops.

### Bash vs Python decision guide

| Task type | Use |
|-----------|-----|
| Open app, move file, list directory | `shell.run` bash |
| Simple pipeline (`grep \| sort \| uniq`) | `shell.run` bash |
| Edit a file in-place (replace text, add line) | `python3 -c` inline or temp script |
| JSON key mutation / schema update | `python3 -c 'import json...'` |
| CSV → Excel, data formatting, pivot tables | `synthesize(saveToFile)` Python script + `shell.run` |
| Nested if/for logic, multiple file mutations | Python temp script at `/tmp/thinkdrop_task.py` |
| Web scrape results → structured spreadsheet | `browser.act` collect → Python script → Excel |

### Python temp script pattern (preferred for anything > 3 lines of logic)

```json
[
  { "skill": "synthesize", "args": { "prompt": "Write a Python script that [TASK]. Use only stdlib unless packages are needed. Output ONLY the Python code, no markdown fences.", "saveToFile": "/tmp/thinkdrop_task.py" } },
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "python3 /tmp/thinkdrop_task.py"] } }
]
```

### Python inline pattern (≤3 lines of logic)

```json
{ "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "python3 -c \"import pathlib,json; p=pathlib.Path('/path/file.json'); d=json.loads(p.read_text()); d['version']='2.0.0'; p.write_text(json.dumps(d,indent=2))\""] } }
```

### pip3 install pattern — ALWAYS audit before installing

```json
[
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "pip3 install pip-audit --quiet --user 2>/dev/null; pip-audit 2>/dev/null | grep -i PACKAGE | grep -i vuln && echo 'BLOCKED: vulnerability found' || pip3 install PACKAGE --quiet --user"] } },
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "python3 /tmp/thinkdrop_task.py"] } }
]
```

**NEVER install a package flagged with known CVEs.** Offer the user an alternative package instead.

### brew install pattern — auto-install missing CLI tools

When a `shell.run` step depends on a CLI tool that may not be installed, guard with a check-and-install one-liner:

```json
{ "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "command -v TOOL >/dev/null 2>&1 || brew install TOOL"] } }
```

**Rules:**
- Use `brew install` for macOS system tools (imagemagick, ffmpeg, pdftotext/poppler, jq, wget, gh, awscli, etc.)
- Use `pip3 install --user` (with pip-audit check) for Python packages
- Always check with `command -v TOOL` before installing — never unconditionally install
- Chain the guard inline with the real command using `&&`:

```json
{ "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "command -v ffmpeg >/dev/null 2>&1 || brew install ffmpeg && ffmpeg -i input.mp4 output.mp3"] } }
```

**Common tool → brew formula mapping:**

| Tool needed | brew install |
|-------------|--------------|
| `pdftotext` | `brew install poppler` |
| `ffmpeg` | `brew install ffmpeg` |
| `jq` | `brew install jq` |
| `imagemagick` / `convert` | `brew install imagemagick` |
| `gh` (GitHub CLI) | `brew install gh` |
| `wget` | `brew install wget` |
| `tesseract` (OCR) | `brew install tesseract` |
| `exiftool` | `brew install exiftool` |
| `pandoc` | `brew install pandoc` |

**NEVER use `sudo brew install`** — brew on macOS never requires sudo.
**NEVER use `apt-get` or `yum`** — macOS only; use brew for all system package installs.

## Reading files by type

| Format | How to read |
|--------|-------------|
| `.txt` `.md` `.json` `.csv` `.js` `.py` etc. | `bash -c "cat '/path/to/file'"` |
| `.rtf` `.docx` `.pages` | `bash -c "textutil -convert txt -stdout '/path/to/file'"` |
| `.pdf` | `bash -c "pdftotext '/path/to/file' -"` (requires poppler) |
| Images (`.jpg` `.png` `.webp` etc.) | `image.analyze` with `filePath` and `query` |
| `.zip` `.tar.gz` | `bash -c "unzip -l '/path/to/file.zip'"` to list |

Prefer `fs.read` with `action: "explore"` to understand a codebase, `action: "tree"` for structure, `action: "search"` for pattern search.

## Writing/saving files

Use `synthesize` with `saveToFile` for plain text formats. The `synthesize` prompt MUST NOT include file content — it is auto-injected from prior `shell.run` stdout. Always instruct it to output the COMPLETE replacement content, no preamble.

## Critical shell.run rules

- **Get repo owner/name from git remote (when not provided by user):**
```bash
git remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/\.git$//'
```

- **shell.run JSON body quoting — CRITICAL when user message text may contain apostrophes:**
Always assign user-provided text to a shell variable, then expand inside double-quoted `-d "..."`. Never put user text directly inside single-quoted JSON.

```bash
MSG='what'"'"'s up'; curl -X POST https://api.example.com/send -u "$U:$K" -H 'Content-Type: application/json' -d "{\"messages\":[{\"body\":\"$MSG\"}]}"
```

- **Locating a file by name:** `mdfind -name 'filename' | head -1` (Spotlight, <1s). NEVER use `find /Users` or `find ~` — hangs on network volumes.
- **Finding a file then reading it:** always 3 steps: (1) `mdfind`, (2) `cat`, (3) `synthesize`.
- **`find` on user directories — ALWAYS `-maxdepth 1` by default.** No recursion unless user says "recursively / subfolders / children / nested". Use `-exec {} +` (batch) NOT `-exec {} \;` (per-item subprocess, hangs on large trees). Example: `find ~/Desktop -maxdepth 1 -exec CMD {} +`.
- **macOS Finder color tags** — color labels are stored in THREE keys: `com.apple.FinderInfo` (primary — the visible colored dot), `com.apple.metadata:_kMDItemUserTags`, and `com.apple.metadata:kMDLabel_*`. Must clear ALL of them. Correct loop (no recursion):
  ```bash
  for f in ~/Desktop/*; do
    xattr -d com.apple.FinderInfo "$f" 2>/dev/null
    xattr -d com.apple.metadata:_kMDItemUserTags "$f" 2>/dev/null
    for k in $(xattr "$f" 2>/dev/null | grep kMDLabel); do xattr -d "$k" "$f" 2>/dev/null; done
  done
  ```
  Single item: `xattr -d com.apple.FinderInfo /path 2>/dev/null; xattr -d com.apple.metadata:_kMDItemUserTags /path 2>/dev/null`. NEVER target only `_kMDItemUserTags` — Finder colored dots come from `FinderInfo`, not from that key. NEVER `find ... -exec xattr -d {} \;` — recurses + hangs.
- **`synthesize` with `saveToFile`** — ONLY when user explicitly asks to save/write/create a file.
- **NEVER use `shell.run curl` to call external API services** — use `browser.agent` or `cli.agent` for ALL external services.
