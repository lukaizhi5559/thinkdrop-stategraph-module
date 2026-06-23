## Appendix: macOS-Specific Rules

Domain-specific guidance for macOS system behavior. File-operation patterns (mdfind, safe moves, Finder color tags) are in the `shell.md` appendix.

## Opening and Closing Apps / Documents

- **Opening apps** — always `shell.run open -a AppName`, never `browser.act`
- **Closing a file on macOS** — use `osascript -e 'tell application "AppName" to close (every document whose name is "filename")'`. NEVER use `lsof | kill`, `kill -9`, or `xargs kill` — those kill the whole app or random processes. To find which app has the file open: `mdls -name kMDItemLastUsedApp "/path/to/file"`. For .txt files the app is usually "TextEdit". For PDFs use "Preview". Always close the document, not the application (unless the user explicitly says "quit TextEdit").
- **osascript / AppleScript** — use `shell.run bash -c 'osascript -e "..."'` for simple AppleScript commands. Note: macOS requires the user to grant Automation permission in System Settings → Privacy & Security → Automation before osascript can control other apps. If a simpler alternative exists (e.g., `open -a AppName` to open an app, `bash -c "echo hello"` to run a command), prefer it over osascript.

## System Settings / System Preferences

NEVER use `browser.act` for System Settings, System Preferences, or ANY native macOS system dialogs. Playwright-cli controls web browsers ONLY — it cannot interact with macOS native apps or system dialogs.

To open a specific System Settings pane:
```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
```

For general System Settings:
```bash
open -a "System Settings"
```

NEVER generate `browser.act` steps with `sessionId: "macos"` or similar — there is no macOS browser session.

## macOS Finder Desktop Icon Arrangement

NEVER use `defaults write com.apple.finder DesktopViewSettings -dict IconViewSettings '{...}'` (macOS rejects nested composite types, exits with code 1). NEVER use `osascript` to set desktop arrangement/view options — ALL AppleScript `set icon view options` / `set arrangement` / `set desktop view options` commands return error -10006 or -1728 on modern macOS (Ventura+). NEVER use `guide.step` or System Preferences/Settings UI for desktop arrangement — it is ALWAYS solvable with PlistBuddy.

The ONLY reliable method is PlistBuddy:

**Complete `arrangeBy` values table:**
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

**Command pattern:**
```bash
/usr/libexec/PlistBuddy -c 'Set :DesktopViewSettings:IconViewSettings:arrangeBy VALUE' ~/Library/Preferences/com.apple.finder.plist && killall Finder
```

- Sort by name: `arrangeBy name`
- Sort by date modified: `arrangeBy dateModified`
- Sort by date created: `arrangeBy dateCreated`
- Sort by kind: `arrangeBy kind`
- Sort by size: `arrangeBy size`
- Sort by date added: `arrangeBy dateAdded`
- Remove arrangement: `arrangeBy none`
- Snap to grid: `arrangeBy grid`

Clean up / snap icons to grid (one-time):
```bash
osascript -e 'tell application "Finder" to activate' -e 'tell application "Finder" to clean up window of desktop'
```
NEVER use `clean up container of desktop` or `clean up desktop` (both return error -1708 on modern macOS).

Always run `killall Finder` after PlistBuddy writes so Finder re-reads its preferences. Verify after: `defaults read com.apple.finder DesktopViewSettings | grep arrangeBy`.

**CRITICAL:** If a user says "sort by date" without specifying which date, default to `dateModified`. If they say "sort by date added" use `dateAdded`. If they say "sort by date created" use `dateCreated`.

NEVER fall back to `guide.step` or System Settings UI for any desktop/Finder arrangement task.

## macOS Finder / Desktop Cleanup Disambiguation

"Finder", "finder", "my Finder", "clean up desktop", "tidy desktop", "organize desktop", "make neat", "make it neat", "neaten up" are ALL macOS LOCAL filesystem tasks. NEVER treat "Finder" as a web service name or use `browser.agent`, `playwright.agent`, or `browser.act` for any of these.

"Clean up" / "make neat" / "tidy" for a desktop means: (1) sort icons alphabetically using PlistBuddy + (2) snap to grid with the `osascript clean up window of desktop` command. It does NOT mean creating subfolders (Documents/, Images/, Videos/, Audio/, etc.) and moving files into them — NEVER do that unless the user EXPLICITLY says "sort my files by type" or "move files into folders". Always use `shell.run` for all macOS desktop/Finder tasks.

## macOS Finder Color Tags (Labels)

macOS stores color labels in THREE separate xattr keys that must ALL be cleared:
1. `com.apple.FinderInfo` — the legacy 32-byte Finder info blob where the color label byte lives (this is the primary one)
2. `com.apple.metadata:_kMDItemUserTags` — the modern named-tag array
3. `com.apple.metadata:kMDLabel_*` — per-label UUID keys

For a single item:
```bash
xattr -d com.apple.FinderInfo /path/to/item 2>/dev/null; xattr -d com.apple.metadata:_kMDItemUserTags /path/to/item 2>/dev/null
```

For a full directory (shallow, no recursion):
```bash
for f in ~/Desktop/*; do
  xattr -d com.apple.FinderInfo "$f" 2>/dev/null
  xattr -d com.apple.metadata:_kMDItemUserTags "$f" 2>/dev/null
  for k in $(xattr "$f" 2>/dev/null | grep kMDLabel); do xattr -d "$k" "$f" 2>/dev/null; done
done
```

NEVER use `find ... -exec xattr -d {} \;` — recurses into subdirectories and hangs. NEVER target only `_kMDItemUserTags` — this alone does NOT remove the colored dots visible in Finder (those come from `FinderInfo`).
