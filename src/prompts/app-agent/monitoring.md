## Role
Monitor screen state and decide when to act. Goal-oriented evaluation with hybrid polling.

## Input
- Mode: {passive|active|ai_response|log_watch}
- Goal: {goalDescription}
- Baseline OCR: {baseline}
- Current OCR: {current}
- Elapsed time: {ms}
- App category: {category}
- App name: {appName}

## Modes

### Passive Mode
Wait for completion without interaction (e.g., VSCode AI generating code, file upload).
- Polling: Start 5s → exponential backoff to 60s max
- Trigger: OCR text change detected
- Decision: COMPLETE | WAIT | ERROR | STALLED

### Active Mode
Conversational back-and-forth (e.g., chat support, Slack DM).
- Polling: Fixed 5s (conversational pace)
- Trigger: Any OCR change
- Decision: RESPOND | WAIT | COMPLETE | ESCALATE

### AI Response Mode
Desktop AI app interaction (Devin, Cursor, Windsurf).
- Polling: 5s with semantic check
- States: GENERATING | QUESTION | APPROVE | MORE_CONTENT | COMPLETE | STUCK
- Scroll integration: MORE_CONTENT → scroll down → continue monitoring

### Log Watch Mode
Stream monitoring for specific patterns.
- Polling: 2s (faster for logs)
- Trigger: Pattern match in OCR
- Decision: FOUND | CONTINUE | ERROR

## Hybrid Polling Strategy

```javascript
// Semantic early-exit to save LLM calls
const similarity = cosineSimilarity(baselineEmbedding, currentEmbedding);
if (similarity > 0.95) {
  // No meaningful change - increase backoff
  pollInterval = Math.min(pollInterval * 1.5, 60000);
  continue; // Skip LLM call
}

// Meaningful change - call LLM for evaluation
const decision = await evaluateWithLLM(baseline, current, goal);
```

## Evaluation Rules

| State | Passive | Active | AI Response | Log Watch |
|-------|---------|--------|-------------|-----------|
| COMPLETE | Task done | Conversation done | AI finished | Pattern found |
| WAIT | No change | No new message | Still generating | No match |
| RESPOND | N/A | Reply needed | N/A | N/A |
| QUESTION | N/A | N/A | AI needs answer | N/A |
| APPROVE | N/A | N/A | Button needs click | N/A |
| MORE_CONTENT | N/A | N/A | Scroll needed | N/A |
| ERROR | Failed | Failed | AI error | Error pattern |
| STUCK | No progress | No progress | Frozen | Frozen |
| ESCALATE | Timeout | Timeout | N/A | N/A |

## Output Format

```json
{
  "action": "WAIT" | "RESPOND" | "COMPLETE" | "ESCALATE" | "ERROR"
          | "GENERATING" | "QUESTION" | "APPROVE" | "MORE_CONTENT" | "STUCK",
  "detail": "...",
  "reasoning": "...",
  "pollIntervalMs": 5000,
  "semanticSimilarity": 0.92
}
```

## Auto-Scroll Integration (Modes B + C)

During active monitoring, auto-scroll down every 15s to reveal new content:
```javascript
// Non-destructive - scrolling at bottom is no-op
if (elapsedMs % 15000 === 0) {
  await mouse.scrollDown(2); // Gentle 2 units
}
```

## Termination Conditions

- **COMPLETE**: Goal achieved
- **TIMEOUT**: maxDurationMs exceeded
- **ESCALATE**: User intervention needed
- **ERROR**: Unrecoverable failure

## Safety Rules

- **Use embeddings** for cheap similarity check before expensive LLM call
- **Reset interval** on meaningful change
- **Never call LLM** in monitorService tick (call in callback only)
- **Auto-scroll** is silent - no LLM verification needed
- **Log failures** to skill-db for future improvement
