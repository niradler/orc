# Live agent sessions

The Sessions view uses the same working, waiting and ended states, task links, search and conversation viewer for all agents. Waiting sessions stay in the active view; inactivity alone does not end a registered session.

Codex uses its native writer locks and latest turn status. A held lock identifies an open session; a completed turn is waiting, and a turn in progress is working. A released lock ends the session. Older Codex versions without a writer-lock directory retain the legacy activity fallback.

Cursor IDE history, Cursor CLI (`agent` / `cursor-agent`) history and Gemini conversations are discovered separately. CLI and IDE Cursor histories are separate stores: only Cursor CLI records offer a CLI resume command. Gemini and Cursor CLI support Open in terminal, Copy resume command, and Copy terminal link alongside Claude and Codex.

Install lifecycle hooks for Cursor and Gemini from this checkout:

```powershell
bun scripts/install-session-hooks.ts
```

The installer preserves existing hook entries and other settings, makes dated backups, and adds lifecycle events to `~/.cursor/hooks.json` and `~/.gemini/settings.json`. New/resumed sessions register their owner PID in `~/.orc/live-sessions/`. Start, prompt, response, tool and stop hooks update the shared state; session-end hooks and dead owner processes end it. Existing sessions may need to resume or reload hooks once before they register. Hook-captured conversations begin when hooks are installed; old native history is retained when its transcript exists.

Hooks need Bun on the installation machine. They run a bounded owner lookup, write private local registry/transcript files, and never grant tool permissions or inject prompts. Native agent transcripts remain read-only. Full prompt/tool content belongs to the local conversation history and is not sent to external services by these hooks.

Other local agents can use `LiveRegistration`, `readRegistrations` and `writeRegistration` from `@orc/core/live-session` to participate in the same PID-backed lifecycle. Native discovery/resume commands still require a supported adapter; the dashboard automatically includes registered backend names in its filter.
