export type RuleHookBackend = "claude" | "cursor" | "gemini" | "codex";
export type RuleEventCapability = {
  native: string;
  event: string;
  block: boolean;
  context: boolean;
};

function events(
  names: Record<string, string>,
  blocking: string[],
  context: string[],
): RuleEventCapability[] {
  return Object.entries(names).map(([native, event]) => ({
    native,
    event,
    block: blocking.includes(native),
    context: context.includes(native),
  }));
}

const claude = {
  PreToolUse: "pre_tool",
  PostToolUse: "post_tool",
  PostToolUseFailure: "post_tool_failure",
  PostToolBatch: "post_tool_batch",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "prompt_submit",
  UserPromptExpansion: "prompt_expansion",
  Stop: "stop",
  StopFailure: "stop_failure",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  PermissionRequest: "permission_request",
  PermissionDenied: "permission_denied",
  Notification: "notification",
  Setup: "setup",
  TeammateIdle: "teammate_idle",
  TaskCreated: "task_created",
  TaskCompleted: "task_completed",
  Elicitation: "elicitation",
  ElicitationResult: "elicitation_result",
  ConfigChange: "config_change",
  WorktreeRemove: "worktree_remove",
  InstructionsLoaded: "instructions_loaded",
  CwdChanged: "cwd_changed",
  FileChanged: "file_changed",
  DirectoryAdded: "directory_added",
  MessageDisplay: "message_display",
};

export const RULE_EVENT_ADAPTERS: Record<RuleHookBackend, RuleEventCapability[]> = {
  claude: events(
    claude,
    [
      "PreToolUse",
      "UserPromptSubmit",
      "UserPromptExpansion",
      "Stop",
      "SubagentStop",
      "TaskCreated",
      "ConfigChange",
    ],
    [
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "UserPromptSubmit",
      "SessionStart",
      "SubagentStart",
      "UserPromptExpansion",
      "PostToolBatch",
      "Stop",
      "SubagentStop",
    ],
  ),
  cursor: events(
    {
      sessionStart: "session_start",
      sessionEnd: "session_end",
      preToolUse: "pre_tool",
      postToolUse: "post_tool",
      postToolUseFailure: "post_tool_failure",
      subagentStart: "subagent_start",
      subagentStop: "subagent_stop",
      beforeShellExecution: "before_shell",
      afterShellExecution: "after_shell",
      beforeMCPExecution: "before_mcp",
      afterMCPExecution: "after_mcp",
      beforeReadFile: "before_read",
      afterFileEdit: "after_edit",
      beforeSubmitPrompt: "prompt_submit",
      preCompact: "pre_compact",
      stop: "stop",
      afterAgentResponse: "agent_response",
      afterAgentThought: "agent_thought",
      beforeTabFileRead: "before_tab_read",
      afterTabFileEdit: "after_tab_edit",
      workspaceOpen: "workspace_open",
    },
    [
      "preToolUse",
      "beforeShellExecution",
      "beforeMCPExecution",
      "beforeReadFile",
      "beforeTabFileRead",
      "beforeSubmitPrompt",
      "subagentStart",
    ],
    ["sessionStart"],
  ),
  gemini: events(
    {
      BeforeTool: "pre_tool",
      AfterTool: "post_tool",
      BeforeAgent: "prompt_submit",
      AfterAgent: "stop",
      BeforeModel: "before_model",
      AfterModel: "after_model",
      BeforeToolSelection: "before_tool_selection",
      SessionStart: "session_start",
      SessionEnd: "session_end",
      PreCompress: "pre_compact",
      Notification: "notification",
    },
    ["BeforeTool", "BeforeAgent", "AfterAgent", "BeforeModel"],
    ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "AfterAgent"],
  ),
  codex: events(
    {
      PreToolUse: "pre_tool",
      PermissionRequest: "permission_request",
      PostToolUse: "post_tool",
      PreCompact: "pre_compact",
      PostCompact: "post_compact",
      UserPromptSubmit: "prompt_submit",
      SubagentStart: "subagent_start",
      SubagentStop: "subagent_stop",
      SessionStart: "session_start",
      SessionEnd: "session_end",
      Stop: "stop",
      Interrupt: "interrupt",
    },
    ["PreToolUse"],
    ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "SubagentStart"],
  ),
};

export function ruleEventCapability(
  backend: string,
  event: string,
): RuleEventCapability | undefined {
  const capabilities = RULE_EVENT_ADAPTERS[backend as RuleHookBackend];
  return capabilities?.find((entry) => entry.event === event || `native:${entry.native}` === event);
}
