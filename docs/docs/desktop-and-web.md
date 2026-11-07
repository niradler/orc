# Desktop app and web dashboard

A tour of every page in the ORC dashboard and what the desktop app adds on top of it.

The dashboard is served by the daemon at `http://localhost:7700`. The desktop app shows the same dashboard in its own window, so everything below applies to both.

## Layout

| Area | Contents |
| --- | --- |
| Sidebar | Activity, Tasks, Knowledge, Terminals, Library, Settings. Shows the execution host, for example `Connected (local)`. |
| Project picker | Scopes most pages to one project, all projects, or unassigned items. A project with sessions waiting on you shows how many. |
| Chat panel | Talk to any enabled coding agent from any page. Pick the agent and model at the top. Claude and Codex run natively; other agents run through ACPX. |
| Command palette | **Ctrl+K** (**Cmd+K** on macOS) to search and run commands |
| Next session | **Alt+J** (**Option+J** on macOS) opens the next session that needs you, then the next finished session you have not seen. It does nothing while you are typing. |

Pages are grouped in the sidebar:

| Group | Pages |
| --- | --- |
| Activity | Activity, Sessions, Jobs, Webhooks, Audit |
| Tasks | Tasks |
| Knowledge | Knowledge base, Memories |
| Terminals | Terminals |
| Library | Skills, Packages, Agents, Rules, Scratchpads |
| Settings | Settings |

Projects has its own page at `/projects`. Every page has a shareable URL.

The sun and moon button in the header switches between the dark and light themes:

![Dashboard in the light theme](/screens/dashboard-light.png)

## Full-width sessions view

Open the chat panel and click **Full screen chat** to work with every agent session in one place. The same view opens from the full-screen button on **Sessions** (on the page or on a row) and in the **Terminals** session list.

- **Session list**: chats, coding agents running in ORC terminals, and live sessions discovered from your coding agents, each with its state. Click a chat to read it, a terminal agent to see its terminal, or a discovered session to resume it in chat. Collapse the list to a rail of icons with its state marks; expand it again from the rail.
- **Inspector**: the panel button in the header shows the host, folder, branch, changed files, linked task and pull request for the selected session. When a terminal is running in that folder, a **Diff** tab shows its Git changes.
- **Terminal drawer**: the terminal button in the header opens a shell in the session's folder below the conversation.
- Drag a splitter, or focus it and use the arrow keys, to resize the list, inspector or drawer. Double-click to reset. The width is remembered.
- The sidebar shows as its collapsed rail while the view is open. **Exit full screen chat** returns to the page you came from.
- The URL keeps the selected session and which panels are open, so reload and Back restore them.
- The header shows the recorded project and session title. Unlinked terminal agents
  show **Unknown** until agent activity supplies a state; they appear only in All projects
  while project ownership is unavailable. The Activity session list uses the same
  compact row design, retaining search, filters, task links and resume actions.

On a phone the list opens full screen from **Sessions** in the chat header and the inspector opens as a sheet.
Opening the list sets `sessionList=show` in the URL, so reload and Back restore it.
Exit full screen also returns to the original page after navigating Back and Forward.

![Session home with its inspector and demo data](/screens/session-home-desktop.png)

<img src="/screens/session-home-phone.png" alt="Phone conversation with compact composer controls" width="260">
<img src="/screens/session-list-phone.png" alt="Full-screen session list on a phone" width="260">

## Activity

![Activity](/screens/dashboard.png)

The **Activity** page: task metrics plus recent jobs, memories and sessions for the selected project.

## Tasks

![Tasks](/screens/tasks.png)

The task board. Switch between **Board** (kanban) and **Table** views and filter the list. The GitHub panel lists issues and pull requests from known repositories (yours, assigned to you, or all open) and links them to tasks.

Open a task to see its body, status, comments, linked sessions and Git links, and its flow run:

![Task detail](/screens/task-detail.png)

**Edit task → View flow** shows the nodes and edges of the task's [flow](./task-flows.md), including loops back for review:

![Task flow](/screens/task-flow.png)

## Sessions

![Sessions](/screens/sessions.png)

Live and archived sessions from Claude Code, Codex, Cursor, Gemini CLI and OpenCode on this machine or the selected host. Working sessions update live; waiting sessions stay available to resume in a terminal or in chat. Search across archived conversations. See [Live sessions](./live-sessions.md).

Filter the list by state with **All**, **Needs you**, **Working** and **Done**. Each filter shows its count, and failed sessions count as Needs you. A session that finished after you last opened it shows **Done** until you open it. This browser remembers what you have seen. The chat session history has the same filters.

While your pointer is over the list, or a row has keyboard focus, rows stay where they are. States still update in place. When the order would change, an **N updated** button appears. Click it, or move away from the list, to apply the new order.

## Terminals

![Terminals](/screens/terminals.png)

Browser terminals for shells and coding agents, with split panes and Files and Git panels beside them. Terminals run on the selected execution host. See [Terminal workspace](./terminal-workspace.md).

## Projects

Create, edit and archive projects. A project has a name, description, tags and an optional Git remote URL. Deleting a project deletes its memories and scratchpads and keeps its tasks, jobs and sessions without a project.

## Memories

Short project facts (ports, conventions, decisions) that agents load at session start. Create, edit, and view each memory's change history. Under **Knowledge → Memories**.

## Knowledge

![Knowledge](/screens/knowledge.png)

Knowledge bases: upload PDFs, Office files, HTML, CSV and Markdown, write Markdown in place, or register a folder to copy in. Search returns cited passages. Each knowledge base can have a digest agent that maintains it on a schedule.

## Jobs

![Jobs](/screens/jobs.png)

Scheduled and on-demand automation. A job runs a shell command, an agent or creates a task, triggered manually, by cron, by a file watch, once, or by a webhook. Each job keeps its run history with logs and linked agent sessions.

## Webhooks

Inbound event sources. Configure a webhook once, then connect it to one or more jobs, each with its own event filters and action.

## Notifications

When a session you are not viewing needs your approval, has a question or fails,
ORC shows a **Needs you** notification and plays a short chime. Notifications
settle for about one second before appearing and repeated snapshots do not repeat
the alert. The header bell opens a menu containing generic notifications, including
human requests, agent outcomes and job results. Open a request to answer or review
its action. Read and dismissed state is shared across clients.

Desktop browsers show toasts. Needs-you toasts stay until dismissed or resolved;
**Done** toasts are silent and close after six seconds, pausing on hover or focus.
Sessions finishing together collapse into one notification. Use **Alt+N** or
**Open notifications** in the command palette to reach notifications.

On all screens, the bell in workspace and chat headers shows an unread count.
New notifications never open the panel automatically. Tap the bell to read or
dismiss them. History remains until dismissed or expired (30 days by default).
Configure notification and audit retention in Settings → Storage.
See [Notifications](./notifications.md) and [Human requests](./human-requests.md).

**Settings → Notifications → Sound** controls the browser chime, volume and
per-project sound mute. Preferences are saved in this browser. Audio starts after
your first interaction. Browser/PWA push remains separately opt-in and requires
HTTPS (and Home Screen installation on iOS); it delivers background approvals,
questions and chat replies while ORC is unfocused. See [Installation](./install.md).

The Electron desktop app also sends native notifications while its window is
unfocused, minimized or hidden. Clicking one brings ORC forward and opens its
destination. Done notifications are silent; native Needs-you sound follows the OS.

## Audit

Lifecycle and knowledge events with filters and expandable details. Recorded
session summaries remain in collapsed history. Audit retention defaults to 90
days and is configurable in Settings → Storage. Use Sessions to read full
conversations or resume an agent.

## Skills

Reusable agent instructions stored as skill folders. Import skills from a repository or from local agent folders, create your own, edit files, view history, and assign skills to projects. See [Skills](./skills.md).

## Packages

Packages bundle instructions, skills and tools for reuse. Launch a package in chat or a terminal on the host and folder you choose. See [Agent packages](./agent-packages.md).

## Agents

Shared specialist agent definitions: instructions, model and tools, reusable across coding agents and packable into packages. Under **Library → Agents**.

## Rules

Applied rules and their outcomes per workspace, plus rule settings for enforcement and agent assignment. See [Agent rules](./agent-rules.md).

## Scratchpads

Working documents, diagrams and HTML pages that you or an agent create and come back to. Agents use the `pad_*` MCP tools. Share one by copying its link.

## Settings

![Settings](/screens/settings.png)

| Section | Controls |
| --- | --- |
| Connection | API URL for this browser |
| Security | Sign-in status and sign-out, default sign-in lifetime, allowed web origins, access tokens (minted by entering the secret) |
| Appearance | Theme |
| Execution host | Run agents, terminals and git locally or on an SSH host from `~/.ssh/config` |
| Server | **Restart ORC server** (closes terminals, keeps settings, reconnects) |
| Notifications | In-app updates, browser chime/volume/project mute, and opt-in browser/PWA push for background approvals, questions and chat replies. Push needs HTTPS. |
| Agents | Which coding agents appear in the chat agent picker, channel agent choices and the terminal launcher. Claude Code and Codex are native; Cursor, Gemini CLI, GitHub Copilot, OpenCode, Qwen Code, Factory Droid, Kimi CLI, Kiro CLI and any custom agent id run through ACPX. The terminal launcher only lists enabled agents installed on the selected host. |
| Channels | Telegram and Slack connections |
| Chat | Default models, instructions, tools and permission mode for chat |
| MCP | Build the MCP config snippet for your agent. See [Connect agents](./connect-agents.md). |
| Integrations | APIs and MCP servers in the `spec` CLI registry |
| Knowledge | Parser, embeddings and knowledge defaults |
| Terminals | Terminal font for new terminals |
| Storage | Where settings are stored |
| About | Server, desktop and Electron versions, platform, runtime, data folder, uptime, project links, and desktop update channel |

![Coding agents settings](/screens/settings-agents.png)

Enabled agents, including custom ACPX ids, appear in the chat agent picker:

![Chat agent picker](/screens/chat-agent-picker.png)

## Chat turn progress

Finished turns fold tool calls and intermediate narration into one expandable line;
your message and the final reply remain visible. Expand it to inspect file diffs,
commands and output, reads, and searches. Failed tools stay marked.

During a response, a quiet status line shows elapsed time and the current tool.
Scrolling up pauses automatic following; **Jump to latest** returns to the bottom.
Stop remains beside Send. Working indicators are static.

Each turn keeps its duration and completed, stopped, or failed outcome across reloads.
Duration uses the agent's reported value when available, otherwise server elapsed
time, including waits for input. Older turns without timing show counts only.
Stopped turns retain partial work; unfinished tool calls read **Incomplete**.
Individual tool durations are not shown.

## Composer controls

The composer groups folder, branch, agent/model and permissions into compact
controls. Phones and narrow desktop panels use icons; wide composers show labels.
Every icon has an accessible name and opens its picker with the full details;
phone touch targets are at least 44px. Send stays visible at the right.

The folder picker shows the full path, copy action, recent folders, host choices
when configured, and browsing. Branch/worktree controls appear for Git folders.
Folder and branch controls hide after launch; conversation details show the working folder.
Changing agent after launch starts a separate session. The model picker disables
changes during a response or when the backend selects its own model. Effort stays
in agent options. The permissions control appears for a non-default mode only when
the backend supports changing it live.

Pasting at least 16 KiB or 200 lines attaches the text as `pasted-text-N.txt`.
Use **Ctrl/Cmd+Shift+V** to paste inline instead. Typing `@` does not attach files.

<img src="/screens/chat-composer-390.png" alt="Compact composer icons on a phone" width="260">

## Desktop app only

The desktop app is an Electron shell around the same dashboard. On top of the browser experience it:

| Capability | Detail |
| --- | --- |
| Runs the daemon for you | Reuses a verified local daemon, including one on another port, or starts the bundled `orc` daemon |
| Configures auth | Generates an API secret for a daemon it starts when none is set, and sends the configured secret automatically. No sign-in screen. |
| Installs the CLI | `~/.orc/bin/orc`, added to your shell `PATH` |
| Tray icon | **Open orc**, **Start at login** toggle, **Quit orc** |
| Start at login | On by default, starts hidden in the tray |
| Keeps running when closed | Closing the window hides it; the tray icon and the daemon keep running. **Quit orc** in the tray (or **Cmd+Q** on macOS) quits. |
| Recovers from startup failures and crashes | Waits briefly for a starting daemon, then offers **Retry** or **Quit** if it cannot connect |
| Remembers the window | Size, position and maximized state |
| Updates | Installed Windows and Linux apps check GitHub Releases at startup and every four hours, download in the background, and offer **Restart to update** |

Quitting the app (**Quit orc**) stops the daemon only if the app started it.

If another application occupies the configured port, desktop automatically starts
ORC on an available port bound to `127.0.0.1`. It saves the successful endpoint in
`~/.orc/config.json`, so the CLI and stdio MCP use the same port by default.
Explicit CLI flags, environment variables and project configuration keep their
normal precedence; update pinned ports or URLs in external integrations yourself.

Desktop checks the daemon's runtime identity, compatible version (same major and
minor), database, configuration and authentication before attaching. It never
starts another daemon while the daemon PID is alive, even if that daemon is
unhealthy or uses different data. Authentication and configuration errors offer
**Retry** or **Quit**, with the reason shown. It does not stop an existing daemon
or the application occupying the preferred port.

**Upgrading an already-running older daemon:** releases without `daemon.json`
cannot provide this identity check. Stop that daemon once and start it with the
updated ORC, then choose **Retry** in desktop. Desktop does not attach to an
unverified daemon or send it the configured secret.

Command-line flags for the app executable:

| Flag | Effect |
| --- | --- |
| `--hidden` | Start without opening a window |
| `--quit` | Quit the running instance and the daemon it started |

Links to other sites open in your system browser.

Install a desktop build containing this updater manually once. Older builds do not have an updater and cannot automatically install the feature itself; subsequent Windows and Linux updates can use the flow below.

An installed Windows or Linux app checks [GitHub Releases](https://github.com/niradler/orc/releases) for updates when it starts and every four hours. The download runs in the background. **Settings → About** shows the current version, the update channel, **Check now**, and the last result. **Restart to update** installs the download. The app stops the daemon it started, then the new version starts that daemon again. Tasks and sessions stay in `~/.orc`. A daemon the app did not start is left running.

**Stable** uses the latest GitHub release. **Preview** also accepts a newer prerelease. Uncheck **Check for updates** to stop automatic checks; **Check now** still works. These choices are stored in the desktop app's own settings, not in `~/.orc/config.json`. Source runs and `electron .` do not download updates.

Wait for an active check or download to finish before changing channels. Changing channels discards the previous channel's ready update. Failed settings saves retain the prior preferences and show an error; failed update actions can be retried.

Windows installs the NSIS package. Linux replaces the AppImage. Automatic updates are not offered on macOS yet: Developer ID signing and an installed macOS upgrade test remain outstanding. Install the latest disk image manually. Manual upgrade steps remain in [Upgrading](./install.md#upgrading).
