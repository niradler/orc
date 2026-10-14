import { runRuleBuiltinActions } from "../packages/core/src/rule-builtin.js";
import {
  normalizeRuleHook,
  type RuleHookBackend,
  ruleHookOutput,
} from "../packages/core/src/rule-hooks.js";
import { getSqlite } from "../packages/db/src/client.js";
import { RuleStore } from "../packages/db/src/rules.js";

export async function dispatchRuleHook(nativeEvent: string): Promise<void> {
  try {
    const backend = process.argv[2] ?? "claude";
    if (backend !== "claude" && backend !== "codex")
      throw new Error("Use the native rules adapter for this backend");
    let raw = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of Bun.stdin.stream()) {
      bytes += chunk.byteLength;
      if (bytes > 1100000) throw new Error("Hook input exceeds limit");
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();
    const event = normalizeRuleHook(backend as RuleHookBackend, nativeEvent, JSON.parse(raw));
    const result = await runRuleBuiltinActions(
      event,
      new RuleStore(getSqlite()).evaluateCommand(event),
    );
    process.stdout.write(
      `${JSON.stringify(ruleHookOutput(backend as RuleHookBackend, event, result))}\n`,
    );
    for (const error of result.action_errors ?? [])
      process.stderr.write(`${error.rule_id}: ${error.reason}\n`);
    if (result.decision === "deny") process.exitCode = 2;
  } catch {
    process.stderr.write("ORC rule hook unavailable; check adapter configuration\n");
    process.exitCode = 2;
  }
}
