# gatherContext — How it works

> Inspired by the grill-me pattern: short relentless interrogation, one decision branch at a time, provide your recommended answer for each question.

## Pipeline position

`enrichIntent → [mcpFillGaps] → gatherContext → creatorPlanning → planSkills`

Grill mode (HIGH/CRITICAL risk) is set by `assessRisk` in `StateGraphBuilder.js` before this node runs.

## EXECUTE tasks (one-shot commands)

For plain EXECUTE tasks gatherContext runs a **lightweight grill pass**:

1. **Bare folder/file name detected** (e.g. "gongzuo folder" with no `/path`) → ask "Where is `gongzuo` located?" with Desktop / Documents / Downloads / home options. Resolved path is injected into planSkills as a PRE-FLIGHT RESOLVED FACT.
2. **Grill mode active** (HIGH/CRITICAL risk) → run one round of gap analyst (`gather-gaps.md`) to surface scope/conflict questions before planning. Max 3 questions.
3. **Neither condition** → skip entirely, proceed to planSkills.

## BUILD tasks (scheduled skills needing credentials)

Full multi-round Q&A loop (max 8 rounds):
- Phase 1: fact extractor (`gather-extract.md`) — pull everything already stated
- Phase 2: gap analyst (`gather-gaps.md`) — identify what's genuinely missing
- Ask one cluster per round: service → credentials → config
- Credentials go to keytar; OAuth providers get `gather_oauth` UI card

## Grill mode decision tree (for gap analyst in grill pass)

When `_grillMode=true`, the gap analyst should walk the relevant branch:

**File ops**: scope (files only / folders too?) · types (extensions, hidden?) · conflicts (skip/overwrite/ask?) · recursion (top-level only?) · rollback possible?
**Browser**: auth required? · selectors (specific / generic?) · rate limits · captcha risk?
**API**: OAuth scope sufficient? · read-only vs mutation? · rate limit? · retry strategy?
**System**: sudo needed? · deps installed? · can this be undone?

For each question, provide your recommended answer. One cluster per round.

## Key rules (for LLM prompts — gather-extract.md + gather-gaps.md)

- Extract first, ask second — never ask about something already stated
- Never ask for timezone (always from `system_tz`)
- Never ask user to re-describe their task
- Never ask for credentials of services the user isn't actively invoking
- For bare folder names with no absolute path → ask location, offer Desktop/Documents/Downloads/home
- Set `complete: true` to end the Q&A loop

## Prompts used at runtime

- `gather-extract.md` — Phase 1 fact extractor (BUILD loop)
- `gather-gaps.md` — Phase 2 gap analyst (BUILD loop + EXECUTE grill pass)
