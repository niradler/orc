import type { Plugin } from "@opencode/plugin";
import { DEFAULT_HOOK_MS } from "@orc/rule-client/hook";
import { type OpenCodeNativeEvent, runRuleHook } from "@orc/rule-client/opencode";

export type OrcPluginOptions = {
  /** ORC executable; defaults to ORC_COMMAND or `orc` on PATH. */
  command?: string;
  /** Set false to load the plugin without rule enforcement. */
  rules?: boolean;
  /** Blocking hook timeout in ms; raise it above ask-user request lifetimes. */
  timeoutMs?: number;
  /** ORC API origin for rule actions; defaults to ORC_API_BASE / orc config. */
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

function resolveOptions(raw: unknown): ResolvedOptions {
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
    rules: options.rules !== false,
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
 * ORC rules for OpenCode. Every supported native hook forwards to
 * `orc rules hook opencode`, which evaluates the local ORC database — the same
 * adapter Claude, Codex, Cursor, Gemini and Pi use. Blocking hooks fail closed:
 * a denied rule, a hook crash or a timeout rejects the tool call or prompt.
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
      const chunks = pending.get(sessionID) ?? [];
      chunks.push(context);
      pending.set(sessionID, chunks);
    };
    const run = (
      native: OpenCodeNativeEvent,
      sessionID: string,
      payload: Record<string, unknown>,
    ) =>
      runRuleHook({
        command: options.command,
        native,
        payload: { session_id: sessionID, cwd, ...payload },
        cwd,
        env: {
          ORC_SESSION_ID: sessionID,
          ...(options.apiBase ? { ORC_API_BASE: options.apiBase } : {}),
          ...(options.secret ? { ORC_API_SECRET: options.secret } : {}),
        },
        timeoutMs: options.timeoutMs,
      });

    await ctx.tool.hook("execute.before", async (event) => {
      const decision = await run("execute.before", event.sessionID, {
        tool_call_id: event.id,
        tool_name: event.tool,
        tool_input: event.input,
      });
      if (decision.block) throw new Error(decision.reason ?? "Blocked by an ORC rule");
      if (decision.updatedInput)
        event.input =
          typeof event.input === "object" && event.input !== null
            ? Object.assign(event.input, decision.updatedInput)
            : decision.updatedInput;
      if (decision.context) queue(event.sessionID, decision.context);
    });

    await ctx.tool.hook("execute.after", async (event) => {
      const decision = await run("execute.after", event.sessionID, {
        tool_call_id: event.id,
        tool_name: event.tool,
        tool_input: event.input,
        tool_response:
          event.status === "error"
            ? { error: String(event.error.message ?? "tool error").slice(0, 4000) }
            : { output: resultText(event.result).slice(0, 4000) },
      });
      if (decision.context) queue(event.sessionID, decision.context);
    });

    await ctx.session.hook("prompt", async (event) => {
      const decision = await run("prompt", event.sessionID, { prompt: event.prompt.text });
      if (decision.block) throw new Error(decision.reason ?? "Prompt blocked by an ORC rule");
      if (decision.context) queue(event.sessionID, decision.context);
    });

    await ctx.session.hook("compaction", async (event) => {
      const decision = await run("compaction", event.sessionID, {});
      if (decision.context) queue(event.sessionID, decision.context);
    });

    await ctx.session.hook("context", (event) => {
      const chunks = pending.get(event.sessionID);
      if (!chunks?.length) return;
      pending.delete(event.sessionID);
      event.system.push({ type: "text", text: `ORC rules:\n${chunks.join("\n\n")}` });
    });
  },
};

export default plugin;
