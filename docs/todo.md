What needs improvement
Agent onboarding is still friction-heavy. A new agent session has to: call context(), then project_list(), then project_get() to get a project ID, then pass project_id everywhere. Consider: the MCP server could auto-resolve activeProject from config (like the CLI does) so agents don't need to manually resolve names to IDs.

No MCP tool to create/manage projects. Agents can list/get projects but can't create them via MCP — they have to use CLI or API. Add project_create and project_update MCP tools.

The context() tool doesn't say which project it's showing. When scoped to a project, the response should include the project name/ID at the top so the agent knows what it's looking at.

Capabilities not documented anywhere:

Task links (blocks, subtask_of, etc.) — powerful for dependency tracking but barely mentioned in README
Task notes/threads — the collaboration trail between agents
Prompt/skill templates in DB (prompts table) — not documented at all
orc project show dashboard with task/memory/job counts — not in any skill
Webhook job triggers
Voice integration (speech-to-text via Telegram)
The TUI is in-progress and not mentioned. packages/tui/ exists with TaskBoard, JobMonitor, MemBrowser, Dashboard components. Worth mentioning as a capability even if WIP.

Multi-agent delegation isn't fully there yet. ORC has the primitives (tasks, claimed_by, session isolation) but there's no "delegate this task to another agent" MCP tool that would create a task and trigger a job to launch another agent on it. That's the bridge between "shared state" and "orchestration."