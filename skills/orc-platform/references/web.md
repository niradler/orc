# Web navigation and links

Use this when an answer should take the user to an ORC resource. Resolve the
resource with ORC tools first; prefer its returned link when available.

## Build a link

- In dashboard chat, root-relative Markdown links work: `[Open task](/tasks/<task-id>)`.
  Outside the dashboard, use the selected installation's **browser-visible origin**
  (for example `https://orc.example.com`) plus the path. Do not infer that origin
  from an internal MCP address, SSH host, API override, or development port.
- Dashboard routes do **not** start with `/api`. API endpoints and MCP URLs are
  interfaces for tools, not links to a resource's dashboard page.
- Encode each dynamic path segment with `encodeURIComponent`; build query strings
  with `URLSearchParams`. Use actual returned IDs/names, never titles as IDs.
- `?project=<project-id>` scopes the view; use the returned project ID, although
  MCP's `project` argument uses a readable name. `all` and `unassigned` are view
  scopes. Include scope when omission could hide the resource under a saved filter.
- To keep a specific chat open while navigating elsewhere, add `chat=open` and
  `chatThread=<thread-uuid>` to the destination's query. Carry relevant workspace
  state, not unrelated list filters or credentials.

```js
const path = `/tasks/${encodeURIComponent(task.id)}`;
const query = new URLSearchParams({ project: task.project_id ?? "unassigned" });
const relative = `${path}?${query}`;
// For a link outside dashboard chat, browserOrigin must be the verified public UI origin.
const absolute = new URL(relative, browserOrigin).href;
```

## Resource routes

Angle-bracket values below are placeholders, encoded as individual components.

| Resource / intent | Dashboard path | Identifier / behavior |
| --- | --- | --- |
| Activity | `/activity` | Dashboard overview |
| Attention | `/attention` | Items needing human input |
| Tasks / task detail | `/tasks`, `/tasks/<task-id>` | ORC task ID; detail includes its flow |
| Jobs / job detail | `/jobs`, `/jobs/<job-id>` | ORC job ID |
| Webhooks | `/webhooks` | List; no per-source detail route |
| Projects / project detail | `/projects`, `/projects/<project-id>` | ORC project ID |
| Discovered sessions | `/sessions?session=<live-session-id>` | ORC discovered-session record ID; opens its detail/transcript |
| Recorded session logs | `/audit`, `/audit/<logged-session-id>` | ORC logged-session ID; summaries/events, not native transcript |
| Existing chat | `/activity?chat=open&chatThread=<thread-uuid>` | ORC chat thread UUID; opens it and follows a running turn |
| New chat panel | `/activity?chat=open` | Opens chat workspace; may restore the user's existing tabs |
| Terminals / one terminal | `/terminals`, `/terminals/<terminal-id>` | Terminal ID from the terminal API |
| A discovered session's terminal | `/terminals?session=<live-session-id>` | Finds its running terminal; otherwise offers a start action |
| Knowledge base | `/knowledge/base?kb=<kb-id>` | KB ID |
| Knowledge document | `/knowledge/base?kb=<kb-id>&document=<document-id>` | Include both IDs to select its KB and document |
| Memories / one memory | `/knowledge/memories`, `/knowledge/memories/<project-id>/<memory-name>` | Memory identity is project ID plus name |
| Skills / one skill | `/skills`, `/skills/<skill-name>` | Skill name, not a numeric ID; include project scope for overrides |
| Packages / one package | `/packages`, `/packages/item/<package-name>` | Package name |
| Agents / one agent | `/packages/agents`, `/packages/agents/<agent-id>` | ORC agent definition ID |
| Rules | `/rules` | List; no per-rule detail route |
| Scratchpads / one pad | `/scratchpad`, `/scratchpad/<pad-id>` | Pad ID; prefer the link returned by `pad_create` |
| Settings | `/settings` | Page; do not invent tab/subsection URL parameters |

Use the canonical routes above rather than legacy `/dashboard`, `/overview`,
`/knowledge`, or `/agents` redirects. There is no current `/flows` dashboard route;
link the task for its flow. Unknown paths redirect to Activity, so an HTTP 200 or
a loaded SPA shell does not establish that a detail link works.

Useful shareable filters (combine with `project` as needed):

| Page | Query parameters |
| --- | --- |
| Tasks | `q`, `status`, `priority`, `view=board\|table` |
| Sessions | `q` (search activates at two characters), `agent`, `ended=0` (hide ended), `order=asc\|desc` |
| Knowledge | `kb`, `document`, `q`, `label`, `searchAll=1` (search all KBs) |
| Memories | `memoryQuery`, `memorySort=reads\|recent\|priority` |
| Packages | `q`, `format` (use a value supported by the current catalog) |

## Read a session or continue it

These identifiers are different: the discovered-session record's `id`, its native
`session_id`, a logged-session ID, an archive ID, a chat thread UUID, and a terminal
ID. Match agent, host and cwd when mapping between them. Never substitute a native
CLI session ID into the `session=` web parameter.

- **Read:** link `/sessions?session=<record-id>` for a discovered conversation, or
  `/audit/<id>` when the requested result is a recorded work log. Session searches
  can also link `/sessions?q=<query>&project=<scope>`.
- **Open an existing chat:** use its thread UUID with `chat=open&chatThread=...`.
  That URL loads the chat; it does not submit a new message or start another turn.
- **Continue a discovered session in chat:** follow [execution.md](execution.md).
  For eligible ended Claude/Codex sessions, the UI's **Open in chat** action calls
  authenticated `POST /api/chat/threads` with `{sourceSessionId: record.id}`. Use
  the returned thread UUID for the chat link. There is no direct native-session
  resume query parameter. If only offering continuation, link its session detail
  and name the action; do not prepare/start it just to manufacture a link.
- **Continue in terminal:** prefer `/terminals?session=<record-id>` for sharing
  an existing session's terminal; it survives replacement of that terminal's ID.
  If no terminal runs, this page offers **Open in terminal**; visiting it does not
  launch an agent. An authorized request to actually resume requires the launch
  described in [execution.md](execution.md), then verification of the returned
  terminal/host/cwd. Plain shell terminals use `/terminals/<terminal-id>`.
- **Archived session:** currently its transcript dialog is selected in local UI
  state, with no archive-specific deep link. Link `/sessions?q=<encoded-query>`
  with the right project and tell the user which archived result to open. Do not
  invent `/sessions/<archive-id>` or `archive=`. For native continuation, use
  [session-archive.md](session-archive.md) to prepare the archive before resuming.

## When routes change

This is a source-backed route guide, not a promise that every installed version
supports every route. Check the selected version when behavior differs. In a
checkout, the authoritative sources are `packages/web/src/App.tsx`, query consumers
in the views/components, `hooks/useChat.ts`, and the helpers
`lib/{terminal-links,memory-routes,scratchpad-routes,workspace-navigation}.ts`.
Update this reference alongside URL-contract changes. Validate the selected
resource and action in the page, not just that its URL returns HTML.
