## macOS-specific rules

- **Closing a file on macOS** — use `osascript -e 'tell application "AppName" to close (every document whose name is "filename")'`. NEVER use `lsof | kill`, `kill -9`, or `xargs kill` — those kill the whole app or random processes. To find which app has the file open: `mdls -name kMDItemLastUsedApp "/path/to/file"`. For .txt files the app is usually "TextEdit". For PDFs use "Preview". Always close the document, not the application (unless the user explicitly says "quit TextEdit").
- **Opening apps** — always `shell.run open -a AppName`, never `browser.act`
- **macOS System Settings / System Preferences** — NEVER use `browser.act` for System Settings, System Preferences, or ANY native macOS system dialogs. Playwright-cli controls web browsers ONLY — it cannot interact with macOS native apps or system dialogs. To open a specific System Settings pane use `shell.run bash -c 'open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"'` (substitute the relevant pane identifier). For general System Settings: `shell.run bash -c 'open -a "System Settings"'`. NEVER generate `browser.act` steps with `sessionId: "macos"` or similar — there is no macOS browser session.
- **osascript / AppleScript** — use `shell.run bash -c 'osascript -e "..."'` for simple AppleScript commands. Note: macOS requires the user to grant Automation permission in System Settings → Privacy & Security → Automation before osascript can control other apps. If a simpler alternative exists (e.g. `open -a AppName` to open an app, `bash -c "echo hello"` to run a command), prefer it over osascript.
- **Locating a file by name for use in another step (attach, copy, move, open, send)** — NEVER use `find /Users`, `find ~`, or `find /` broad search (hangs 30–60s due to network volumes and system dirs). Use instead:
  - macOS: `mdfind -name 'filename' | head -1` (Spotlight-indexed, returns in <1s)
  - Linux: `locate filename 2>/dev/null | head -1 || find ~/Desktop ~/Documents ~/Downloads -name 'filename' -maxdepth 3 2>/dev/null | head -1`
  Store the result in a variable and use it in later steps. Do NOT embed command substitution (`$(find ...)`) inside single-quoted shell strings — it will not expand.
- **Finding a file by name then reading/analyzing it** — always 3 steps: (1) `shell.run bash -c "mdfind -name 'SOME FILE' | head -1"` to locate it, (2) `shell.run bash -c "cat /found/path"` to read it, (3) `synthesize` to answer. Never stop at just `find` — always follow through with read + synthesize when the user wants to know what's in the file.
- **`find` on user directories — ALWAYS use `-maxdepth 1` by default.** Do NOT recurse into subdirectories unless the user explicitly says "recursively", "including subfolders", "children", "nested", or "all subdirectories". Use `-exec CMD {} +` (batch — one process for all matched items) NOT `-exec CMD {} \;` (spawns one process per item, hangs on large trees). Example: `find ~/Desktop -maxdepth 1 -exec CMD {} +`.
- **macOS Finder / desktop cleanup disambiguation — CRITICAL** — "Finder", "finder", "my Finder", "clean up desktop", "tidy desktop", "organize desktop", "make neat", "make it neat", "neaten up" are ALL macOS LOCAL filesystem tasks. NEVER treat "Finder" as a web service name or use `browser.agent`, `playwright.agent`, or `browser.act` for any of these — Finder is a macOS application, not a website. NEVER use `browser.agent { build_agent, service: 'finder' }` or `browser.agent { build_agent, service: 'shell' }`. "Clean up" / "make neat" / "tidy" for a desktop means: (1) sort icons alphabetically using PlistBuddy + (2) snap to grid with `osascript -e 'tell application "Finder" to activate' -e 'tell application "Finder" to clean up window of desktop'`. It does NOT mean creating subfolders (Documents/, Images/, Videos/, Audio/, etc.) and moving files into them — NEVER do that unless the user EXPLICITLY says "sort my files by type" or "move files into folders". Always use `shell.run` for all macOS desktop/Finder tasks.
- **macOS Finder desktop icon arrangement** — NEVER use `defaults write com.apple.finder DesktopViewSettings -dict IconViewSettings '{...}'` (macOS rejects nested composite types, exits with code 1). NEVER use `osascript` to set desktop arrangement/view options — ALL AppleScript `set icon view options` / `set arrangement` / `set desktop view options` commands return error -10006 or -1728 on modern macOS (Ventura+). NEVER use `guide.step` or System Preferences/Settings UI for desktop arrangement — it is ALWAYS solvable with PlistBuddy. The ONLY reliable method is PlistBuddy:
  - **Complete `arrangeBy` values table:**
    | Value | Meaning |
    |-------|---------|
    | `none` | Free positioning (no arrangement) |
    | `name` | Alphabetical by name |
    | `kind` | By file type/kind |
    | `dateModified` | By modification date |
    | `dateCreated` | By creation date |
    | `dateAdded` | By date added to folder |
    | `dateLastOpened` | By last opened date |
    | `size` | By file size |
    | `grid` | Snap to grid (no sorting, just grid alignment) |
  - **Command pattern:** `/usr/libexec/PlistBuddy -c 'Set :DesktopViewSettings:IconViewSettings:arrangeBy VALUE' ~/Library/Preferences/com.apple.finder.plist && killall Finder`
  - **Examples:**
    - Sort by name: `arrangeBy name`
    - Sort by date modified: `arrangeBy dateModified`
    - Sort by date created: `arrangeBy dateCreated`
    - Sort by kind: `arrangeBy kind`
    - Sort by size: `arrangeBy size`
    - Sort by date added: `arrangeBy dateAdded`
    - Remove arrangement: `arrangeBy none`
    - Snap to grid: `arrangeBy grid`
  - Clean up / snap icons to grid (one-time): `osascript -e 'tell application "Finder" to activate' -e 'tell application "Finder" to clean up window of desktop'` — NEVER use `clean up container of desktop` or `clean up desktop` (both return error -1708 on modern macOS)
  - Always run `killall Finder` after PlistBuddy writes so Finder re-reads its preferences.
  - Verify after: `defaults read com.apple.finder DesktopViewSettings | grep arrangeBy`
  - **CRITICAL:** If a user says "sort by date" without specifying which date, default to `dateModified`. If they say "sort by date added" use `dateAdded`. If they say "sort by date created" use `dateCreated`.
  - **NEVER fall back to guide.step or System Settings UI for any desktop/Finder arrangement task.** PlistBuddy + killall Finder is the ONLY correct approach.
- **macOS Finder color tags (labels)** — macOS stores color labels in THREE separate xattr keys that must ALL be cleared: (1) `com.apple.FinderInfo` — the legacy 32-byte Finder info blob where the color label byte lives (this is the primary one, present on almost every colored item); (2) `com.apple.metadata:_kMDItemUserTags` — the modern named-tag array; (3) `com.apple.metadata:kMDLabel_*` — per-label UUID keys. To remove ALL color labels from a directory (shallow, no recursion):
  ```bash
  for f in ~/Desktop/*; do
    xattr -d com.apple.FinderInfo "$f" 2>/dev/null
    xattr -d com.apple.metadata:_kMDItemUserTags "$f" 2>/dev/null
    for k in $(xattr "$f" 2>/dev/null | grep kMDLabel); do xattr -d "$k" "$f" 2>/dev/null; done
  done
  ```
  For a single item: `xattr -d com.apple.FinderInfo /path/to/item 2>/dev/null; xattr -d com.apple.metadata:_kMDItemUserTags /path/to/item 2>/dev/null`. NEVER use `find ... -exec xattr -d {} \;` — recurses into subdirectories and hangs. NEVER target only `_kMDItemUserTags` — this alone does NOT remove the colored dots visible in Finder (those come from `FinderInfo`).
