import { loadConfig } from "./config.js";
import { type HumanRequest, HumanRequestSchema } from "./human-requests.js";
import { nativeHookQuestions } from "./rule-hooks.js";
import type { RuleDecision, RuleEvent } from "./rule-types.js";

class RetryableHumanRequestError extends Error {}

async function request(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  owner?: string,
): Promise<HumanRequest> {
  const config = loadConfig();
  const base = (process.env.ORC_API_BASE ?? `http://${config.api.host}:${config.api.port}`)
    .replace(/\/$/, "")
    .replace(/\/api$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.api.secret ? { Authorization: `Bearer ${config.api.secret}` } : {}),
        ...(owner ? { "X-ORC-Human-Owner": owner } : {}),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RetryableHumanRequestError("Human request connection interrupted");
  }
  if (response.status >= 500)
    throw new RetryableHumanRequestError("Human request service temporarily unavailable");
  if (!response.ok) throw new Error(`Human request unavailable (HTTP ${response.status})`);
  return HumanRequestSchema.parse(await response.json());
}

export async function waitForHumanRequest(
  initial: HumanRequest,
  signal?: AbortSignal,
  owner?: string,
): Promise<HumanRequest> {
  let current = initial;
  while (current.status === "pending") {
    signal?.throwIfAborted();
    if (Date.now() >= current.expires_at) throw new Error("Human request expired");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 500);
      function abort(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new Error("Human wait cancelled"));
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      current = await request(
        `/human-requests/${encodeURIComponent(current.id)}`,
        undefined,
        signal,
        owner,
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof RetryableHumanRequestError)) throw error;
    }
  }
  if (current.status !== "answered" || !current.response)
    throw new Error(`Human request ${current.status}; no answer delivered`);
  return current;
}

export async function runHumanRuleActions(
  event: RuleEvent,
  decision: RuleDecision,
  signal?: AbortSignal,
): Promise<RuleDecision> {
  if (decision.decision === "deny" || !decision.human_requests?.length) return decision;
  const result: RuleDecision = {
    ...decision,
    reasons: [...decision.reasons],
    context: [...decision.context],
  };
  for (const action of decision.human_requests) {
    try {
      const owner = crypto.randomUUID();
      const questions = action.target.kind === "question" ? nativeHookQuestions(event) : [];
      if (questions.length) {
        const answers: Record<string, string> = {};
        for (const [question_index, question] of questions.entries()) {
          const initial = await request(
            "/rules/human-request",
            {
              event,
              rule_id: action.rule_id,
              revision_id: action.revision_id,
              question_index,
              proposed_input: decision.updated_input ?? event.input,
            },
            signal,
            owner,
          );
          const answered = await waitForHumanRequest(initial, signal, owner);
          if (answered.response?.kind !== "question") throw new Error("Invalid question response");
          answers[question.question] =
            answered.response.selected_choices?.join(", ") ?? answered.response.answer;
          result.human_receipts ??= [];
          result.human_receipts.push({ id: answered.id, version: answered.version });
        }
        result.updated_input = { ...event.input, answers };
        result.human_approved = true;
        continue;
      }
      const initial = await request(
        "/rules/human-request",
        {
          event,
          rule_id: action.rule_id,
          revision_id: action.revision_id,
          proposed_input: decision.updated_input ?? event.input,
        },
        signal,
        owner,
      );
      const answered = await waitForHumanRequest(initial, signal, owner);
      result.human_receipts ??= [];
      result.human_receipts.push({ id: answered.id, version: answered.version });
      if (answered.response?.kind === "approval") {
        if (!answered.response.approved) {
          result.decision = "deny";
          result.reasons.push({ rule_id: action.rule_id, reason: "Human denied this action" });
          return result;
        }
        result.human_approved = true;
      } else if (answered.response?.kind === "question") {
        if (result.context.join("").length + answered.response.answer.length > 32000)
          throw new Error("Answer exceeds context budget");
        result.context.push(`Human answer: ${answered.response.answer}`);
      }
    } catch {
      result.decision = "deny";
      result.reasons.push({
        rule_id: action.rule_id,
        reason: "Human answer unavailable, expired or cancelled; action was not authorized",
      });
      return result;
    }
  }
  return result;
}
