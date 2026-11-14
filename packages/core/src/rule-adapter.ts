import { createHash, randomUUID } from "node:crypto";
import {
  RULE_EVENT_ADAPTERS,
  type RuleEventCapability,
  type RuleHookBackend,
  ruleEventCapability,
} from "./rule-events.js";
import { type RuleDecision, type RuleEvent, RuleEventSchema } from "./rules.js";

/**
 * One adapter per agent backend. The normalize/evaluate/output pipeline is
 * shared; an adapter only declares its native event catalog and, where the
 * host protocol differs, a native output renderer. Canonical phases drive
 * rules, while `native_event` and `native:` scopes keep host-specific events
 * addressable.
 */
export type RuleAdapter = {
  readonly backend: RuleHookBackend;
  readonly events: readonly RuleEventCapability[];
  capability(event: string): RuleEventCapability | undefined;
  normalize(nativeEvent: string, raw: unknown): RuleEvent;
  output(event: RuleEvent, result: RuleDecision): Record<string, unknown>;
};

type SharedRender = () => Record<string, unknown>;

type AdapterSpec = {
  /** The host does not provide stable tool-call identities (Gemini). */
  looseIdentity?: boolean;
  /** Native output protocol; defaults to the shared hookSpecificOutput shape. */
  render?: (
    event: RuleEvent,
    result: RuleDecision,
    shared: SharedRender,
  ) => Record<string, unknown>;
};

function reasonOf(result: RuleDecision): string {
  return result.reasons.map((r) => `${r.rule_id}: ${r.reason}`).join("; ");
}

function normalizeEvent(
  backend: RuleHookBackend,
  spec: AdapterSpec,
  nativeEvent: string,
  raw: unknown,
): RuleEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Hook input must be an object");
  const input = raw as Record<string, unknown>;
  const capability = RULE_EVENT_ADAPTERS[backend]?.find((entry) => entry.native === nativeEvent);
  const phase = capability?.event;
  if (!phase) throw new Error("Unsupported rule hook event");
  const session =
    input.session_id ??
    input.conversation_id ??
    (phase === "workspace_open" ? "workspace" : undefined);
  const id = input.tool_use_id ?? input.tool_call_id ?? input.event_id;
  if (
    ["pre_tool", "post_tool", "post_tool_failure"].includes(phase) &&
    typeof id !== "string" &&
    !spec.looseIdentity
  )
    throw new Error("Tool hook requires a stable tool-call identity");
  const cwd =
    input.cwd ?? (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined);
  return RuleEventSchema.parse({
    id:
      typeof id === "string"
        ? id
        : createHash("sha256")
            .update(
              JSON.stringify([
                session,
                nativeEvent,
                input.generation_id ?? input.turn_id ?? randomUUID(),
                input,
              ]),
            )
            .digest("hex"),
    session_id: session,
    backend,
    cwd,
    phase,
    native_event: nativeEvent,
    payload: input,
    tool: input.tool_name,
    input: input.tool_input ?? input,
    failed:
      nativeEvent.endsWith("Failure") ||
      nativeEvent.endsWith("Failure".toLowerCase()) ||
      (typeof input.tool_response === "object" &&
        input.tool_response !== null &&
        "error" in input.tool_response &&
        Boolean(input.tool_response.error)),
  });
}

function renderOutput(
  backend: RuleHookBackend,
  spec: AdapterSpec,
  event: RuleEvent,
  result: RuleDecision,
): Record<string, unknown> {
  const reason = reasonOf(result);
  const capability = ruleEventCapability(
    backend,
    event.native_event ? `native:${event.native_event}` : event.phase,
  );
  const denied = result.decision === "deny";
  const context = result.context.join("\n");
  const updatedInput = denied ? undefined : result.updated_input;
  if (updatedInput && !capability?.rewrite_command)
    throw new Error("Agent event cannot replace command input");
  if (denied && !capability?.block)
    throw new Error("Rule denied an event without blocking support");
  if (context && !capability?.context)
    throw new Error("Rule context cannot be delivered on this event");
  if (!denied && !context && !updatedInput && !result.human_approved) return {};
  const shared: SharedRender = () => {
    if (denied && event.phase !== "pre_tool") return { decision: "block", reason };
    return {
      hookSpecificOutput: {
        hookEventName: capability?.native,
        ...(denied ? { permissionDecision: "deny", permissionDecisionReason: reason } : {}),
        ...(!denied && result.human_approved ? { permissionDecision: "allow" } : {}),
        ...(context ? { additionalContext: context } : {}),
        ...(updatedInput ? { updatedInput } : {}),
      },
    };
  };
  return spec.render ? spec.render(event, result, shared) : shared();
}

const ADAPTER_SPECS: Record<RuleHookBackend, AdapterSpec> = {
  claude: {
    render: (event, result, shared) =>
      event.native_event === "PermissionRequest"
        ? {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision:
                result.decision === "deny"
                  ? { behavior: "deny", message: reasonOf(result) }
                  : { behavior: "allow" },
            },
          }
        : shared(),
  },
  cursor: {
    render: (event, result) => {
      const reason = reasonOf(result);
      if (result.decision === "deny")
        return event.phase === "prompt_submit"
          ? { continue: false }
          : { permission: "deny", user_message: reason, agent_message: reason };
      if (result.human_approved) return { permission: "allow" };
      return { additional_context: result.context.join("\n") };
    },
  },
  gemini: {
    looseIdentity: true,
    render: (event, result) => {
      const capability = ruleEventCapability(
        "gemini",
        event.native_event ? `native:${event.native_event}` : event.phase,
      );
      const context = result.context.join("\n");
      return {
        ...(result.decision === "deny" ? { decision: "deny", reason: reasonOf(result) } : {}),
        ...(context
          ? {
              hookSpecificOutput: {
                hookEventName: capability?.native,
                additionalContext: context,
              },
            }
          : {}),
      };
    },
  },
  codex: {},
  pi: {},
  opencode: {},
};

export function createRuleAdapter(backend: RuleHookBackend): RuleAdapter {
  if (!Object.hasOwn(RULE_EVENT_ADAPTERS, backend) || !Object.hasOwn(ADAPTER_SPECS, backend))
    throw new Error(`Unsupported rule hook backend: ${backend}`);
  const events = RULE_EVENT_ADAPTERS[backend];
  const spec = ADAPTER_SPECS[backend];
  return {
    backend,
    events,
    capability: (event) => ruleEventCapability(backend, event),
    normalize: (nativeEvent, raw) => normalizeEvent(backend, spec, nativeEvent, raw),
    output: (event, result) => renderOutput(backend, spec, event, result),
  };
}
