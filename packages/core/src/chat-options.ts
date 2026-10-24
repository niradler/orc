import { z } from "zod";

export const ChatPermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions"]);
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

export const ChatAgentOptionsSchema = z.discriminatedUnion("runtime", [
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
  return "acpx";
}
export const ChatAgentOptionsMapSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i), ChatAgentOptionsSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 20)
      context.addIssue({ code: "custom", message: "Too many agent configurations" });
    for (const [agent, options] of Object.entries(value))
      if (options.runtime !== chatRuntime(agent))
        context.addIssue({
          code: "custom",
          path: [agent],
          message: `Options must target ${chatRuntime(agent)} for ${agent}`,
        });
  });
export function acpxPermissionArgs(values: string[]): boolean {
  return values.some((value) => ["--approve-all", "--approve-reads", "--deny-all"].includes(value));
}
