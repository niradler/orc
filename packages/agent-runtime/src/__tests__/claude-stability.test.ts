import { expect, test } from "bun:test";
import { resolve } from "node:path";

const runScript = (script: string) => {
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: resolve(import.meta.dir, "../.."),
    timeout: 15_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
};

test("Claude emits observed runtime model from assistant messages and ignores <synthetic>", () => {
  const script = `
import { mock } from "bun:test";
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: () => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", session_id: "m-1", model: "claude-opus-4-6" };
      yield { type: "assistant", error: "rate_limit", message: { model: "<synthetic>", content: [{ type: "text", text: "ignored" }] } };
      yield { type: "assistant", message: { model: "qwen4-max", content: [{ type: "text", text: "Hello from Qwen" }] } };
      yield { type: "result", subtype: "success", session_id: "m-1", is_error: false, usage: { output_tokens: 10 }, duration_ms: 42 };
    })();
    return { [Symbol.asyncIterator]: () => stream, close: () => {}, return: async () => stream.return() };
  },
}));
const { loadConfig } = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({ rules: { ...config.rules, enabled: false }, preferences: {} });
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const { createBackend } = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({ cwd: process.cwd(), orcMcp: false, executionHost: null });
try {
  await session.send("hi");
  const events = [];
  for await (const event of session.events()) events.push(event);
  console.log("OUT:" + JSON.stringify(events));
} finally { await session.close(); }
`;
  const res = runScript(script);
  expect(res.exitCode).toBe(0);
  const line = res.stdout.split("\n").find((l) => l.startsWith("OUT:"));
  const events = JSON.parse((line ?? "OUT:[]").slice(4)) as {
    type: string;
    data: unknown;
  }[];
  const models = events.filter((e) => e.type === "model").map((e) => e.data);
  expect(models).toEqual(["claude-opus-4-6", "qwen4-max"]);
  const result = events.find((e) => e.type === "result")?.data as { model?: string };
  expect(result?.model).toBe("qwen4-max");
});

test("Claude holds turn completion while local_bash background task is in flight and emits background_task updates", () => {
  const script = `
import { mock } from "bun:test";
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: () => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", session_id: "bg-1", model: "claude-sonnet-4-6" };
      yield {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "tu-bash", name: "Bash", input: { command: "bun run ci:pr", description: "Run PR validation gate", run_in_background: true } },
          ],
        },
      };
      yield { type: "system", subtype: "task_started", task_id: "bash-99", tool_use_id: "tu-bash", description: "Run PR validation gate", task_type: "local_bash" };
      yield { type: "result", subtype: "success", session_id: "bg-1", is_error: false, usage: { output_tokens: 5 }, duration_ms: 100 };
      yield { type: "system", subtype: "task_notification", task_id: "bash-99", status: "completed", output_file: "/tmp/out.log", summary: "All checks passed" };
      yield { type: "assistant", message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "PR gate passed." }] } };
      yield { type: "result", subtype: "success", session_id: "bg-1", is_error: false, usage: { output_tokens: 8 }, duration_ms: 4500 };
    })();
    return { [Symbol.asyncIterator]: () => stream, close: () => {}, return: async () => stream.return() };
  },
}));
const { loadConfig } = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({ rules: { ...config.rules, enabled: false }, preferences: {} });
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const { createBackend } = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({ cwd: process.cwd(), orcMcp: false, executionHost: null });
try {
  await session.send("validate");
  const events = [];
  for await (const event of session.events()) events.push(event);
  console.log("OUT:" + JSON.stringify(events));
} finally { await session.close(); }
`;
  const res = runScript(script);
  expect(res.exitCode).toBe(0);
  const line = res.stdout.split("\n").find((l) => l.startsWith("OUT:"));
  const events = JSON.parse((line ?? "OUT:[]").slice(4)) as {
    type: string;
    data: Record<string, unknown>;
  }[];
  const bgEvents = events.filter((e) => e.type === "background_task");
  expect(bgEvents).toHaveLength(2);
  expect(bgEvents[0]?.data).toMatchObject({
    id: "bash-99",
    kind: "shell",
    description: "Run PR validation gate",
    command: "bun run ci:pr",
    status: "running",
  });
  expect(bgEvents[1]?.data).toMatchObject({
    id: "bash-99",
    status: "completed",
    summary: "All checks passed",
  });
  const results = events.filter((e) => e.type === "result");
  expect(results).toHaveLength(1);
  expect(results[0]?.data.durationMs).toBe(4500);
  const texts = events.filter((e) => e.type === "text").map((e) => e.data as unknown);
  expect(texts).toEqual(["PR gate passed."]);
});

test("resident ClaudeSDKSession reuses one live query across turns, vetoes canStopRuntime during background work, and reports unexpected exit", () => {
  const script = `
import { mock } from "bun:test";
let queryCount = 0;
let activeHandle = null;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: ({ prompt, options }) => {
    queryCount++;
    const out = [];
    let wake = null;
    let ended = false;
    const handle = {
      emit: (m) => { out.push(m); wake?.(); wake = null; },
      crash: (errText) => { options.stderr?.(errText); ended = true; wake?.(); wake = null; },
      finish: () => { ended = true; wake?.(); wake = null; },
    };
    activeHandle = handle;
    options.abortController?.signal.addEventListener("abort", () => handle.finish(), { once: true });
    const iter = prompt[Symbol.asyncIterator]();
    (async () => {
      let turnNo = 0;
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        turnNo++;
        if (turnNo === 1) {
          handle.emit({ type: "system", subtype: "init", session_id: "res-1", model: "qwen4-max" });
          handle.emit({ type: "assistant", message: { model: "qwen4-max", content: [{ type: "text", text: "turn1:" + next.value.message.content }] } });
          handle.emit({ type: "result", subtype: "success", session_id: "res-1", is_error: false, usage: { output_tokens: 4 }, duration_ms: 10 });
        } else {
          handle.emit({ type: "assistant", message: { model: "qwen4-max", content: [{ type: "text", text: "turn2:" + next.value.message.content }] } });
          handle.emit({ type: "result", subtype: "success", session_id: "res-1", is_error: false, usage: { output_tokens: 4 }, duration_ms: 12 });
        }
      }
      handle.finish();
    })().catch(() => {});
    const stream = (async function* () {
      while (true) {
        while (out.length > 0) yield out.shift();
        if (ended) return;
        await new Promise((r) => { wake = r; });
      }
    })();
    return {
      [Symbol.asyncIterator]: () => stream,
      return: async () => { handle.finish(); await stream.return(); return { value: undefined, done: true }; },
    };
  },
}));
const { loadConfig } = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({ rules: { ...config.rules, enabled: false }, preferences: {} });
await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
const { createBackend } = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({ cwd: process.cwd(), orcMcp: false, executionHost: null, resident: true });
const exits = [];
session.onUnexpectedExit?.((info) => exits.push(info));
try {
  await session.send("first");
  const e1 = [];
  for await (const ev of session.events()) e1.push(ev);
  const aliveAfterTurn1 = session.alive();
  const canStopIdle = session.canStopRuntime?.();

  await session.send("second");
  const e2 = [];
  for await (const ev of session.events()) e2.push(ev);

  // Start a background task while resident & idle, verify canStopRuntime veto, then crash.
  activeHandle.emit({ type: "system", subtype: "task_started", task_id: "bg-live", description: "long gate", task_type: "local_bash" });
  await Bun.sleep(20);
  const canStopDuringBg = session.canStopRuntime?.();
  activeHandle.crash("fatal: OOM killed");
  await Bun.sleep(30);

  console.log("OUT:" + JSON.stringify({
    queryCount,
    aliveAfterTurn1,
    canStopIdle,
    canStopDuringBg,
    t1: e1.filter((e) => e.type === "text").map((e) => e.data),
    t2: e2.filter((e) => e.type === "text").map((e) => e.data),
    exits,
  }));
} finally { await session.close(); }
`;
  const res = runScript(script);
  expect({ exitCode: res.exitCode, stderr: res.stderr }).toMatchObject({ exitCode: 0 });
  const line = res.stdout.split("\n").find((l) => l.startsWith("OUT:"));
  const out = JSON.parse((line ?? "OUT:{}").slice(4)) as {
    queryCount: number;
    aliveAfterTurn1: boolean;
    canStopIdle: boolean;
    canStopDuringBg: boolean;
    t1: string[];
    t2: string[];
    exits: { stderr: string; lostBackgroundWork: { kind: string; id: string; label: string }[] }[];
  };
  expect(out.queryCount).toBe(1);
  expect(out.aliveAfterTurn1).toBe(true);
  expect(out.canStopIdle).toBe(true);
  expect(out.canStopDuringBg).toBe(false);
  expect(out.t1).toEqual(["turn1:first"]);
  expect(out.t2).toEqual(["turn2:second"]);
  expect(out.exits).toHaveLength(1);
  expect(out.exits[0]?.stderr).toContain("fatal: OOM killed");
  expect(out.exits[0]?.lostBackgroundWork).toEqual([
    { kind: "shell", id: "bg-live", label: "long gate" },
  ]);
});

test("background completion grace settles without false steering warning even if rate_limit_event arrives", () => {
  const script = `
import { mock } from "bun:test";
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  HOOK_EVENTS: [],
  query: () => {
    const stream = (async function* () {
      yield { type: "system", subtype: "init", session_id: "bg-grace-1", model: "claude-sonnet-4-6" };
      yield { type: "system", subtype: "task_started", task_id: "bg-g1", description: "quick check", task_type: "local_bash" };
      yield { type: "result", subtype: "success", session_id: "bg-grace-1", is_error: false, usage: { output_tokens: 4 }, duration_ms: 10 };
      await Bun.sleep(20);
      yield { type: "system", subtype: "task_notification", task_id: "bg-g1", status: "completed", summary: "ok" };
      await Bun.sleep(15);
      yield { type: "rate_limit_event", rate_limit_info: { status: "allowed" } };
      await Bun.sleep(500);
    })();
    return { [Symbol.asyncIterator]: () => stream, close: () => {}, return: async () => stream.return() };
  },
}));
const { loadConfig } = await import(${JSON.stringify(new URL("../../../core/src/config.ts", import.meta.url).href)});
const config = loadConfig();
loadConfig({ rules: { ...config.rules, enabled: false }, preferences: {} });
const sdk = await import(${JSON.stringify(new URL("../claude-sdk.ts", import.meta.url).href)});
sdk.setClaudeSteerContinuationGraceMs(80);
const { createBackend } = await import(${JSON.stringify(new URL("../registry.ts", import.meta.url).href)});
const session = await createBackend("claude").startSession({ cwd: process.cwd(), orcMcp: false, executionHost: null, resident: true });
try {
  await session.send("run quick check");
  const events = [];
  for await (const event of session.events()) events.push(event);
  console.log("OUT:" + JSON.stringify(events));
} finally { await session.close(); }
`;
  const res = runScript(script);
  expect({ exitCode: res.exitCode, stderr: res.stderr }).toMatchObject({ exitCode: 0 });
  const line = res.stdout.split("\n").find((l) => l.startsWith("OUT:"));
  const events = JSON.parse((line ?? "OUT:[]").slice(4)) as { type: string; data: unknown }[];
  expect(events.some((e) => e.type === "result")).toBe(true);
  const statuses = events
    .filter((e) => e.type === "system_status")
    .map((e) => String(e.data ?? ""));
  expect(statuses.some((s) => s.includes("steering message was not answered"))).toBe(false);
});
