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
| Activity | Activity, Attention needed, Sessions, Jobs, Webhooks, Audit |
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

On a phone the list opens full screen from **Sessions** in the chat header and the inspector opens as a sheet.

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

## Attention needed

Questions and approval requests from your agents in one queue. Answer here and the reply goes back to the waiting session. See [Human requests](./human-requests.md).

## Agent notifications

When a session you are not viewing needs your approval, has a question or fails,
ORC shows a **Needs you** notification and plays a short chime. Notifications
settle for about one second before appearing and repeated snapshots do not repeat
the alert. **Open Attention** takes you to the queue, closing any open chat. A
single pending approval also offers **Approve** and **Deny**.

Desktop browsers show toasts. Needs-you toasts stay until dismissed or resolved;
**Done** toasts are silent and close after six seconds, pausing on hover or focus.
Sessions finishing together collapse into one notification. Use **Alt+N** or
**Focus notifications** in the command palette to reach notifications.

On phones, the bell in the workspace and chat headers shows an unread count.
New notifications never open the panel automatically. Tap the bell to read or
dismiss them; Done updates remain there until dismissed or opened.

**Settings → Notifications → Sound** controls the browser chime, volume and
per-project sound mute. Preferences are saved in this browser. Audio starts after
your first interaction. Browser/PWA push remains separately opt-in and requires
HTTPS (and Home Screen installation on iOS); it delivers background approvals,
questions and chat replies while ORC is unfocused. See [Installation](./install.md).

The Electron desktop app also sends native notifications while its window is
unfocused, minimized or hidden. Clicking one brings ORC forward and opens its
destination. Done notifications are silent; native Needs-you sound follows the OS.

## Audit

Recorded session summaries and events. Use Sessions to read full conversations or resume an agent.

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
| About | Server, desktop and Electron versions, platform, runtime, data folder, uptime and project links |

![Coding agents settings](/screens/settings-agents.png)

Enabled agents, including custom ACPX ids, appear in the chat agent picker:

![Chat agent picker](/screens/chat-agent-picker.png)

## Desktop app only

The desktop app is an Electron shell around the same dashboard. On top of the browser experience it:

| Capability | Detail |
| --- | --- |
| Runs the daemon for you | Starts the bundled `orc` daemon, or attaches to one already running on the configured port |
| Configures auth | Generates an API secret when none is set and sends it on every request. No sign-in screen. |
| Installs the CLI | `~/.orc/bin/orc`, added to your shell `PATH` |
| Tray icon | **Open orc**, **Start at login** toggle, **Quit orc** |
| Start at login | On by default, starts hidden in the tray |
| Keeps running when closed | Closing the window hides it; the tray icon and the daemon keep running. **Quit orc** in the tray (or **Cmd+Q** on macOS) quits. |
| Recovers from crashes | If the daemon stops, offers **Retry** or **Quit** |
| Remembers the window | Size, position and maximized state |

Quitting the app (**Quit orc**) stops the daemon only if the app started it.

Command-line flags for the app executable:

| Flag | Effect |
| --- | --- |
| `--hidden` | Start without opening a window |
| `--quit` | Quit the running instance and the daemon it started |

Links to other sites open in your system browser. The app has no auto-update; see [Upgrading](./install.md#upgrading).
