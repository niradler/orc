# Shared project memory

Use memory for short durable facts, decisions, gotchas and pointers. Put work in
progress in tasks/session events; cited lessons and procedures in the KB; reusable
agent instructions in skills. Do not duplicate source-owned README/code content.

## Recall and maintain

1. Select the intended readable project and call `context`. Read relevant listed
   facts with `memory_read`; find others with `memory_list({project, q})`. The list
   searches names/descriptions; use `search` when the subject may be in tasks/KBs.
2. Before saving, search the subject. `memory_create` saves a new fact;
   `memory_update` corrects the existing subject with a reason. Do not create a
   second memory just because an older value changed.
3. Names: lowercase-hyphenated, max 64. Description: when it matters, max 300.
   Content: configured cap, default 800 characters. Priority: 0–100 or unset;
   reserve high values for broadly relevant guidance. `priority: null` clears it;
   omitted update fields stay unchanged. Length alone does not turn text into a skill.
4. Read the saved value in its project and verify it is accurate, scoped and useful.
   Record evidence/conditions for surprising facts, not a universal rule from one
   unverified observation. No durable learning means no new write.

## History and safe correction

`memory_history` returns newest changes with before/after state. Prefer updating a
wrong fact to deleting/recreating it; history retains its rationale. `memory_delete`
is for an obsolete/wrong fact when removal is actually authorized.

`memory_revert` restores the state **before** the selected `change_id`. Pin
`expected_change_id` to the latest history entry and give a reason. On conflict,
reread history and reconcile. Reverting creation deletes the memory; reverting a
delete can restore it. Inspect the intended before-state and respect project
destructive-operation rules before invoking either operation.

## Share and reuse across agents

Claude, Codex, Cursor and other clients share recorded facts through the same
central ORC endpoint/project. A local native conversation/memory file is not
automatically ORC memory. Do not copy process bodies between agent home folders.
Read effective scoped skills through ORC; a direct installed-file read bypasses
SQLite instruction overlays. See `packages.md` for effective skill editing.

Use supplied session identity on supported session/KB writes. Native attribution
depends on the transport: stdio/CLI can see native session env; HTTP cannot infer
the calling client's native session. Keep touched memory names and meaningful
session events so a review can find writes without assuming automatic attribution.
For a substantial verified lesson, search the Learnings KB and update a matching
document or leave a cited comment for its digest; see `knowledge.md`.
