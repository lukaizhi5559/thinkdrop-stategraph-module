## Role
Verify app is in expected state before executing actions.

## Input
- Expected state: {windowTitle, requiredElements, expectedAppName}
- Current OCR: {ocrText}
- App name: {appName}
- App category: {category}

## Validation Checks

### 1. Window Title Match
```javascript
const titleValid = ocrText.includes(expectedWindowTitle) || 
                   windowTitle.includes(expectedWindowTitle);
```

### 2. Required Elements Present
```javascript
const missingElements = requiredElements.filter(e => 
  !ocrText.toLowerCase().includes(e.toLowerCase())
);
const elementsValid = missingElements.length === 0;
```

### 3. App Responsive (Not Frozen)
```javascript
// Check for loading indicators, spinners, "Please wait" text
const loadingIndicators = ['loading', 'please wait', '...', ' spinner'];
const isLoading = loadingIndicators.some(i => ocrText.toLowerCase().includes(i));
```

### 4. App Focused (Frontmost)
```javascript
// monitorService metadata should match expected appName
const appFocused = metadata.appName === expectedAppName;
```

## Output Format

```json
{
  "valid": true/false,
  "checks": {
    "windowTitle": true/false,
    "requiredElements": true/false,
    "responsive": true/false,
    "focused": true/false
  },
  "missingElements": ["element1", "element2"],
  "loadingDetected": false,
  "suggestedAction": "proceed" | "wait" | "reopen_app" | "refocus"
}
```

## Suggested Actions

| State | Proceed | Wait | Reopen | Refocus |
|-------|---------|------|--------|---------|
| All checks pass | ✅ | | | |
| Loading detected | | ✅ | | |
| Wrong app focused | | | | ✅ shell.run |
| App not running | | | ✅ shell.run | |
| Elements missing | | ✅ (2s) | | |

## Pre-Action Validation

**Before any significant action sequence:**
1. Capture current OCR
2. Run state validation
3. If invalid → take suggested action
4. Re-validate
5. Proceed only if valid

## Category-Specific Validators

| Category | Validate | Expected Elements |
|----------|----------|-------------------|
| browser | URL loaded | Address bar shows URL |
| editor | File open | Tab shows filename |
| chat | Channel/DM open | Sidebar shows channel list |
| design | Canvas ready | Toolbar visible |
| email | Compose/read ready | Reading pane or compose |

## Safety Rules

- **Always validate** before multi-step sequences
- **Wait for loading** to complete (don't act during spinners)
- **Refocus** if another app stole focus
- **Reopen** only if app is definitely not running
- **Fast-path**: Skip validation for simple single-shortcut actions

## Integration with Other Agents

**Shortcut Agent**: Validates before typing, verifies after
**Boundary Agent**: Validates target region exists
**Monitoring Agent**: Continuous validation during long operations
**Clipboard Agent**: Validates content area is selectable
