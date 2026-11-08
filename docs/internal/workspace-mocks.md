# Unified session workspace mock review

This draft proposes full-page web chat as ORC's starting workspace, retains side
chat on existing pages, and gives sessions consistent chat/terminal controls.
It is a design prototype, not a live session integration or a production default
change. Tasks and other existing product pages are unchanged. The Tasks surface
inside the side-chat mock is illustrative context only.

## Run and compare

From `packages/web`, run:

```sh
bun run dev --host 127.0.0.1 --port 3077 --strictPort
```

Open `http://127.0.0.1:3077/workspace-next.html`. The top review controls switch
between four scenarios; each can also be opened directly:

| Scenario | URL suffix | Review focus |
| --- | --- | --- |
| New session | `/workspace-next.html` | Default full-page chat and project navigation |
| Focused session | `/workspace-next.html?scene=session` | One session with Chat / Terminal representations |
| Parallel sessions | `/workspace-next.html?scene=parallel` | Two independently selected sessions and drafts |
| Side chat | `/workspace-next.html?scene=side` | Existing-page context beside the same conversation |

The original layout comparison is retained at `/workspace-draft.html`.
Both are standalone Vite development entries; the shipped application's entry,
routes, authentication and pages are unchanged.

## Proposed behavior

- Chat and terminal share the same folder, execution-host and agent controls,
  implemented by one component with the same icons and placement.
- Switching representations, expanding a pane, or closing/reopening side chat
  preserves the selected session's in-tab message draft.
- Parallel panes have separate sessions and drafts. On phones, tabs select which
  pane is visible rather than squeezing two columns onto the screen.
- The project-nested sidebar is a proposal based on the supplied desktop
  reference. All sessions remains available for comparison. Production
  `DESIGN.md` flat-list behavior is not superseded by this mock.
- Theme switching uses ORC's existing neutral tokens. The mock reuses shared
  Button, AgentIcon, StateBadge and Markdown components.

## Screenshots

Captured at 1500 × 1000 desktop and 390 × 844 phone using synthetic data only.

### New-session home

![Full-page new-session home](./workspace-mocks/home.png)

### Focused conversation

![Focused chat workspace](./workspace-mocks/focused.png)

### Parallel chat and terminal

![Two sessions with shared controls](./workspace-mocks/parallel.png)

### Terminal representation

![Terminal view with the same workspace controls](./workspace-mocks/terminal.png)

### Side chat

The task list shown here is mock context, not a proposed Tasks redesign.

![Side chat beside illustrative page context](./workspace-mocks/side.png)

### Phone

![Phone chat workspace](./workspace-mocks/phone.png)

## Validation and limits

Local web TypeScript and Biome checks passed. Existing agent-state/session-home
unit tests passed 9/9 (32 assertions). The second iteration passed 21 browser
checks covering default chat, shared context, independent drafts, view switching,
side-panel lifecycle and phone layouts. The first comparison passed 16 browser
checks. Browser inspection confirmed zero live API requests and no reported
runtime errors in the final validation batches.

All sessions, messages, task context and CLI output are synthetic and stay in the
open tab. No agents or shell commands are started. No provider model catalog is
invented; the model label remains Agent default. Production integration still
needs real session/terminal continuity, persistent state, catalog-driven controls,
complete drawer keyboard/focus behavior and corresponding live-flow tests.

This PR is for layout review. It does not close the underlying feature issues.
