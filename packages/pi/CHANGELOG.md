# Changelog

## [0.1.62]

Initial release of `@orc/pi` (porc).

- Adds the `orc` tool for context, memories, skills, project listing and arbitrary ORC
  tool calls.
- Adds the `orc_spec` tool and `/orc-spec` command over the ORC stdio MCP connection.
- Registers ORC as a native MCP server over stdio by default, with optional HTTP
  transport, `meta` / `full` modes and `direct` / `codemode` / `deferred` exposure.
- Injects a concise ORC system prompt section and the ORC context index once per
  session, resetting after compaction.
- Syncs ORC skills into Pi and bundles `orc-platform` and `orc-sdlc`.
- Adds `porc` (dark) and `porc-light` themes plus `/orc-theme`.
- Adds `/orc`, `/orc-context`, `/orc-project`, `/orc-skills`, `/orc-doctor` and
  `/orc-reload` commands, and session flags to override the connection.
- Resolves ORC API settings from environment, `porc.json` and `~/.orc/config.json`,
  and redacts the API secret from tool output.
- Does not configure Pi model providers.
