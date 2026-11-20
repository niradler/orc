import type { Plugin } from "@opencode/plugin";
import { RULES_REFRESH_MS } from "@orc/rule-client/gate";
import { DEFAULT_HOOK_MS } from "@orc/rule-client/hook";
import {
  OPENCODE_BLOCKING_EVENTS,
  type OpenCodeNativeEvent,
  type OpenCodeRulePlan,
  planFromResponse,
  ruleHookGate,
  runRuleHook,
} from "@orc/rule-client/opencode";
import type { RulesPlanResponse } from "@orc/rule-client/types";

export type OrcPluginOptions = {
  /** ORC executable; defaults to ORC_COMMAND or `orc` on PATH. */
  command?: string;
  /** Set false to load the plugin without rule enforcement. */
  rules?: boolean;
  /** Blocking hook timeout in ms; ask-user rules extend it automatically. */
  timeoutMs?: number;
  /** ORC API origin for the rules plan; defaults to ORC_API_BASE or the local API. */
  apiBase?: string;
  /** Environment variable holding the ORC API secret, when not in orc config. */
  secretEnv?: string;
};

type ResolvedOptions = {
  command: string;
  rules: boolean;
  timeoutMs: number;
  apiBase?: string;
  secret?: string;
};

export function resolveOptions(raw: unknown): ResolvedOptions {
  const options = (raw ?? {}) as OrcPluginOptions;
  const env = process.env;
  const secret = (options.secretEnv ? env[options.secretEnv] : env.ORC_API_SECRET)?.trim();
  const apiBase = (options.apiBase ?? env.ORC_API_BASE)?.trim();
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isInteger(options.timeoutMs) &&
    options.timeoutMs >= 250 &&
    options.timeoutMs <= 604_815_000
      ? options.timeoutMs
      : DEFAULT_HOOK_MS;
  return {
    command: options.command?.trim() || env.ORC_COMMAND?.trim() || "orc",
    rules: typeof options.rules === "boolean" ? options.rules : options.rules !== "false",
    timeoutMs,
    ...(apiBase ? { apiBase } : {}),
    ...(secret ? { secret } : {}),
  };
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const value =
      (result as Record<string, unknown>).content ?? (result as Record<string, unknown>).output;
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * ORC rules for OpenCode. Supported native hooks forward to
 * `orc rules hook opencode`, which evaluates the local ORC database — the same
 * adapter Claude, Codex, Cursor, Gemini and Pi use. A rules plan fetched from
 * the ORC API (refreshed at least every 30s) selects exactly the events that
 * carry rules and their timeouts; without a plan, blocking events still run the
 * hook and fail closed, and only a confirmed global disable skips enforcement.
 * Rule context is queued per session and delivered on the next model request.
 */
const plugin: Plugin.Plugin = {
  id: "orc",
  async setup(ctx) {
    const options = resolveOptions(ctx.options);
    if (!options.rules) return;
    const cwd = ctx.location.directory;
    const pending = new Map<string, string[]>();
    const queue = (sessionID: string, context: string): void => {
      if (!pending.has(sessionID) && pending.size >= 128) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      const chunks = pending.get(sessionID) ?? [];
      chunks.push(context);
      if (chunks.length > 32) chunks.splice(0, chunks.length - 32);
      pending.set(sessionID, chunks);
    };

    const planBase = options.apiBase ?? "http://127.0.0.1:7700";
    let plan: OpenCodeRulePlan | undefined;
    let disabled = false;
    let checkedAt = 0;
    let inflight: Promise<void> | undefined;
    const refreshPlan = (): Promise<void> => {
      if (Date.now() - checkedAt < RULES_REFRESH_MS) return Promise.resolve();
      inflight ??= (async () => {
        try {
          const response = await fetch(`${planBase}/api/rules?cwd=${encodeURIComponent(cwd)}`, {
            headers: options.secret ? { Authorization: `Bearer ${options.secret}` } : {},
            signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw new Error(`rules plan fetch failed (${response.status})`);
          const data = (await response.json()) as RulesPlanResponse;
          const next = planFromResponse(data, cwd);
          plan = next.plan;
          disabled = next.disabled;
        } catch {
          // Offline or unauthenticated: no plan. Blocking events still run the
          // hook against the local DB; a confirmed disable is the only skip.
          plan = undefined;
          disabled = false;
        } finally {
          checkedAt = Date.now();
          inflight = undefined;
        }
      })();
      return inflight;
    };
    const gateFor = async (native: OpenCodeNativeEvent) => {
      await refreshPlan();
      return ruleHookGate({ enabled: true, plan, disabled, native });
    };
    const run = (
      native: OpenCodeNativeEvent,
      sessionID: string,
      payload: Record<string, unknown>,
      timeoutMs: number,
    ) =>
      runRuleHook({
        command: options.command,
        native,
        payload: { session_id: sessionID, cwd, ...payload },
        cwd,
        env: {
          ORC_SESSION_ID: sessionID,
          // Unset lets the hook CLI use its own orc config for the API origin.
          ...(options.apiBase ? { ORC_API_BASE: options.apiBase } : {}),
          ...(options.secret ? { ORC_API_SECRET: options.secret } : {}),
        },
        timeoutMs: OPENCODE_BLOCKING_EVENTS.has(native)
          ? Math.max(timeoutMs, options.timeoutMs)
          : timeoutMs,
      });
    await refreshPlan();

    await ctx.tool.hook("execute.before", async (event) => {
      const gate = await gateFor("execute.before");
      if (!gate.run) return;
      const decision = await run(
        "execute.before",
        event.sessionID,
        {
          tool_call_id: event.id,
          tool_name: event.tool,
          tool_input: event.input,
        },
        gate.timeoutMs,
      );
      if (decision.block) throw new Error(decision.reason ?? "Blocked by an ORC rule");
      if (decision.updatedInput)
        event.input =
          typeof event.input === "object" && event.input !== null
            ? Object.assign(event.input, decision.updatedInput)
            : decision.updatedInput;
      if (decision.context) queue(event.sessionID, decision.context);
    });

    await ctx.tool.hook("execute.after", async (event) => {
      // Observation must never defect the tool result path, even if the hook
      // transport or the host event shape is broken.
      try {
        const gate = await gateFor("execute.after");
        if (!gate.run) return;
        const decision = await run(
          "execute.after",
          event.sessionID,
          {
            tool_call_id: event.id,
            tool_name: event.tool,
            tool_input: event.input,
            tool_response:
              event.status === "error"
                ? { error: String(event.error?.message ?? "tool error").slice(0, 4000) }
                : { output: resultText(event.result).slice(0, 4000) },
          },
          gate.timeoutMs,
        );
        if (decision.context) queue(event.sessionID, decision.context);
      } catch {
        // fail open: post-tool observation never stalls or defects a session
      }
    });

    await ctx.session.hook("prompt", async (event) => {
      const gate = await gateFor("prompt");
      if (!gate.run) return;
      const decision = await run(
        "prompt",
        event.sessionID,
        { prompt: event.prompt.text },
        gate.timeoutMs,
      );
      if (decision.block) throw new Error(decision.reason ?? "Prompt blocked by an ORC rule");
      if (decision.context) queue(event.sessionID, decision.context);
    });

    await ctx.session.hook("compaction", async (event) => {
      try {
        const gate = await gateFor("compaction");
        if (!gate.run) return;
        const decision = await run("compaction", event.sessionID, {}, gate.timeoutMs);
        if (decision.context) queue(event.sessionID, decision.context);
      } catch {
        // fail open: compaction observation never stalls a session
      }
    });

    // The last delivery point before a session sleeps: queued ORC context
    // admitted here runs in the same execution instead of waiting for the next
    // prompt. Experimental in the host SDK — feature-detect the registration
    // and the synthetic API, degrading to next-prompt delivery when absent.
    try {
      await ctx.session.hook("experimental.idle", async (event) => {
        const chunks = pending.get(event.sessionID);
        if (!chunks?.length) return;
        if (typeof ctx.session.synthetic !== "function") return;
        pending.delete(event.sessionID);
        try {
          await ctx.session.synthetic({
            sessionID: event.sessionID,
            text: `ORC rules:\n${chunks.join("\n\n")}`,
            delivery: "queue",
            resume: true,
          });
        } catch {
          // Delivery failed: restore the context (ahead of anything queued
          // since) so the next prompt still receives it, in order.
          const existing = pending.get(event.sessionID) ?? [];
          pending.set(event.sessionID, [...chunks, ...existing].slice(-32));
        }
      });
    } catch {
      // Host without experimental.idle: the context hook still delivers on the
      // next model request.
    }

    await ctx.session.hook("context", (event) => {
      const chunks = pending.get(event.sessionID);
      if (!chunks?.length) return;
      pending.delete(event.sessionID);
      event.system.push({ type: "text", text: `ORC rules:\n${chunks.join("\n\n")}` });
    });
  },
};

export default plugin;
