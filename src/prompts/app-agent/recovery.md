## Role
Recover from failed operations by trying alternative methods.

## Input
- Failed action: {action}
- Failure reason: {reason}
- Attempt count: {count}
- Available alternatives: {shortcuts, boundaries}
- App category: {category}
- App name: {appName}

## Recovery Sequence

### 1. Alternative Shortcut
```javascript
// Try different shortcut for same action
const alternatives = shortcuts.filter(s => s.action === failedAction);
if (alternatives.length > 1) {
  // Try next alternative
  return { recoveryMethod: "alternative_shortcut", shortcut: alternatives[1] };
}
```

### 2. Boundary Box + Mouse
```javascript
// If shortcuts fail twice, use mouse positioning
if (attemptCount >= 2) {
  return { 
    recoveryMethod: "boundary_box",
    action: "position_mouse_and_click",
    targetRegion: inferRegionFromCategory(category)
  };
}
```

### 3. Find Navigation (Cmd+F / Cmd+K)
```javascript
// Universal fallback for text-based targets
if (targetText) {
  return {
    recoveryMethod: "find_navigation",
    sequence: [
      { skill: "app.agent", action: "execute_shortcut", shortcut: "Cmd+F" },
      { skill: "app.agent", action: "type", text: targetText },
      { skill: "app.agent", action: "execute_shortcut", shortcut: "ESC" },
      { skill: "app.agent", action: "execute_shortcut", shortcut: "Tab" } // Focus element
    ]
  };
}
```

### 4. ESCALATE (All Methods Exhausted)
```javascript
// Return escalate to trigger user-facing disclaimer
return {
  recoveryMethod: "escalate",
  attemptsExhausted: ["shortcut_primary", "shortcut_alternative", "boundary_box", "find_navigation"],
  suggestion: "complete_manually"
};
```

## Category-Specific Recovery

| Category | Shortcut Fallback | Mouse Fallback | Find Fallback |
|----------|-------------------|----------------|---------------|
| browser | Try Ctrl+key | Click content area | Cmd+F (universal) |
| editor | Try Alt+key | Click editor pane | Cmd+F / Cmd+P |
| chat | Try different combo | Click message area | Cmd+K (quick switch) |
| design | Try Shift+key | Click canvas | N/A (use selection) |

## Output Format

```json
{
  "recoveryMethod": "alternative_shortcut" | "boundary_box" | "find_navigation" | "escalate",
  "reasoning": "Primary shortcut failed, trying alternative from discovered list",
  "attemptsExhausted": ["shortcut_primary"],
  "remainingOptions": ["shortcut_alternative", "boundary_box"],
  "fallbackPlan": [
    { "skill": "app.agent", "args": { "action": "..." } }
  ]
}
```

## Graceful Failure & Disclaimer

When all recovery methods fail:

```javascript
return {
  ok: false,
  escalated: true,
  disclaimer: true,
  attemptsExhausted: ["shortcut_primary", "shortcut_alternative", "boundary_box", "find_navigation"],
  suggestion: "complete_manually",
  failureLog: {
    appName,
    action,
    timestamp: Date.now()
  }
};
```

**UI Message** (amber warning card, not red error):
```
⚠️ Automation Limit Reached

ThinkDrop was unable to complete this task after exhausting all available 
automation strategies for this application.

Attempts made:
  • Keyboard shortcuts (primary and alternatives)
  • Mouse positioning via boundary detection
  • Find/search navigation (Cmd+F)

Recommendation: Please complete this step manually.
```

## Safety Rules

- **Try at least 2 shortcuts** before falling back to mouse
- **Log all failures** to skill-db for pattern learning
- **Continue plan** if remaining steps don't depend on this one
- **Never retry indefinitely** — max 4 attempts total
- **Escalate gracefully** — don't crash or show scary error
