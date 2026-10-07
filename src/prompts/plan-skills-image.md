## Appendix: image.analyze & screen.capture

Domain-specific guidance for vision/OCR tasks. The base prompt already establishes the skill hierarchy. This appendix covers the `image.analyze` and `screen.capture` action contracts and common patterns for analyzing image content.

## When to use image.analyze vs screen.capture vs shell.run

| Signal | Skill | Why |
|--------|-------|-----|
| User references image FILES on disk (`.png`, `.jpg`, `.webp`, folder of screenshots) | `image.analyze` | Sends the image to a vision LLM that can describe what it shows |
| User says "scan/analyze/describe/what's in these images" + folder/file context | `image.analyze` | Vision LLM is the only way to understand image content |
| User says "what's on my screen" / "read the screen" (live, not a file) | `app.agent { action:'read_screen' }` | Real browser page scan when a browser is frontmost; live screen + OCR otherwise |
| User wants to LIST files or check file types/metadata | `shell.run` | File listing, not content analysis |
| User wants to convert/resize/crop images | `cli.agent` (imagemagick) or `shell.run` (sips) | Image processing, not analysis |

## Critical rule

**NEVER use `shell.run` to analyze image content.** Shell commands (`file`, `identify`, `python3 -PIL`, `exiftool`) can only read METADATA (dimensions, format, EXIF, file size). Only `image.analyze` sends the image to a vision LLM that can describe what the image actually SHOWS. If the user wants to know what's IN an image, always use `image.analyze`.

## image.analyze action contract

- `filePath` (string, required): absolute path to the image file. Supported formats: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.tiff`, `.tif`, `.heic`, `.heif`
- `query` (string, optional): what to ask about the image. Default: "Describe this image in detail. What does it show? What text is visible?"

### Single image (path known)

```json
[
  { "skill": "image.analyze", "args": { "filePath": "/path/to/image.png", "query": "Describe what this image shows and any visible text" }, "description": "Analyze the image" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the image analysis results for the user." }, "description": "Summarize findings" }
]
```

### Multiple images in a folder (two-step pattern)

When the user says "scan the images in [folder]" or "analyze all images in [folder]" without naming specific files, use a two-step pattern: Step 1 lists image files with `shell.run`, then a single `image.analyze` step that **omits `filePath` entirely** — the executor auto-injects all discovered image paths from step 1's output contract (as `filePaths`), and the skill analyzes each one.

**Do NOT use `{{PREV_OUTPUT}}` as `filePath`** — it resolves to the step's entire stdout (a multi-line path list), not a single path. For a specific image, use `{{LAST_SUCCESSFUL.outputs.filePaths[N]}}` (N = 0-based index). Also do NOT set `runGroup` on steps whose args reference prior output — grouped steps run in parallel and cannot depend on earlier output.

#### CRITICAL — image-listing step MUST emit exact `cmd` + `argv`, NEVER `goal`

If you generate `goal` instead of `cmd`+`argv` for the listing step, the plan will fail. The `shell.run` skill has an internal LLM that translates `goal` into `cmd`/`argv`, but that round-trip is fragile — the LLM can produce incomplete commands (e.g. `find` with unclosed `\(` groupings) that exit with code 1. For the well-defined "list image files in folder X" pattern, emit the exact `find` command directly. Replace `<FOLDER>` with the absolute folder path from the user's message or `[Folder: ...]` tag.

❌ BAD — uses `goal` (causes fragile LLM round-trip that can produce incomplete commands):
```json
{ "skill": "shell.run", "args": { "goal": "Find all image files in /path/to/folder and list their absolute paths" }, "description": "List image files" }
```

✅ GOOD — uses exact `cmd` + `argv` (no LLM round-trip, always works):
```json
{ "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "find '<FOLDER>' -maxdepth 1 -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.gif' -o -iname '*.bmp' -o -iname '*.tiff' -o -iname '*.heic' \\) | sort"] }, "description": "List image files in <FOLDER>" }
```

Full plan example (replace `<FOLDER>` with the actual absolute path):

```json
[
  { "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "find \"<FOLDER>\" -maxdepth 1 -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.gif' -o -iname '*.bmp' -o -iname '*.tiff' -o -iname '*.heic' \\) | sort"] }, "description": "List image files in <FOLDER>" },
  { "skill": "image.analyze", "args": { "query": "Describe what this image shows and any visible text" }, "description": "Analyze all discovered images" },
  { "skill": "synthesize", "args": { "prompt": "Summarize the image analysis results for all images. Group similar findings and highlight differences." }, "description": "Summarize all image analyses" }
]
```

Note: `find` path arguments use **double quotes** so `$HOME`/`$VAR` still expand — never wrap `$HOME` or `~` in single quotes (`find '$HOME/Desktop'` fails with "No such file or directory").

This pattern applies to ALL phrasings of image-analysis requests, including:
- "scan the images and tell me what they are"
- "analysis all the file in this folder tell what there about"
- "I need you to analysis all the file in this folder and tell me what they're about"
- "describe the photos in this folder"
- "what's in these screenshots"

### When the folder path is tagged in the prompt

If the user's message includes `[Folder: /path/to/folder]`, use that path directly as `<FOLDER>` in the `find` `argv` — do not search for it and do not use `goal`.

### When filePath is unknown but folder is named (no tag)

If the user says "scan the images in my screenshots folder" without a tagged path, emit a `shell.run` step with exact `cmd`/`argv` that searches common locations first:
```json
{ "skill": "shell.run", "args": { "cmd": "bash", "argv": ["-c", "SRC=$(for d in \"$HOME/Desktop\" \"$HOME/Documents\" \"$HOME/Downloads\" \"$HOME\"; do [ -d \"$d/<name>\" ] && echo \"$d/<name>\" && break; done); [ -d \"$SRC\" ] && find \"$SRC\" -maxdepth 1 -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.gif' -o -iname '*.bmp' -o -iname '*.tiff' -o -iname '*.heic' \\) | sort || echo \"Folder not found: <name>\""] }, "description": "Locate and list image files in <name> folder" }
```
Replace `<name>` with the folder name from the user's message.

## app.agent read_screen action contract (live screen reads)

- `read_screen` picks the capture tier itself: real browser page scan (`scan_page`) when a browser is frontmost, screen OCR otherwise. No args needed.
- Use for LIVE screen content only — not for image files on disk. Prefer it over `screen.capture` for describe-the-screen prompts.

```json
[
  { "skill": "app.agent", "args": { "action": "read_screen" }, "description": "Read the live screen (browser scan or OCR)" },
  { "skill": "synthesize", "args": { "prompt": "Summarize what's on the screen for the user." }, "description": "Summarize screen content" }
]
```

## image.analyze vs screen.capture decision

| User says | Skill |
|-----------|-------|
| "what's in these images" / "scan the images in [folder]" | `image.analyze` (files on disk) |
| "what's on my screen" / "read the screen" | `app.agent { action:'read_screen' }` (live screen) |
| "analyze this screenshot" (with `[File: *.png]` tag) | `image.analyze` (file on disk) |
| "analyze this screenshot" (no file tag, referring to live screen) | `app.agent { action:'read_screen' }` (live screen) |
