## MANDATORY: Python-First for ALL File Operations

**YOU MUST USE PYTHON for ALL file system operations.** Bash is ONLY for simple one-liners (echo, pwd, cd) or when Python is explicitly unavailable.

### CRITICAL RULE: File Operations = Python ONLY

| Task type | MUST Use |
|-----------|----------|
| **Move files** | `python3 -c "import shutil, pathlib; ..."` |
| **Copy files** | `python3 -c "import shutil; shutil.copy2(...)"` |
| **Create directories** | `python3 -c "import pathlib; pathlib.Path(...).mkdir(parents=True)"` |
| **List directories** | `python3 -c "import pathlib; [print(p) for p in pathlib.Path(...).iterdir()]"` |
| **Delete files** | `python3 -c "import pathlib; pathlib.Path(...).unlink()"` |
| **File existence check** | `python3 -c "import pathlib; exit(0 if pathlib.Path(...).exists() else 1)"` |
| Edit file in-place | `python3 -c` inline script |
| JSON mutation | `python3 -c 'import json...'` |
| CSV/Excel processing | Python temp script |
| Simple pipeline (`grep \| sort`) | `shell.run` bash (exception) |
| Open app | `shell.run` bash (exception) |

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

**Tool Installation:**
- Use `brew install [tool]` for macOS CLI tools
- Use `pip3 install --user` (with pip-audit check) for Python packages
- Always check with `command -v TOOL` before installing — never unconditionally install
- Chain the guard inline: `command -v ffmpeg >/dev/null 2>&1 || brew install ffmpeg && ffmpeg [args]`

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

## Python-First Shell Execution

**DEFAULT TO PYTHON for ALL shell.run operations.** Only fall back to Node.js or Bash when Python explicitly fails or isn't available.

### Discovery Process

When you need a tool or package, follow this order:

1. **Check existing skills** - Look for `external.skill` that already handles this task
2. **Search for best solution** - Use `web.search` to discover current recommendations:
   - "best python library for [task] recent"
   - "[task] python package comparison"
   - "how to [task] with python 2024"
3. **Test and save** - Try the discovered solution, save successful ones as `external.skill`
4. **Fallback to reference** - If search fails, consult the tool reference files

**Principles:**
- The Python ecosystem has 400,000+ packages - search to find the best fit
- Use `web.search` proactively for unfamiliar tasks
- Save working solutions as skills for instant reuse next time

### Graceful Degradation Pattern

When using external packages, write code that discovers and falls back gracefully:

```python
python3 -c "
import sys

# Try the best-fit package for this specific task
try:
    import best_package
    # Use best_package for the task
    result = best_package.do_something()
    print('Success with best_package')
    sys.exit(0)
except ImportError:
    pass

# Fallback to alternative that achieves similar results
try:
    import alternative_package
    result = alternative_package.do_something()
    print('Success with alternative_package')
    sys.exit(0)
except ImportError:
    pass

# Final fallback: stdlib, subprocess, or CLI tool
import subprocess
subprocess.run(['cli_tool', 'args'])
print('Success with cli_tool')
"
```

**Key principles:**
- Let the LLM choose packages based on task requirements, not from a fixed list
- Always have a working fallback (stdlib, subprocess, or CLI)
- Prefer stdlib solutions when they meet the needs

### Language Priority
```
1. Python (ALWAYS try first)
   ↓ If needed: search web for best package → test → save as skill
   ↓ Python completely fails
2. Node.js (if Node ecosystem needed)
   ↓ fails
3. Bash (simple commands only)
```

**For system CLI tools (ffmpeg, imagemagick, etc.):**
- Use `brew install [tool]` when needed
- Search "brew install [tool]" to confirm correct formula name
- Chain check: `command -v [tool] >/dev/null 2>&1 || brew install [tool] && [tool] [args]`

### When to Use Node.js
- Python is not installed or all Python approaches failed
- Package requires Node ecosystem (npm packages, webpack, etc.)
- React/Next.js project operations (next build, npm install)
- Existing Node scripts that can't be ported

### When to Use Bash
- Simple one-liners (cd, pwd, echo, mkdir -p)
- Command piping (ps aux | grep, cat file | wc -l)
- Tool invocations (npm install, git status, brew list)
- OS-specific commands with no Python equivalent

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
- **Safe file move/copy — NEVER use wildcards that include the destination:** When moving files from a directory to a subfolder (e.g., `mv ~/Desktop/* ~/Desktop/dest/`), the `*` wildcard includes the destination folder itself, causing "cannot move a directory into itself" error. Use specific file patterns OR exclude the destination:
  - CORRECT: `bash -c "mv ~/Desktop/*.txt ~/Desktop/dest/"` (specific extension)
  - CORRECT: `bash -c "find ~/Desktop -maxdepth 1 -type f ! -path '*thinkdrop-files*' -exec mv {} ~/Desktop/thinkdrop-files/ +"` (exclude dest)
  - WRONG: `mv ~/Desktop/* ~/Desktop/thinkdrop-files/` (includes dest folder in wildcard)

- **NEVER hard-code source directory paths in move operations when path is uncertain:** If the exact absolute path of the source directory was NOT explicitly provided by the user in this prompt (e.g. moving files "back", reversing a prior move, or moving from a named folder), you MUST resolve the path at runtime with `mdfind`. Do NOT guess or derive paths from directory names — folder names do not imply location:
  - WRONG: `mv /Users/lukaizhi/thinkdrop-files/* ~/Desktop/` (guessed path — may not exist)
  - WRONG: `mv ~/thinkdrop-files/* ~/Desktop/` (assumed home dir — folder may be on Desktop)
  - CORRECT (single atomic step — locate, verify, move):
    ```bash
    bash -c 'SRC=$(mdfind -name "thinkdrop-files" -onlyin "$HOME" | head -1); [ -d "$SRC" ] && find "$SRC" -maxdepth 1 -type f -exec mv -n {} ~/Desktop/ \; || echo "Source not found: $SRC"'
    ```
  Use `mdfind -name 'FOLDERNAME' -onlyin "$HOME"` to find the real path, store in `$SRC`, verify with `[ -d "$SRC" ]`, then move. This pattern handles any location the folder may actually be in.
