import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { RuleCommandProcessor, RuleDecision, RuleEvent } from "./rule-types.js";

export function runCommandProcessor(target: RuleCommandProcessor, event: RuleEvent): string | null {
  if (event.phase !== "pre_tool" || event.backend !== "claude" || event.tool !== "Bash")
    throw new Error("Command processing requires Claude PreToolUse Bash");
  const command = event.input.command;
  if (
    typeof command !== "string" ||
    !command.trim() ||
    command.length > 65536 ||
    command.includes("\0")
  )
    throw new Error("Command processing requires a bounded command string");
  const [executable, ...args] = target.argv;
  if (!executable) throw new Error("Processor executable is required");
  const output = spawnSync(
    executable,
    args.map((arg) => (arg === "{command}" ? command : arg)),
    {
      cwd: event.cwd,
      input: JSON.stringify(event),
      encoding: "utf8",
      timeout: target.timeout_ms,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
      windowsHide: true,
      env: { ...process.env, ORC_RULE_ACTION: "1" },
    },
  );
  if (output.error || output.signal || output.status === null)
    throw new Error("Command processor failed, timed out, or exceeded its output limit");
  const rewritten = output.stdout.trim();
  if (target.passthrough_exit_codes.includes(output.status)) {
    if (rewritten) throw new Error("Passthrough must not return a replacement command");
    return null;
  }
  if (!target.rewrite_exit_codes.includes(output.status) || !rewritten || rewritten.includes("\0"))
    throw new Error("Command processor returned an unsupported result");
  return rewritten;
}

export function processRuleCommand(
  event: RuleEvent,
  result: RuleDecision,
  validate: (event: RuleEvent) => RuleDecision,
): RuleDecision {
  if (result.decision === "deny" || !result.command_processors?.length) return result;
  const deny = (reason: string): RuleDecision => ({
    ...result,
    decision: "deny",
    reasons: [...result.reasons, { rule_id: "command-processor", reason }],
  });
  if (result.command_processors.length !== 1)
    return deny("Multiple command processors matched; narrow the rule scopes or filters");
  try {
    const processor = result.command_processors[0];
    if (!processor) return result;
    const command = runCommandProcessor(processor.target, event);
    if (command === null || command === event.input.command) return result;
    const input = { ...event.input, command };
    const validationEvent: RuleEvent = {
      ...event,
      id: createHash("sha256").update(`${event.id}:rewritten`).digest("hex"),
      input,
      ...(event.payload ? { payload: { ...event.payload, tool_input: input } } : {}),
    };
    const checked = validate(validationEvent);
    if (checked.decision === "deny")
      return { ...result, decision: "deny", reasons: [...result.reasons, ...checked.reasons] };
    if (result.context.join("").length + checked.context.join("").length > 32000)
      return deny("Combined command validation context exceeds limit");
    return { ...result, context: [...result.context, ...checked.context], updated_input: input };
  } catch {
    return deny("Command processor failed or replacement policy validation was unavailable");
  }
}
