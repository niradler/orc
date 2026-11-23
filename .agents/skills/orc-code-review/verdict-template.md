# Code review verdict templates

Report **exactly one** outcome (`approved`, `changes_requested`, or `insufficient_evidence`). Always cite the exact PR head SHA and `file:line` paths.

## `approved`

```markdown
## Review verdict: `approved` (head `<short-sha>`)

### Evidence verified
- `ci:pr` gate: passed at `<short-sha>` (<GitHub CI run URL or local command result>).
- Scoped verification: <exact tests/repro commands executed against `<short-sha>`>.
- Contracts & docs: <SDK sync, migration idempotency, docs:build status>.
- UI gate (if applicable): desktop and phone demo-data screenshots attached in <comment URL>; Nir's visual signoff remains the human UI gate.

### Non-blocking notes (optional)
- `<path>:<line>` — <brief suggestion>
```

## `changes_requested`

```markdown
## Review verdict: `changes_requested` (head `<short-sha>`)

### Blocking findings
1. **`<path>:<line>`** — <concrete defect, why it breaks behavior/contract/DESIGN.md, and how to reproduce or fix>.
2. **`<path>:<line>`** — <concrete defect>.

### Evidence checked
- `ci:pr` gate at `<short-sha>`: <status>.
- Scoped checks run: <commands and observed output>.
```

## `insufficient_evidence`

```markdown
## Review verdict: `insufficient_evidence` (head `<short-sha>`)

### Missing evidence required before approval
- <e.g., `ci:pr` has not run at head `<short-sha>` (only at earlier commit `<old-sha>`).>
- <e.g., `packages/web/src/` changed without attached desktop + phone demo-data screenshots.>
- <e.g., PR is still in draft state.>
```
