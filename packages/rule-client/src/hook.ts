import { spawn } from "node:child_process";
import type { HookDecision, HookRun } from "./types.js";

export const DEFAULT_HOOK_MS = 30_000;
export const HUMAN_GRACE_MS = 30_000;

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

/**
 * Run `orc rules hook <backend> <native>` against the local ORC database.
 * Blocking events fail closed on spawn failure, timeout, abort or a nonzero
 * exit; non-blocking events fail open so observation cannot stall the agent.
 */
export function runRuleHook(
  backend: string,
  blocking: boolean,
  run: HookRun,
): Promise<HookDecision> {
  return new Promise((done) => {
    const fail = (reason: string): void =>
      done(blocking ? { block: true, reason } : { block: false });
    let body: string;
    try {
      body = JSON.stringify(run.payload);
    } catch (err) {
      fail(
        `ORC rule hook payload could not be serialized: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      // `command` is a user-configured executable line, like a native hook
      // command; the appended args are fixed tokens without shell characters.
      child = spawn(run.command, ["rules", "hook", backend, run.native], {
        cwd: run.cwd,
        env: { ...process.env, ...run.env },
        shell: true,
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
    child.stdin?.end(body);
  });
}
