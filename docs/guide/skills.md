# Skills

Installing ORC's skills into coding agents, the built-in entry-point skills, managing your own skills, and how shared agents and packages fit in.

## Install ORC skills into an agent

The repository's `skills/` folder follows the [Agent Skills format](https://agentskills.io/specification), so the `skills` CLI installs it into any supported agent:

```bash
npx skills add niradler/orc --all
npx skills add niradler/orc --skill orc-platform orc-sdlc
npx skills add niradler/orc --all -g
```

`-g` installs globally instead of into the current project.

Agents connected over [MCP](./mcp.md) do not need a local copy: they discover the same skills with `skill_list` and load them with `skill_read`.

## Entry-point skills

ORC ships two built-in skills. Each keeps its `SKILL.md` short and loads one reference file when needed.

| Skill | Use for | References |
| --- | --- | --- |
| `orc-platform` | Operating ORC: CLI/API/MCP, auth and settings, projects, tasks and flows, memory, knowledge bases and digests, sessions and handoff, terminals and chat, jobs, channels and gateway, human requests, agents and packages, Git/GitHub/SSH, rules and hooks, scratchpads | `setup`, `work`, `memory`, `knowledge`, `execution`, `session-archive`, `channels`, `chat-ui`, `web`, `packages`, `rules`, `scratchpads`; scripts `upload-session.py`, `sync-sessions.py` |
| `orc-sdlc` | Engineering work on ORC-backed projects: proportional planning, implementation, debugging, validation and review, preserving an assigned flow node's role and outcomes | `planning`, `development`, `review-and-delivery` |

Retired names such as `orc-coder` and `orc-reviewer` still resolve for saved tasks and older flows; they map onto `orc-sdlc` and do not appear in discovery.

## Where skills live

| Source | Location |
| --- | --- |
| Built-in | `skills/` in the ORC install |
| User | `~/.orc/skills/<name>/SKILL.md` |
| Package | `~/.orc/packages/<package>/.apm/skills/<name>/` |

A skill is a whole folder:

```text
my-workflow/
  SKILL.md
  references/guide.md
  scripts/check.py
  assets/template.json
```

`skill_list` returns metadata only. `skill_read` returns `SKILL.md` plus the file inventory; pass `ref` for one supporting file (`ref: "guide.md"` reads `references/guide.md`). Binary files come back base64-encoded.

For scripts and assets, `skill_read({ name, ref, download: true })` returns a signed ten-minute `download_url` with `sha256` and `size_bytes`. Download the file and check the hash; downloading never executes it.

## Create and edit

```bash
orc skill create my-workflow --directory ./my-workflow
orc skill validate ./my-workflow
orc skill read my-workflow --ref references/guide.md
orc skill update my-workflow -f ./SKILL.md --reason "Add rollback step"
orc skill file my-workflow scripts/check.py -f ./check.py
orc skill history my-workflow
orc skill export my-workflow ./exported/my-workflow
```

| Limit | Value |
| --- | --- |
| Supporting files per skill | 512 |
| Size per file | 8 MiB |
| Size per skill | 16 MiB |

Instruction edits (`skill_update`, `orc skill update`) are audited and can be scoped to a project with `--project-id`; revert with `orc skill revert`. Supporting-file writes (`skill_file_write`, `orc skill file`) require the current file text, so stale edits are rejected.

## Search

```bash
orc skill list -q "code review" --limit 30 --offset 0
```

`q` matches names and descriptions with ranked keyword search; every term must match. Pages default to 30 skills (max 500) and return `next_offset`, `null` at the end. MCP: `skill_list({ q, limit, offset })`. API: `GET /api/skills?q=...`.

## Import from GitHub

Accepts a repository URL, `owner/repo`, a skill-folder URL, or a `https://skills.sh/owner/repo/skill` link.

```bash
orc skill import vercel-labs/agent-skills --list
orc skill import vercel-labs/agent-skills --skill web-design-guidelines
orc skill sync web-design-guidelines
orc skill origin web-design-guidelines
```

| Rule | Detail |
| --- | --- |
| Credentials | `gh auth token` on the execution host, then `ORC_GITHUB_TOKEN` / `github.token`; public repos need none |
| Per import | 1-16 skills, 64 MiB total |
| Name clash | Existing skills are never overwritten |
| Sync | Keeps local edits on files upstream did not change; pauses on conflicts for review |
| Backups | `~/.orc/skill-sync-backups/`; provenance in `~/.orc/skill-imports/` |

Dashboard: **Skills → Import from GitHub**.

## Move skills between ORC and local agents

| Agent ID | Global folder | Project folder |
| --- | --- | --- |
| `claude` | `~/.claude/skills` | `.claude/skills` |
| `codex` | `~/.codex/skills` | |
| `agents` | `~/.agents/skills` | `.agents/skills` (Codex and shared agents) |
| `gemini` | `~/.gemini/skills` | `.gemini/skills` |
| `cursor` | `~/.cursor/skills` | `.cursor/skills` |
| `opencode` | `~/.config/opencode/skills` | `.opencode/skills` |

```bash
orc skill local                                   # scan every agent folder
orc skill local claude -s pdf-tools               # import one skill
orc skill local --path ./shared-skills --all      # import from any folder
orc skill project-folders --project my-app        # list a project's skill folders
orc skill export-to claude my-workflow --dry-run
orc skill export-to claude my-workflow --project my-app   # <repo>/.claude/skills
orc skill export-to ./exported my-workflow --overwrite my-workflow
```

Duplicates and near copies are detected by content and skipped. Imports never replace an ORC skill. Exports replace an existing folder only when named in `--overwrite`, and keep a backup.

Dashboard: **Skills → Import / export**.

## Project assignment

A skill with no project assignments is global. Assigned skills are visible only to those projects.

```bash
orc skill projects my-workflow                      # show
orc skill projects my-workflow --set <project-id> <project-id>
orc skill projects my-workflow --global             # clear
```

An MCP connection to `/mcp?project=my-app` (or `?projects=a,b`) discovers the selected projects' skills plus global ones. `skill_create` over a scoped connection creates the skill in that project. API: `GET`/`PUT /api/skills/{name}/projects` with `{ "project_ids": [] }`.

## Discovery visibility

Each skill has an **Agent discovery** toggle on the **Skills** page. Hidden skills drop out of `skill_list` but stay readable by name, so existing flows keep working.

```bash
orc skill visibility
orc skill visibility --hidden-skills old-workflow legacy-deploy
```

Stored as `skills.hidden_skills` in `~/.orc/config.json`. API: `GET`/`PUT /api/skills/settings/visibility`; `GET /api/skills?include_hidden=true` returns the full catalog.

## Shared agents and portable packages

Agent profiles describe a specialist in [APM's `.agent.md` format](https://microsoft.github.io/apm/producer/author-primitives/instructions-and-agents/); a backend picks the coding agent that runs it. Packages bundle profiles, skills and instructions.

| Item | Location |
| --- | --- |
| Shared profiles | `~/.orc/agents/` |
| Project profiles | `.apm/agents/` in the project (override shared IDs) |
| Packages | `~/.orc/packages/<name>/` (OpenAPM `apm.yml` or Agent Plugins `plugin.json`) |
| Package agent IDs | `<package>/<file-stem>` |

```bash
orc agent-package import ./team-agents
orc agent list
orc agent read team-agents/reviewer
orc agent create reviewer --file ./reviewer.agent.md
```

Use a profile in a flow node independently of its backend:

```json
{ "kind": "agent", "agent": "team-agents/reviewer", "backend": "codex-cli", "outcomes": ["pass", "fail"] }
```

Import never resolves dependencies or runs lifecycle scripts. Full guide: [Reusable agent packages](./agent-packages.md).
