import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { RuleEvent, RuleScript } from "./rule-types.js";

const ScriptResultSchema = z
  .object({
    decision: z.enum(["abstain", "deny"]).default("abstain"),
    reason: z.string().min(1).max(1000).optional(),
    context: z.array(z.string().min(1).max(8000)).max(4).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "deny" && !value.reason)
      ctx.addIssue({ code: "custom", message: "Deny requires a reason" });
    if (value.context.join("").length > 16000)
      ctx.addIssue({ code: "custom", message: "Script context exceeds limit" });
  });

export function runRuleScript(
  target: RuleScript,
  event: RuleEvent,
): z.infer<typeof ScriptResultSchema> {
  const [command, ...args] = target.argv;
  if (!command) throw new Error("Script executable is required");
  const output = spawnSync(command, args, {
    cwd: event.cwd,
    input: JSON.stringify(event),
    encoding: "utf8",
    timeout: target.timeout_ms,
    killSignal: "SIGKILL",
    maxBuffer: 65536,
    windowsHide: true,
    env: { ...process.env, ORC_RULE_ACTION: "1" },
  });
  if (output.error || output.signal || output.status !== 0)
    throw new Error("Custom rule script failed, timed out, or exceeded output limit");
  return ScriptResultSchema.parse(JSON.parse(output.stdout.trim() || "{}"));
}
