---

description: Write an ORC session handoff for the current work
argument-hint: "[focus]"
---

Prepare a handoff for this session, focused on: ${@:-the current work}.

1. Call the `orc` tool with action `context`, then review the work done in this session from the conversation and the repository state.
2. Record durable session state through ORC: use `orc` action `call` with tool `session_event` for decisions, errors or file changes that matter, and `session_log` with a concise summary when the work unit is complete. If `session_handoff` is available, use it for a structured handoff.
3. Write a handoff document that states: objective, decisions, completed work, current state, files changed, verification performed, blockers, and the next concrete action.
4. Keep secrets and retrieved credential values out of the handoff. Reference environment variable names instead.
5. Do not commit, push, or create ORC tasks unless the user asks.
