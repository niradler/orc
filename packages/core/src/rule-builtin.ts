import { createHash } from "node:crypto";
import { loadConfig } from "./config.js";
import type { RuleDecision, RuleEvent } from "./rule-types.js";

export async function runRuleBuiltinActions(
  event: RuleEvent,
  decision: RuleDecision,
): Promise<RuleDecision> {
  if (
    decision.decision === "deny" ||
    !decision.orc_actions?.length ||
    process.env.ORC_RULE_ACTION === "1"
  )
    return decision;
  const result: RuleDecision = { ...decision, context: [...decision.context], action_errors: [] };
  if (decision.orc_actions.reduce((sum, action) => sum + action.target.timeout_ms, 0) > 5000) {
    result.action_errors?.push({
      rule_id: "orc-actions",
      reason: "Combined built-in action budget exceeds 5000ms",
    });
    return result;
  }
  const config = loadConfig();
  const base = (process.env.ORC_API_BASE ?? `http://${config.api.host}:${config.api.port}`)
    .replace(/\/$/, "")
    .replace(/\/api$/, "");
  for (const action of decision.orc_actions) {
    try {
      const response = await fetch(`${base}/api/rules/actions/run`, {
        method: "POST",
        signal: AbortSignal.timeout(action.target.timeout_ms),
        headers: {
          "Content-Type": "application/json",
          ...(config.api.secret ? { Authorization: `Bearer ${config.api.secret}` } : {}),
          "X-Request-Id": createHash("sha256")
            .update(`${event.session_id}:${event.id}:${action.rule_id}`)
            .digest("hex"),
        },
        body: JSON.stringify({ event, revision_id: action.revision_id, rule_id: action.rule_id }),
      });
      if (!response.ok) throw new Error("Action unavailable");
      if (!response.body) throw new Error("Missing action response");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 65536) {
            await reader.cancel();
            throw new Error("Action response limit");
          }
          raw += decoder.decode(chunk.value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
      const output = JSON.parse(raw) as { context?: unknown };
      if (
        !Array.isArray(output.context) ||
        output.context.some((value) => typeof value !== "string" || value.length > 16000)
      )
        throw new Error("Invalid action response");
      if (result.context.join("").length + output.context.join("").length > 32000)
        throw new Error("Action context limit");
      result.context.push(...output.context);
    } catch {
      result.action_errors?.push({
        rule_id: action.rule_id,
        reason:
          "Built-in ORC action unavailable; inspect action history and the configured API connection",
      });
    }
  }
  return result;
}
