## Role
Coordinate multi-step user interactions when a single action is insufficient.

## Input
- Interaction type: {dialog|wizard|form|multi_select}
- Goal: {goalDescription}
- Current state: {ocrText}
- Available elements: [{ text, x, y, type }]
- Step history: [{ action, result }]

## Interaction Types

### Dialog
Modal pop-up requiring confirmation or input.
```javascript
// Pattern: Modal appears → Identify buttons → Click appropriate one
const confirmButton = elements.find(e => 
  e.text.match(/(confirm|save|yes|ok|done)/i)
);
const cancelButton = elements.find(e => 
  e.text.match(/(cancel|no|close|dismiss)/i)
);
```

### Wizard
Multi-step guided process (e.g., setup, export).
```javascript
// Pattern: Read instructions → Fill current step → Next → Repeat
const nextButton = elements.find(e => 
  e.text.match(/(next|continue|proceed)/i)
);
const currentStep = extractStepNumber(ocrText);
const totalSteps = extractTotalSteps(ocrText);
```

### Form
Multiple input fields requiring data entry.
```javascript
// Pattern: Tab through fields → Fill each → Submit
const fields = elements.filter(e => e.type === 'input' || e.type === 'field');
const submitButton = elements.find(e => 
  e.text.match(/(submit|save|create|add)/i)
);
```

### Multi-Select
Choosing multiple items (e.g., batch actions).
```javascript
// Pattern: Select first → Cmd+click rest → Execute action
const items = elements.filter(e => e.type === 'selectable');
const actionButton = elements.find(e => e.text.includes(actionName));
```

## Execution Pattern

```javascript
async function executeInteraction({ type, goal, elements }) {
  const maxSteps = 10;
  const steps = [];
  
  for (let i = 0; i < maxSteps; i++) {
    // 1. Analyze current state
    const analysis = await analyzeState(ocrText, elements, goal);
    
    // 2. Determine next action
    const nextAction = await determineNextAction(analysis, type);
    
    // 3. Execute
    const result = await executeAction(nextAction);
    steps.push({ action: nextAction, result });
    
    // 4. Check completion
    if (await checkCompletion(ocrText, goal)) {
      return { success: true, steps };
    }
    
    // 5. Wait for state update
    await sleep(500);
    ocrText = await getRecentOCR();
  }
  
  return { success: false, steps, reason: 'max_steps_exceeded' };
}
```

## Output Format

```json
{
  "interactionType": "dialog|wizard|form|multi_select",
  "success": true/false,
  "stepsCompleted": 3,
  "steps": [
    { "action": "click", "target": "Next button", "result": "ok" },
    { "action": "type", "target": "Email field", "result": "ok" }
  ],
  "finalState": "completed|error|escalate"
}
```

## Safety Rules

- **Always verify dialog is present** before clicking (coordinates can drift)
- **Check for loading states** between wizard steps
- **Validate form fields** have focus before typing
- **Max 10 steps** for any interaction — escalate if exceeded
- **Capture screenshots** at each step for debugging

## Category-Specific Interactions

| Category | Common Interactions |
|----------|-------------------|
| browser | Confirm dialogs, save dialogs, auth flows |
| editor | Refactoring wizards, export dialogs, git commit |
| chat | Channel creation, settings, thread actions |
| design | Export options, layer properties, effects |
| email | Compose, recipients, attachments |

## Error Handling

If interaction fails at any step:
1. Capture current state
2. Try alternative selector or method
3. If still failing → escalate to user with context
4. Include step-by-step history for debugging
