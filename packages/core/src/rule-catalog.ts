import { type EventRule, EventRuleSchema } from "./rule-types.js";

export type RuleTemplate = {
  id: string;
  name: string;
  description: string;
  category: "Command routing" | "Guidance" | "Protection" | "Automation";
  configuration: string;
  rule: EventRule;
};

function commandFilter(pattern: string): EventRule["filter"] {
  return {
    match: "all",
    conditions: [
      { predicate: { field: "tool", operator: "equals", value: "Bash" } },
      { predicate: { field: "input.command", operator: "regex", value: pattern } },
    ],
  };
}

function template(value: Omit<RuleTemplate, "rule"> & { rule: unknown }): RuleTemplate {
  return { ...value, rule: EventRuleSchema.parse(value.rule) };
}

const base = { kind: "event", enabled: true };
const commandScope = { agents: ["claude"], events: ["pre_tool"] };
const rtkTarget = {
  type: "rewrite_command",
  argv: ["rtk", "rewrite", "{command}"],
  timeout_ms: 1000,
  rewrite_exit_codes: [0, 3],
  passthrough_exit_codes: [1],
};

export const RULE_CATALOG: readonly RuleTemplate[] = [
  template({
    id: "orc-load-context",
    name: "ORC · Load project context",
    category: "Guidance",
    description:
      "Load active tasks and key shared memories at session start using ORC's existing context service.",
    configuration: "Uses this policy's project scope. Requires the configured ORC API connection.",
    rule: {
      ...base,
      id: "orc-load-context",
      reason: "Load shared workspace context",
      scope: { agents: "all", events: ["session_start"] },
      filter: {
        match: "all",
        conditions: [
          {
            predicate: { field: "payload.source", operator: "in", value: ["compact", "resume"] },
            negate: true,
          },
        ],
      },
      target: { type: "orc_action", action: "load_context", timeout_ms: 1000 },
    },
  }),
  template({
    id: "orc-record-events",
    name: "ORC · Record work events",
    category: "Automation",
    description:
      "Record file, task, Git, environment and other significant tool events with the existing session-event service.",
    configuration:
      "Customize scope, tool filters and event type. Command text and memory contents are not copied into event history.",
    rule: {
      ...base,
      id: "orc-record-events",
      reason: "Retain significant work events",
      scope: { agents: "all", events: ["post_tool"] },
      filter: { match: "all", conditions: [] },
      target: { type: "orc_action", action: "record_event", event_type: "auto", timeout_ms: 1000 },
    },
  }),
  template({
    id: "orc-snapshot",
    name: "ORC · Snapshot before compaction",
    category: "Automation",
    description:
      "Save session events and project tasks through ORC's existing bounded snapshot service.",
    configuration: "Uses the agent's native session identity and this policy's project scope.",
    rule: {
      ...base,
      id: "orc-snapshot",
      reason: "Preserve continuity before compaction",
      scope: { agents: "all", events: ["pre_compact"] },
      filter: { match: "all", conditions: [] },
      target: { type: "orc_action", action: "snapshot_session", timeout_ms: 1000 },
    },
  }),
  template({
    id: "orc-restore",
    name: "ORC · Restore session context",
    category: "Guidance",
    description: "Restore the native session's snapshot after compaction or on resume.",
    configuration: "Delivered through the connected agent's native context response.",
    rule: {
      ...base,
      id: "orc-restore",
      reason: "Restore saved session state",
      scope: { agents: "all", events: ["session_start"] },
      filter: {
        match: "all",
        conditions: [
          { predicate: { field: "payload.source", operator: "in", value: ["compact", "resume"] } },
        ],
      },
      target: { type: "orc_action", action: "restore_session", timeout_ms: 1000 },
    },
  }),
  template({
    id: "claude-share-memory",
    name: "Claude · Share auto-memory with ORC",
    category: "Automation",
    description:
      "Sync Claude memory topic files into project-scoped ORC memory after writes and at session end.",
    configuration:
      "Auto detects the usual local Claude directory and custom settings; choose an explicit directory if needed. MEMORY.md is an index and is skipped. Updates retain source identity and audit history; captures are agent-origin facts, not verified lessons.",
    rule: {
      ...base,
      id: "claude-share-memory",
      reason: "Share native Claude memory across agents",
      scope: { agents: ["claude"], events: ["post_tool", "session_end"] },
      filter: { match: "all", conditions: [] },
      target: {
        type: "orc_action",
        action: "sync_agent_memory",
        memory_directory: "auto",
        timeout_ms: 2000,
      },
    },
  }),
  template({
    id: "rtk-git",
    name: "Compact Git output with RTK",
    category: "Command routing",
    description: "Route Git status, diff and log through an installed RTK executable.",
    configuration:
      "RTK must be installed on the agent host and available on PATH. Review command filters before saving.",
    rule: {
      ...base,
      id: "rtk-git",
      reason: "Compact Git command output",
      scope: commandScope,
      filter: commandFilter("^git\\s+(status|diff|log)(\\s|$)"),
      target: rtkTarget,
    },
  }),
  template({
    id: "rtk-tests",
    name: "Compact test output with RTK",
    category: "Command routing",
    description: "Route Bun, npm, pnpm, Cargo, Go and pytest test commands through RTK.",
    configuration:
      "RTK must be available on the agent host. Unsupported commands explicitly pass through.",
    rule: {
      ...base,
      id: "rtk-tests",
      reason: "Compact test command output",
      scope: commandScope,
      filter: commandFilter("^(?:(?:bun|npm|pnpm|cargo|go)\\s+test|pytest)(\\s|$)"),
      target: rtkTarget,
    },
  }),
  template({
    id: "custom-command-router",
    name: "Use my own command processor",
    category: "Command routing",
    description:
      "Start with the generic CLI contract and choose your own executable and exit codes.",
    configuration:
      "Replace your-command-processor, narrow the filter, and configure the executable's exit-code contract.",
    rule: {
      ...base,
      id: "custom-command-router",
      reason: "Use my configured command processor",
      scope: commandScope,
      filter: commandFilter("^git\\s+status(\\s|$)"),
      target: {
        type: "rewrite_command",
        argv: ["your-command-processor", "{command}"],
        timeout_ms: 1000,
        rewrite_exit_codes: [0],
        passthrough_exit_codes: [],
      },
    },
  }),
  template({
    id: "block-command-pattern",
    name: "Block Bash command text matching rm -rf",
    category: "Protection",
    description:
      "Block Bash pre-tool calls whose command text matches the rm -rf regex shown below.",
    configuration:
      "A command-text regex, including quoted text. Matches rm -rf; does not cover rm -fr, split flags, Python deletion, PowerShell or other tools. Edit the tool and pattern.",
    rule: {
      ...base,
      id: "block-command-pattern",
      reason: "Command matches a blocked pattern",
      scope: { agents: "all", events: ["pre_tool"] },
      filter: {
        match: "all",
        conditions: [
          { predicate: { field: "tool", operator: "equals", value: "Bash" } },
          { predicate: { field: "input.command", operator: "regex", value: "\\brm\\s+-rf\\b" } },
        ],
      },
      target: { type: "block" },
    },
  }),
  template({
    id: "block-powershell-remove-item",
    name: "Block command text containing Remove-Item",
    category: "Protection",
    description:
      "Block pre-tool calls whose tool is Bash, PowerShell or shell_command and whose command text contains Remove-Item.",
    configuration:
      "A case-insensitive text check, including quoted text. Other tool names, aliases and other deletion methods are not covered. Edit the tool list and command pattern.",
    rule: {
      ...base,
      id: "block-powershell-remove-item",
      reason: "Command text matched Remove-Item",
      scope: { agents: "all", events: ["pre_tool"] },
      filter: {
        match: "all",
        conditions: [
          {
            predicate: {
              field: "tool",
              operator: "in",
              value: ["Bash", "PowerShell", "shell_command"],
            },
          },
          {
            predicate: {
              field: "input.command",
              operator: "regex",
              value: "\\bRemove-Item\\b",
              ignore_case: true,
            },
          },
        ],
      },
      target: { type: "block" },
    },
  }),
  template({
    id: "block-git-force-push",
    name: "Block direct git push commands with force flags",
    category: "Protection",
    description:
      "Block Bash command text starting with git push and containing --force, --force-with-lease or -f.",
    configuration:
      "Text matching only. Commands using git -C, aliases, wrappers or other spellings are not covered. Change the pattern to match your workflow.",
    rule: {
      ...base,
      id: "block-git-force-push",
      reason: "Direct git push command matched a force flag",
      scope: { agents: "all", events: ["pre_tool"] },
      filter: commandFilter("^git\\s+push\\b.*(?:--force(?:-with-lease)?\\b|\\s-f(?:\\s|$))"),
      target: { type: "block" },
    },
  }),
  template({
    id: "block-env-write",
    name: "Block Write/Edit calls targeting .env files",
    category: "Protection",
    description:
      "Block Write, Edit and MultiEdit calls when input.file_path ends in .env or .env.<name>.",
    configuration:
      "Checks the supplied file_path text. Reads, shell commands, other tools and paths supplied in other fields are unaffected. Edit the tool list and path pattern.",
    rule: {
      ...base,
      id: "block-env-write",
      reason: "Structured edit targets an .env filename",
      scope: { agents: "all", events: ["pre_tool"] },
      filter: {
        match: "all",
        conditions: [
          { predicate: { field: "tool", operator: "in", value: ["Write", "Edit", "MultiEdit"] } },
          {
            predicate: {
              field: "input.file_path",
              operator: "regex",
              value: "(?:^|[/\\\\])\\.env(?:\\.[^/\\\\]+)?$",
              ignore_case: true,
            },
          },
        ],
      },
      target: { type: "block" },
    },
  }),
  template({
    id: "block-write-comment-markers",
    name: "Block Write content containing // or /*",
    category: "Protection",
    description:
      "Block Write calls to JS/TS filenames when the supplied content contains // or /*.",
    configuration:
      "Text matching, not language parsing: URLs and strings containing these markers match too. Edit, shell commands and other tools are unaffected. Customize the tool, extensions or pattern.",
    rule: {
      ...base,
      id: "block-write-comment-markers",
      reason: "Write content matched a comment-marker text pattern",
      scope: { agents: "all", events: ["pre_tool"] },
      filter: {
        match: "all",
        conditions: [
          { predicate: { field: "tool", operator: "equals", value: "Write" } },
          {
            predicate: {
              field: "input.file_path",
              operator: "regex",
              value: "\\.[cm]?[jt]sx?$",
              ignore_case: true,
            },
          },
          { predicate: { field: "input.content", operator: "regex", value: "//|/\\*" } },
        ],
      },
      target: { type: "block" },
    },
  }),
  template({
    id: "comments-guidance",
    name: "Ask the agent to avoid adding comments",
    category: "Guidance",
    description:
      "Send a session-start instruction asking the agent to avoid new comments unless requested.",
    configuration:
      "Advisory context, not a blocking check. Edit the instruction and selected agents.",
    rule: {
      ...base,
      id: "comments-guidance",
      reason: "Session guidance about code comments",
      scope: { agents: "all", events: ["session_start"] },
      filter: { match: "all", conditions: [] },
      target: {
        type: "inject_context",
        content:
          "Avoid adding new code comments unless the user requests them. Explain your changes in your response instead.",
      },
    },
  }),
  template({
    id: "session-guidance",
    name: "Give guidance at session start",
    category: "Guidance",
    description: "Inject workspace instructions through the connected agent's session-start event.",
    configuration: "Customize the guidance and select the agents that should receive it.",
    rule: {
      ...base,
      id: "session-guidance",
      reason: "Workspace session guidance",
      scope: { agents: "all", events: ["session_start"] },
      filter: { match: "all", conditions: [] },
      target: {
        type: "inject_context",
        content:
          "Run the relevant checks before reporting work complete. Report any unresolved failures.",
      },
    },
  }),
  template({
    id: "sync-guard-script",
    name: "Run my own guard script",
    category: "Automation",
    description: "Evaluate a trusted synchronous script on matching pre-tool events.",
    configuration:
      "Replace the script path and narrow the filter. The script receives event JSON and returns a decision/context JSON object.",
    rule: {
      ...base,
      id: "sync-guard-script",
      reason: "Custom workspace guard",
      scope: commandScope,
      filter: commandFilter("^git\\s+status(\\s|$)"),
      target: {
        type: "script",
        mode: "sync",
        argv: ["bun", "C:/path/to/guard.ts"],
        timeout_ms: 1000,
      },
    },
  }),
];

export function copyRuleTemplate(id: string): EventRule {
  const selected = RULE_CATALOG.find((entry) => entry.id === id);
  if (!selected) throw new Error("Unknown rule template");
  return EventRuleSchema.parse(structuredClone(selected.rule));
}
