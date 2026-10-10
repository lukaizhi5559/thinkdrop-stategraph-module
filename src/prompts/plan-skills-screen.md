## Appendix: Screen Deliverables (GhostLayer output)

The task produces a visual artifact — chart, slideshow/deck, essay/doc, animation, 3D scene. The GhostLayer IS the artifact surface: end the plan with a `screen.display` step instead of writing files or scripting Python/image tooling.

`screen.display` args = the ScreenOutput contract — `kind` plus its payload field:

- `chart` → `{ "skill": "screen.display", "args": { "kind": "chart", "title": "…", "chart": { "type": "pie|donut|bar|line|area|stat", "data": [{ "label": "…", "value": 0 }], "xKey": "label", "yKey": "value" }, "blocking": true } }`
- `deck` → `{ "kind": "deck", "deck": { "slides": [{ "title": "…", "text": "…" }], "transition": "fade", "slideMs": 5000, "controls": true }, "blocking": true }`
- `doc` → `{ "kind": "doc", "title": "…", "doc": { "markdown": "<full markdown body>", "editable": true } }` — essays, write-ups, articles. The doc renders in a markdown editor card; keep `editable: true`.
- `three` → `{ "kind": "three", "three": { "scene": "starfield|particles|wave|cube|knot|globe", "text": "<optional caption>" } }` — deterministic 3D presets.
- `scene` → `{ "kind": "scene", "scene": { "js": "{{synthesisAnswer}}", "libs": ["three"] }, "blocking": true }` — custom animations/diagrams/generative visuals. NEVER inline the scene code in this JSON — put a `synthesize` step first whose prompt asks for the raw three.js body (the body of `function build(THREE, ctx)`; scene/camera/renderer provided, `ctx.controls` is a ready OrbitControls instance for drag-orbit/wheel-zoom, return `{ tick(t) }` for animation) with `outputSchema` STRING, then reference it via `{{synthesisAnswer}}`.
- `text` → `{ "kind": "text", "title": "…", "text": "…" }`, `emoji`, `alert`, `effect`, `image` — same contract.

### Rules

1. **Gather first, display last.** Steps that fetch the artifact's data (cli.agent, web.crawl, fs.read, journal_stats) come BEFORE the `screen.display` step. Carry data forward with `{{prev_stdout}}`/`{{synthesisAnswer}}` — or put a `synthesize` step before display that shapes the data, then the display step hardcodes the final `data`/`markdown`/`slides` from it.
2. **The display step IS the deliverable.** Do NOT add file saves, screenshots, or "open in a browser" steps after it unless the user asked for a file.
3. **Interactive by default** for chart/deck/scene/three — set `"blocking": true` so hover tooltips, deck controls, and drag-orbit actually work. Text/image/emoji stay non-blocking.
4. **Charts need real data.** If no gather step produced numbers and the prompt carries no "label N" pairs, do NOT invent values — plan a gather step first, or answer that data is needed. If the data only exists after a prior step runs, you may emit the chart payload with the correct `type`/`xKey`/`yKey` and an empty `data` — the executor fills `data` from the preceding gather/synthesize output at dispatch time.
5. **Never render artifacts as files** (no python matplotlib, no HTML file + open, no screenshot-to-image) when a `screen.display` kind fits. The file route only applies when the user explicitly asks for a file output.

### Example — "create a bar chart of my journal activity this week"

```json
[
  { "skill": "cli.agent", "args": { "task": "Summarize the user's task journal counts by day for this week; output 'Day: N' lines" }, "description": "Gather journal stats" },
  { "skill": "synthesize", "args": { "prompt": "Turn the journal output into chart rows: [{\"label\": \"Mon\", \"value\": 4}, …]. Output ONLY the JSON array." }, "description": "Shape chart data" },
  { "skill": "screen.display", "args": { "kind": "chart", "title": "Journal activity — this week", "chart": { "type": "bar", "data": [{ "label": "Mon", "value": 4 }, { "label": "Tue", "value": 7 }], "xKey": "label", "yKey": "value" }, "blocking": true }, "description": "Render the bar chart on the GhostLayer" }
]
```
