import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";

export const PI_NATIVE_PHASES = {
  tool_call: "pre_tool",
  tool_result: "post_tool",
  input: "prompt_submit",
  session_start: "session_start",
  session_shutdown: "session_end",
  session_before_compact: "pre_compact",
  session_compact: "post_compact",
  agent_end: "stop",
} as const;

export type PiNativeEvent = keyof typeof PI_NATIVE_PHASES;

export const BLOCKING_EVENTS: ReadonlySet<PiNativeEvent> = new Set(["tool_call", "input"]);

export type OrcRule = {
  id: string;
  reason: string;
  kind: "event";
  enabled: boolean;
  scope: { agents: "all" | string[]; events: string[] };
  filter: { match: "all" | "any"; conditions: unknown[] };
  target: { type: string; expires_in_seconds?: number; [key: string]: unknown };
};

export type OrcRulePolicy = {
  workspace: string;
  project_id: string | null;
  rules: OrcRule[];
};

export type OrcRuleRevision = {
  id: string;
  workspace: string;
  project_id: string | null;
  policy: OrcRulePolicy | null;
  current: boolean;
};

export type HookDecision = {
  block: boolean;
  reason?: string;
  context?: string;
  updatedInput?: Record<string, unknown>;
};

const DEFAULT_HOOK_MS = 30_000;
const HUMAN_GRACE_MS = 30_000;

function inside(target: string, root: string): boolean {
  const t = resolve(target).toLowerCase();
  const r = resolve(root)
    .toLowerCase()
    .replace(/[\\/]+$/, "");
  return t === r || t.startsWith(`${r}${sep}`) || t.startsWith(`${r}/`);
}

function nativeFor(event: string): PiNativeEvent | undefined {
  if (event.startsWith("native:")) {
    const name = event.slice("native:".length);
    return name in PI_NATIVE_PHASES ? (name as PiNativeEvent) : undefined;
  }
  return (Object.keys(PI_NATIVE_PHASES) as PiNativeEvent[]).find(
    (native) => PI_NATIVE_PHASES[native] === event,
  );
}

export function rulesForCwd(history: readonly OrcRuleRevision[], cwd: string): OrcRule[] {
  return history
    .filter((revision) => revision.current && revision.policy && inside(cwd, revision.workspace))
    .flatMap((revision) => revision.policy?.rules ?? [])
    .filter(
      (rule) => rule.enabled && (rule.scope.agents === "all" || rule.scope.agents.includes("pi")),
    );
}

export type RulePlan = {
  events: Set<PiNativeEvent>;
  timeoutMs: Map<PiNativeEvent, number>;
  count: number;
};

export function planRules(history: readonly OrcRuleRevision[], cwd: string): RulePlan {
  const rules = rulesForCwd(history, cwd);
  const events = new Set<PiNativeEvent>();
  const timeoutMs = new Map<PiNativeEvent, number>();
  for (const rule of rules) {
    for (const event of rule.scope.events) {
      const native = nativeFor(event);
      if (!native) continue;
      events.add(native);
      const wait =
        rule.target.type === "ask_user"
          ? (rule.target.expires_in_seconds ?? 86_400) * 1000 + HUMAN_GRACE_MS
          : DEFAULT_HOOK_MS;
      timeoutMs.set(native, Math.max(timeoutMs.get(native) ?? 0, wait));
    }
  }
  return { events, timeoutMs, count: rules.length };
}

export function parseHookOutput(stdout: string, exitCode: number | null): HookDecision {
  const text = stdout.trim();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try {
      parsed = JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
    } catch {
      return {
        block: exitCode !== 0,
        ...(exitCode !== 0 ? { reason: `ORC rule hook failed: ${text.slice(0, 500)}` } : {}),
      };
    }
  }
  const specific = (parsed.hookSpecificOutput ?? {}) as Record<string, unknown>;
  if (specific.permissionDecision === "deny")
    return {
      block: true,
      reason: String(specific.permissionDecisionReason ?? "Blocked by an ORC rule"),
    };
  if (parsed.decision === "block")
    return { block: true, reason: String(parsed.reason ?? "Blocked by an ORC rule") };
  if (exitCode !== 0 && exitCode !== null)
    return { block: true, reason: `ORC rule hook exited with code ${exitCode}` };
  const decision: HookDecision = { block: false };
  if (typeof specific.additionalContext === "string" && specific.additionalContext.trim())
    decision.context = specific.additionalContext;
  if (specific.updatedInput && typeof specific.updatedInput === "object")
    decision.updatedInput = specific.updatedInput as Record<string, unknown>;
  return decision;
}

export function upsertRule(
  current: OrcRulePolicy | null,
  rule: OrcRule,
  workspace: string,
  projectId: string | null,
): OrcRulePolicy {
  const rules = (current?.rules ?? []).filter((existing) => existing.id !== rule.id);
  return {
    workspace: current?.workspace ?? workspace,
    project_id: current?.project_id ?? projectId,
    rules: [...rules, rule],
  };
}

export function removeRule(current: OrcRulePolicy, id: string): OrcRulePolicy | undefined {
  const rules = current.rules.filter((rule) => rule.id !== id);
  return rules.length === current.rules.length ? undefined : { ...current, rules };
}

export type HookRun = {
  command: string;
  native: PiNativeEvent;
  payload: Record<string, unknown>;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
};

export function runRuleHook(run: HookRun): Promise<HookDecision> {
  const blocking = BLOCKING_EVENTS.has(run.native);
  return new Promise((done) => {
    const fail = (reason: string): void =>
      done(blocking ? { block: true, reason } : { block: false });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(run.command, ["rules", "hook", "pi", run.native], {
        cwd: run.cwd,
        env: { ...process.env, ...run.env },
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      fail(`ORC rule hook could not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (decision: HookDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", abort);
      done(decision);
    };
    const abort = (): void => {
      child.kill();
      finish(blocking ? { block: true, reason: "ORC rule check was cancelled" } : { block: false });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        blocking
          ? { block: true, reason: `ORC rule check timed out after ${run.timeoutMs}ms` }
          : { block: false },
      );
    }, run.timeoutMs);
    run.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      finish(
        blocking
          ? { block: true, reason: `ORC rule hook could not start: ${err.message}` }
          : { block: false },
      );
    });
    child.on("close", (code) => {
      const decision = parseHookOutput(stdout, code);
      if (decision.block && !stdout.trim() && stderr.trim())
        decision.reason = `ORC rule hook failed: ${stderr.trim().slice(0, 500)}`;
      finish(blocking || !decision.block ? decision : { block: false });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(run.payload));
  });
}
