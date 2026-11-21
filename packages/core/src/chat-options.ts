import { z } from "zod";

export const ChatPermissionModeSchema = z.enum([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "bypassPermissions",
]);

export type ChatPermissionMode = z.infer<typeof ChatPermissionModeSchema>;

export function unsupportedPermissionMode(mode: string): string {
  return `This agent does not support the "${mode}" permission mode.`;
}

export const CODEX_PERMISSION_PRESETS = {
  default: { approvalPolicy: "on-request", sandbox: "read-only", approvalsReviewer: "user" },
  plan: { approvalPolicy: "never", sandbox: "read-only", approvalsReviewer: "user" },
  acceptEdits: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "user",
  },
  auto: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
  },
  bypassPermissions: {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    approvalsReviewer: "user",
  },
} as const satisfies Record<
  ChatPermissionMode,
  { approvalPolicy: string; sandbox: string; approvalsReviewer: string }
>;

export const TERMINAL_LAUNCH_SUPPORT: Record<
  string,
  { effort: boolean; modes: readonly ChatPermissionMode[] }
> = {
  claude: { effort: true, modes: ["default", "plan", "acceptEdits", "auto", "bypassPermissions"] },
  codex: { effort: true, modes: ["default", "acceptEdits", "auto", "bypassPermissions"] },
  opencode: { effort: false, modes: ["default", "plan"] },
  cursor: { effort: false, modes: ["default", "plan", "bypassPermissions"] },
};

export type TerminalLaunchOptions = {
  model?: string | undefined;
  effort?: string | undefined;
  permissionMode?: ChatPermissionMode | undefined;
};

export function terminalLaunchArgs(agent: string, options: TerminalLaunchOptions): string[] {
  const { model, effort, permissionMode: mode } = options;
  if (!model && !effort && !mode) return [];
  const support = TERMINAL_LAUNCH_SUPPORT[agent];
  if (!support) throw new Error(`${agent} terminals take no model, effort or mode`);
  if (effort && !support.effort) throw new Error(`${agent} terminals have no effort flag`);
  if (mode && !support.modes.includes(mode)) throw new Error(unsupportedPermissionMode(mode));
  if (effort && !/^[a-z]{1,16}$/.test(effort)) throw new Error("Invalid effort");
  const args = model ? ["--model", model] : [];
  if (agent === "claude") {
    if (effort) args.push("--effort", effort);
    if (mode && mode !== "default") args.push("--permission-mode", mode);
  } else if (agent === "codex") {
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    if (mode) {
      const preset = CODEX_PERMISSION_PRESETS[mode];
      args.push("--sandbox", preset.sandbox, "--ask-for-approval", preset.approvalPolicy);
      if (mode === "auto") args.push("-c", `approvals_reviewer="${preset.approvalsReviewer}"`);
    }
  } else if (agent === "opencode") {
    if (mode === "plan") args.push("--agent", "plan");
  } else if (agent === "cursor") {
    if (mode === "plan") args.push("--mode", "plan");
    if (mode === "bypassPermissions") args.push("--force");
  }
  return args;
}
const argument = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !Array.from(value).some((char) => [0, 10, 13].includes(char.charCodeAt(0))),
    "Arguments cannot contain control characters",
  );
const args = z
  .array(argument)
  .max(64)
  .refine((value) => JSON.stringify(value).length <= 20000, "Arguments are too long");
const acpxFlags = new Map<string, string[] | "number" | "value" | null>([
  ["--approve-all", null],
  ["--approve-reads", null],
  ["--deny-all", null],
  ["--json-strict", null],
  ["--verbose", null],
  ["--no-fs", null],
  ["--no-terminal", null],
  ["--suppress-reads", null],
  ["--auth-policy", ["skip", "fail"]],
  ["--non-interactive-permissions", ["deny", "fail"]],
  ["--timeout", "number"],
  ["--ttl", "number"],
  ["--permission-policy", "value"],
  ["--policy", "value"],
  ["--mcp-config", "value"],
]);

function validateArgs(values: string[], runtime: "acpx" | "codex", context: z.RefinementCtx): void {
  let permissionFlags = 0;
  for (let index = 0; index < values.length; index++) {
    const token = values[index] ?? "";
    const equals = token.indexOf("=");
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    const rule =
      runtime === "acpx"
        ? acpxFlags.get(flag)
        : ["-c", "--config", "--enable", "--disable"].includes(flag)
          ? "value"
          : undefined;
    if (rule === undefined) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: `Unsupported ${runtime} argument ${flag}. ORC owns transport, agent, session, model and working folder.`,
      });
      return;
    }
    if (["--approve-all", "--approve-reads", "--deny-all"].includes(flag)) permissionFlags++;
    if (rule === null) {
      if (equals >= 0)
        context.addIssue({
          code: "custom",
          path: [index],
          message: `${flag} does not take a value`,
        });
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : values[++index];
    if (!value || value.startsWith("-")) {
      context.addIssue({ code: "custom", path: [index], message: `${flag} requires a value` });
      return;
    }
    if (Array.isArray(rule) && !rule.includes(value))
      context.addIssue({
        code: "custom",
        path: [index],
        message: `${flag} must be ${rule.join(" or ")}`,
      });
    if (
      rule === "number" &&
      (!Number.isFinite(Number(value)) || Number(value) < (flag === "--ttl" ? 0 : Number.MIN_VALUE))
    )
      context.addIssue({
        code: "custom",
        path: [index],
        message: `${flag} requires ${flag === "--ttl" ? "a nonnegative" : "a positive"} number`,
      });
    if (runtime === "codex" && ["-c", "--config"].includes(flag)) {
      const key = value.split("=")[0]?.trim() ?? "";
      if (key === "features.default_mode_request_user_input")
        context.addIssue({
          code: "custom",
          path: [index],
          message: "ORC manages the native question-response feature",
        });
      if (
        !/^(model_reasoning_effort|model_reasoning_summary|model_verbosity|model_context_window|model_auto_compact_token_limit|web_search|features\.[a-z0-9_]+)$/.test(
          key,
        ) ||
        !value.includes("=")
      )
        context.addIssue({
          code: "custom",
          path: [index],
          message:
            "Use Codex reasoning, verbosity, context, web_search or feature overrides. Use Permissions for sandbox and approvals; ORC manages connection and session settings.",
        });
    }
    if (
      runtime === "codex" &&
      ["--enable", "--disable"].includes(flag) &&
      !/^[a-z][a-z0-9_]*$/.test(value)
    )
      context.addIssue({ code: "custom", path: [index], message: "Enter a Codex feature name" });
    if (
      runtime === "codex" &&
      ["--enable", "--disable"].includes(flag) &&
      value === "default_mode_request_user_input"
    )
      context.addIssue({
        code: "custom",
        path: [index],
        message: "ORC manages the native question-response feature",
      });
  }
  if (permissionFlags > 1)
    context.addIssue({ code: "custom", message: "Choose only one ACPX permission flag" });
}

export const ClaudeChatOptionsSchema = z
  .object({
    permissionMode: ChatPermissionModeSchema.optional(),
    maxTurns: z.number().int().positive().max(10000).optional(),
    maxBudgetUsd: z.number().positive().max(1000000).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    thinking: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("adaptive") }).strict(),
        z.object({ type: z.literal("disabled") }).strict(),
        z
          .object({
            type: z.literal("enabled"),
            budgetTokens: z.number().int().positive().max(1000000),
          })
          .strict(),
      ])
      .optional(),
    fallbackModel: argument.regex(/^[a-z0-9][a-z0-9._:/@+,-]*$/i).optional(),
    extraArgs: z
      .record(z.string(), argument.nullable())
      .refine(
        (value) =>
          Object.entries(value).every(([key, option]) => {
            if (["verbose", "disable-slash-commands"].includes(key)) return option === null;
            if (key === "debug") return option === null || !option.startsWith("-");
            if (key === "debug-file") return typeof option === "string" && !option.startsWith("-");
            return false;
          }),
        "Supported SDK extraArgs: verbose / disable-slash-commands (null), debug (filter or null), debug-file (path)",
      )
      .optional(),
  })
  .strict();
export type ClaudeChatOptions = z.infer<typeof ClaudeChatOptionsSchema>;

/** OpenCode effort levels are model-dependent, so the value is validated by the
 *  live ACP config option rather than a fixed enum here. */
export const OpenCodeChatOptionsSchema = z
  .object({
    effort: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,31}$/i)
      .optional(),
  })
  .strict();
export type OpenCodeChatOptions = z.infer<typeof OpenCodeChatOptionsSchema>;

export const ChatAgentOptionsSchema = z.discriminatedUnion("runtime", [
  z.object({ runtime: z.literal("opencode"), options: OpenCodeChatOptionsSchema }).strict(),
  z
    .object({
      runtime: z.literal("pi"),
      options: z
        .object({
          thinkingLevel: z
            .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
            .optional(),
          steeringMode: z.enum(["all", "one-at-a-time"]).optional(),
          followUpMode: z.enum(["all", "one-at-a-time"]).optional(),
          autoCompaction: z.boolean().optional(),
          autoRetry: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ runtime: z.literal("claude-sdk"), options: ClaudeChatOptionsSchema }).strict(),
  z
    .object({
      runtime: z.literal("codex"),
      args: args.superRefine((values, context) => validateArgs(values, "codex", context)),
    })
    .strict(),
  z
    .object({
      runtime: z.literal("acpx"),
      args: args.superRefine((values, context) => validateArgs(values, "acpx", context)),
    })
    .strict(),
]);
export type ChatAgentOptions = z.infer<typeof ChatAgentOptionsSchema>;
export function chatRuntime(agent: string): ChatAgentOptions["runtime"] {
  if (agent === "claude") return "claude-sdk";
  if (agent === "codex") return "codex";
  if (agent === "pi") return "pi";
  if (agent === "opencode") return "opencode";
  return "acpx";
}

/** Effort values a runtime accepts, in increasing order. `null` means the agent
 *  reports its own live values, and an empty list means it takes no effort. */
export function agentEffortValues(agent: string): readonly string[] | null {
  const runtime = chatRuntime(agent);
  if (runtime === "claude-sdk") return ["low", "medium", "high", "xhigh", "max"];
  if (runtime === "pi") return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (runtime === "codex") return ["minimal", "low", "medium", "high", "xhigh"];
  if (runtime === "opencode") return null;
  return [];
}

/** Drops every Codex `-c` entry for the key so a new value can replace it cleanly. */
function withoutSetting(args: readonly string[], key: string): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index] ?? "";
    const equals = token.indexOf("=");
    const flag = equals >= 0 ? token.slice(0, equals) : token;
    if (flag !== "-c" && flag !== "--config") {
      kept.push(token);
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : args[index + 1];
    const split = value?.indexOf("=") ?? -1;
    if (value !== undefined && split > 0 && value.slice(0, split).trim() === key) {
      if (equals < 0) index++;
      continue;
    }
    kept.push(token);
    if (equals < 0 && index + 1 < args.length) kept.push(args[++index] ?? "");
  }
  return kept;
}

/** Applies a reasoning effort to an agent's launch options, keeping every other
 *  option. Returns undefined for runtimes that take no effort. `""` clears it. */
export function withChatEffort(
  agent: string,
  saved: ChatAgentOptions | undefined,
  effort: string,
): ChatAgentOptions | undefined {
  const runtime = chatRuntime(agent);
  if (runtime === "claude-sdk") {
    const next = saved?.runtime === "claude-sdk" ? { ...saved.options } : {};
    if (effort) next.effort = effort as NonNullable<typeof next.effort>;
    else delete next.effort;
    return { runtime, options: next };
  }
  if (runtime === "pi") {
    const next = saved?.runtime === "pi" ? { ...saved.options } : {};
    if (effort) next.thinkingLevel = effort as NonNullable<typeof next.thinkingLevel>;
    else delete next.thinkingLevel;
    return { runtime, options: next };
  }
  if (runtime === "codex") {
    const args = withoutSetting(
      saved?.runtime === "codex" ? saved.args : [],
      "model_reasoning_effort",
    );
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    return { runtime, args };
  }
  if (runtime === "opencode") {
    const next = saved?.runtime === "opencode" ? { ...saved.options } : {};
    if (effort) next.effort = effort;
    else delete next.effort;
    return { runtime, options: next };
  }
  return undefined;
}
export const ChatAgentOptionsMapSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i), ChatAgentOptionsSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 20)
      context.addIssue({ code: "custom", message: "Too many agent configurations" });
    for (const [agent, options] of Object.entries(value)) {
      const expected = chatRuntime(agent);
      // OpenCode moved from ACPX to direct ACP; saved ACPX arguments stay
      // parseable so the composer can offer to clear them.
      const legacyAcp = expected === "opencode" && options.runtime === "acpx";
      if (options.runtime !== expected && !legacyAcp)
        context.addIssue({
          code: "custom",
          path: [agent],
          message: `Options must target ${expected} for ${agent}`,
        });
    }
  });
export function acpxPermissionArgs(values: string[]): boolean {
  return values.some((value) => ["--approve-all", "--approve-reads", "--deny-all"].includes(value));
}
