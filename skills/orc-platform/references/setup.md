# Setup, interfaces and authentication

Contents: installation; connection/config; interfaces; diagnostics and recovery.
Detailed sources: [Getting started](https://github.com/niradler/orc/blob/master/README.md#getting-started),
[Connect your agent](https://github.com/niradler/orc/blob/master/README.md#connect-your-agent),
[Configuration](https://github.com/niradler/orc/blob/master/README.md#configuration).

## Install and verify

Choose the user's target: desktop for an interactive local installation, headless
CLI/binary or Docker for a server, source checkout for ORC development. Check an
existing installation before installing another. Do not upgrade or restart a live
service as an implicit part of answering a setup question.

- Desktop: select the OS/architecture installer from ORC Releases. It bundles the
  runtime, dashboard and CLI; a separate Bun/Node installation is unnecessary.
  It attaches to an existing daemon or starts its own. A daemon it starts gets an
  API secret stored in `~/.orc/config.json`. Open a new terminal after CLI PATH setup.
- Headless: `npm install -g orc-ai` requires Bun >= 1.4.2; alternatively use the
  matching standalone release binary. Confirm `orc --version` and executable path.
- Source: use Bun workspaces (`bun install`, `bun build`). Follow this repository's
  `AGENTS.md` for dev ports and `bun dev`; a published/global daemon does not run
  edited source. `npm install -g` above is a distribution install, not a repo workflow.
- Docker: use the current README Docker recipe, persistent ORC home and a mounted
  repository. Project folders must be container paths. Installed backend tools do
  not supply provider credentials or prove native agent hook enforcement.

For a new headless install, `orc daemon start`; skip starting a second daemon if
desktop or an existing service owns it. Verify `orc daemon status`, `orc status`
and `orc doctor`. The production API/dashboard default to `http://127.0.0.1:7700`.
Then `orc project add my-app`, `orc project use my-app`; verify its folder scope
points to the correct repository on the machine that will execute the work.

## Configuration and credentials

Effective config: user `~/.orc/config.json`, then project `./.orc/config.json`,
then environment variables. Server processes use their own environment and cwd;
editing a shell variable does not reconfigure a running daemon. Inspect only
needed non-secret fields, not a dump of the whole config or environment.

Distinguish these credentials:

| Credential | Used by |
| --- | --- |
| `ORC_API_SECRET` / `api.secret` | Clients calling ORC's API and HTTP MCP |
| Agent/provider login or API key | The backend that runs Claude, Codex, ACPX, etc. |
| Knowledge embedding API key | The external embedding provider; see knowledge.md |
| Telegram/Slack token | The messaging gateway |

Set the same ORC Bearer secret on server and clients when authentication is
enabled. An empty API secret is open mode; check the actual bind address and
intended exposure before configuring remote access. ORC auth is installation
access, not a tenant isolation boundary. Do not place credentials in URLs.
Browser access prompts on `401`; persist a secret only on explicit Remember in
this browser. Normal non-secret preferences belong in config, not a secrets table.

Workspace theme/terminal-font preferences use Settings or authenticated
`GET/PATCH /api/settings`; patch only supported non-secret fields and reload to
verify persistence. Runtime/knowledge/SSH settings have their own supported routes
or config. Do not put API/provider credentials into the preferences endpoint.

## Choose and connect an interface

### CLI bridge first

Before reporting unavailable ORC tools, check `spec --help` and `spec specs`.
Use an existing ORC registration when present. Otherwise use an inline source;
no registry write or per-agent MCP setup is required:

```sh
spec show --mcp-http <orc-base-url>/mcp context
spec call --mcp-http <orc-base-url>/mcp context --data '{"project":"orc"}'
spec call --mcp-http <orc-base-url>/mcp skill_read --data '{"name":"orc-sdlc","project":"orc"}'
```

Select the intended installation first; the example project is not a default for
other repositories. Inspect actual schemas with `spec show`, discover tools with
`spec list`, and load references with `skill_read`'s `ref` argument. An existing
secure stdio launcher can be passed with `--mcp-stdio` instead. For authenticated
HTTP use the existing registration's secret references (`env:NAME` or `file:...`),
not a literal secret in argv, documents or logs. Already connected direct MCP tools
remain supported. Only report a gap after the applicable bridge/direct checks fail;
identify the actual failure without reconfiguring agents or exposing credentials.

| Interface | Use and discovery |
| --- | --- |
| Dashboard | Interactive setup, settings, documents, packages and monitoring |
| CLI | Shell work and operations not exposed by MCP; `orc --help`, then `<command> --help`; use `--json` when supported |
| REST API | Integrations; `/api/...`, Bearer header, current `/openapi.json` and `/docs` |
| SDK | Typed integrations over the same API; its base URL is the origin and the SDK appends `/api` |
| MCP | Agent context and domain operations; discover with `skill_list`, tool schemas, or meta tools |

CLI/stdio clients use `ORC_API_BASE` for the API origin and `ORC_API_SECRET` for
auth. Check installed help for additional connection flags. For stdio MCP,
configure the client to launch the resolved `orc mcp` executable with the intended
environment. Protocol output belongs on stdout and diagnostics on stderr. For
HTTP MCP use `<origin>/mcp` and the configured auth header; do not append `/api`
to that MCP endpoint. Preserve other MCP servers when editing client config.

Stdio `orc mcp` defaults to meta mode; pass `--mode full` to list every domain
tool directly. HTTP `/mcp` defaults to full; `/mcp?mode=meta` matches stdio. Meta mode exposes `tool_search`, `tool_describe`, `tool_invoke`:
search by intent, describe unknown arguments, then invoke the selected tool.
Reach `context` and other named tools through `tool_invoke` in meta mode.
Connectors, loaded skills and installed hooks do not establish equal enforcement
across agent clients. Disclose when MCP is unavailable; never claim a context read ran.

### Customize the HTTP MCP connection

These query parameters customize `<origin>/mcp`; they also work together in meta
mode. Keep API authentication in the configured Authorization header.

| Parameter | Supported values | Default and effect |
| --- | --- | --- |
| `mode` | `full`, `meta` | `full`: lists domain tools directly. `meta`: lists `tool_search`, `tool_describe`, `tool_invoke`; domain operations keep the same validation and scope. |
| `project` | One readable project name, such as `orc` | Unset: existing tool/config defaults apply. When set, project-aware tools inherit this project. |
| `projects` | Comma-separated readable names, such as `orc,project2` | Selects multiple projects in priority order. Use instead of `project`. |

Examples, relative to the selected ORC origin:

```text
/mcp                                  # full tools, existing tool/config defaults
/mcp?mode=meta                        # meta tools, existing tool/config defaults
/mcp?project=orc                      # full tools, ORC project defaults
/mcp?projects=orc,project2             # full tools, both projects
/mcp?projects=orc,project2&mode=meta   # both projects through meta tools
```

Use readable names, not project IDs, in the URL; URL-encode spaces and reserved
characters. Names are trimmed and deduplicated case-insensitively, preserving the
first occurrence. Select at most 50 projects, with names of 1-200 characters.
Pass each project parameter once and never pass both `project` and `projects`.
Malformed selections or an unsupported mode return HTTP 400; any unknown project
returns 404, rather than silently falling back to another project.

Project selection is connection-wide, rather than a skill-only filter:

- `context`, task/job/memory lists, project discovery, audit and searches combine
  selected projects before limits or pagination. Archived-session search uses
  the same selection. Memories remain project-only; same-named memories in
  different projects remain separate items.
- Skill discovery includes selected projects' skills plus unassigned global
  skills, with shared skills appearing once. Reads prefer the first applicable
  project instruction override in URL order, then global instructions.
- Knowledge discovery/search/evidence includes selected projects' KBs plus
  global KBs. On a bound connection, KB `scope: "all"` stays within this selection.
- New resources default to the first URL project. An explicit tool `project`
  (or `project_id` when its schema supports it) can choose another selected
  project. For example, `task_list({})` combines the connection's projects;
  `task_list({project: "project2"})` narrows to that project. Overrides outside
  the URL selection are rejected. ID-targeted operations retain the resource's
  existing owner.
- Global-only reads remain available where the tool supports `scope: "global"`.
  Resources without project scoping retain their existing behavior. Without a
  project query parameter, existing activeProject/tool defaults still apply.

This selection does not grant access or replace API authentication or tenant
authorization. Do not put secrets in the URL. Pagination/search settings such as
`limit`, `offset` and `q` belong in tool arguments, not the MCP connection query:
`skill_list({q: "code review", limit: 25, offset: 0})`. Skills default to 30 per
page (maximum 500); follow `next_offset` until it is null. Other tools retain
their own schemas and limits.

For a bridge connection using both parameters:

```sh
spec call --mcp-http "<orc-base-url>/mcp?projects=orc,project2&mode=meta" tool_invoke --data '{"name":"context","arguments":{}}'
```

## Diagnose before changing anything

- Connection refused: verify origin, port, service ownership and process logs.
- HTML instead of JSON: use `/api/<route>`; SPA routes such as `/tasks` serve HTML.
- `401`: match the ORC secret and endpoint; do not remove auth to make a check pass.
- Missing tools/options: compare client discovery, executable version and server
  schema. Do not invent an endpoint or silently substitute another installation.
- Backend unavailable: `orc doctor` reports actual readiness; inspect that backend's
  dependency, endpoint and credentials on its execution host.
- Source changes invisible: check process command/cwd and repo dev instructions;
  do not kill unrelated Bun/MCP sessions or start competing listeners.

Logs: daemon JSON logs default to `~/.orc/logs/orc.log`; desktop-owned daemon output
also goes to `~/.orc/desktop-daemon.log`. Read a bounded relevant tail and redact
secrets. For backup, stop writes consistently and preserve the ORC database with
its SQLite sidecars, knowledge originals, config and `~/.orc/secret.key` securely.
The key is needed to decrypt stored embedding credentials. A restored install
must pass health, scoped data reads and the relevant operation before calling it recovered.

## Service lifecycle, upgrades and recovery

`orc daemon install` registers auto-start and starts the daemon; use it only when
background operation is intended. Inspect `orc daemon status` and the actual API
origin afterward. `orc daemon stop` affects the owned daemon; desktop stops only
one it started. Follow current README service instructions for the OS rather than
blanket-killing Bun or editing arbitrary startup files.

For an intended upgrade, record current version/executable/config/DB location,
make a consistent secure backup, select the correct distribution/architecture,
replace through that installation's supported updater/package path, restart the
owned service, then verify health, scoped reads, scheduler/backend and representative
operations. Do not run migrations against the only live copy as an experiment.
Restore into an isolated location first, including knowledge originals and the
secret key, and verify document reads/search and credential availability. Rebuilt
indexes are not substitutes for original documents. Describe unavailable checks;
publishing ORC releases is a separate maintainer operation documented in docs/releases.md.
