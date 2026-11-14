import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import plugin from "../src/plugin.js";

type ToolBefore = {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  input: unknown;
};
type ToolAfter = {
  tool: string;
  sessionID: string;
  agent: string;
  messageID: string;
  id: string;
  input: unknown;
} & ({ status: "completed"; result: unknown } | { status: "error"; error?: { message: string } });
type PromptEvent = { sessionID: string; messageID: string; prompt: { text: string } };
type ContextEvent = { sessionID: string; system: Array<{ type: string; text: string }> };
type CompactionEvent = { sessionID: string };
type Hook<E> = (event: E) => Promise<void> | void;

function fakeContext(options: Record<string, unknown>, directory: string) {
  const toolHooks: { before?: Hook<ToolBefore>; after?: Hook<ToolAfter> } = {};
  const sessionHooks: {
    prompt?: Hook<PromptEvent>;
    context?: Hook<ContextEvent>;
    compaction?: Hook<CompactionEvent>;
  } = {};
  const registration = { dispose: async () => undefined };
  const ctx = {
    options,
    location: { directory },
    tool: {
      hook: async (name: string, callback: Hook<ToolBefore> | Hook<ToolAfter>) => {
        if (name === "execute.before") toolHooks.before = callback as Hook<ToolBefore>;
        if (name === "execute.after") toolHooks.after = callback as Hook<ToolAfter>;
        return registration;
      },
    },
    session: {
      hook: async (
        name: string,
        callback: Hook<PromptEvent> | Hook<ContextEvent> | Hook<CompactionEvent>,
      ) => {
        if (name === "prompt") sessionHooks.prompt = callback as Hook<PromptEvent>;
        if (name === "context") sessionHooks.context = callback as Hook<ContextEvent>;
        if (name === "compaction") sessionHooks.compaction = callback as Hook<CompactionEvent>;
        return registration;
      },
    },
  };
  return { ctx: ctx as unknown as Plugin.Context, toolHooks, sessionHooks };
}

const directory = mkdtempSync(join(tmpdir(), "orc-opencode-plugin-"));
const log = join(directory, "calls.jsonl");
const stubSource = `import { appendFileSync } from "node:fs";
const payload = JSON.parse(await Bun.stdin.text());
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, payload, session: process.env.ORC_SESSION_ID }) + "\\n");
const native = args[3];
const command = String(payload.tool_input?.command ?? "");
const prompt = String(payload.prompt ?? "");
if (native === "prompt") {
  if (prompt.includes("blocked")) console.log(JSON.stringify({ decision: "block", reason: "prompt-guard: no" }));
  else if (prompt.includes("context")) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: native, additionalContext: "prompt guidance" } }));
  else console.log("{}");
} else if (command.includes("blocked") || prompt.includes("exit2")) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: native, permissionDecision: "deny", permissionDecisionReason: "guard: denied" } }));
} else if (command.includes("rewrite")) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: native, updatedInput: { command: "ls" } } }));
} else if (command.includes("context")) {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: native, additionalContext: "tool guidance" } }));
} else if (command.includes("exit2")) {
  process.exit(2);
} else {
  console.log("{}");
}
`;
let stubCommand: string;
if (process.platform === "win32") {
  const source = join(directory, "stub-orc.ts");
  writeFileSync(source, stubSource);
  stubCommand = join(directory, "stub-orc.cmd");
  writeFileSync(stubCommand, `@bun "${source}" %*\r\n`);
} else {
  stubCommand = join(directory, "stub-orc");
  writeFileSync(stubCommand, `#!/usr/bin/env bun\n${stubSource}`, { mode: 0o755 });
}

function rule(id: string, events: string[]) {
  return {
    id,
    reason: `probe ${id}`,
    kind: "event",
    enabled: true,
    scope: { agents: "all", events },
    filter: { match: "all", conditions: [] },
    target: { type: "block" },
  };
}
function revision(rules: unknown[]) {
  return {
    id: "rev1",
    workspace: directory,
    project_id: null,
    current: true,
    policy: { workspace: directory, project_id: null, rules },
  };
}
const defaultHistory = [
  revision([
    rule("pre", ["pre_tool"]),
    rule("post", ["post_tool"]),
    rule("prompt", ["prompt_submit"]),
  ]),
];
let rulesResponse: { enabled: boolean; history: unknown[] } = {
  enabled: true,
  history: defaultHistory,
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/rules") return Response.json(rulesResponse);
    return new Response("not found", { status: 404 });
  },
});
const apiUrl = `http://127.0.0.1:${server.port}`;
const deadUrl = "http://127.0.0.1:1";

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

afterAll(() => {
  Date.now = realNow;
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  offset = 0;
  rulesResponse = { enabled: true, history: defaultHistory };
  writeFileSync(log, "");
});

async function setup(options: Record<string, unknown> = {}) {
  const fake = fakeContext({ command: stubCommand, apiBase: apiUrl, ...options }, directory);
  await plugin.setup(fake.ctx);
  return fake;
}

function callCount(): number {
  const text = readFileSync(log, "utf8").trim();
  return text ? text.split("\n").length : 0;
}

function toolEvent(command: string): ToolBefore {
  return {
    tool: "bash",
    sessionID: "ses-1",
    agent: "build",
    messageID: "msg-1",
    id: "call-1",
    input: { command },
  };
}

describe("plugin registration", () => {
  test("registers the native rule hooks", async () => {
    const { toolHooks, sessionHooks } = await setup();
    expect(toolHooks.before).toBeFunction();
    expect(toolHooks.after).toBeFunction();
    expect(sessionHooks.prompt).toBeFunction();
    expect(sessionHooks.context).toBeFunction();
    expect(sessionHooks.compaction).toBeFunction();
  });

  test("rules=false loads without enforcement", async () => {
    const { toolHooks, sessionHooks } = await setup({ rules: false });
    expect(toolHooks.before).toBeUndefined();
    expect(sessionHooks.prompt).toBeUndefined();
  });
});

describe("plan selection", () => {
  test("a workspace without rules spawns no hooks", async () => {
    rulesResponse = { enabled: true, history: [] };
    const { toolHooks, sessionHooks } = await setup();
    await toolHooks.before?.(toolEvent("blocked ssh"));
    await toolHooks.after?.({ ...toolEvent("ls"), status: "completed", result: "ok" });
    await sessionHooks.prompt?.({
      sessionID: "ses-1",
      messageID: "m",
      prompt: { text: "blocked" },
    });
    expect(callCount()).toBe(0);
  });

  test("a confirmed global disable skips every hook", async () => {
    rulesResponse = { enabled: false, history: defaultHistory };
    const { toolHooks } = await setup();
    await toolHooks.before?.(toolEvent("blocked ssh"));
    expect(callCount()).toBe(0);
  });

  test("the plan selects exactly its events", async () => {
    rulesResponse = {
      enabled: true,
      history: [revision([rule("prompt-only", ["prompt_submit"])])],
    };
    const { toolHooks, sessionHooks } = await setup();
    await toolHooks.before?.(toolEvent("blocked ssh"));
    expect(callCount()).toBe(0);
    await expect(
      sessionHooks.prompt?.({ sessionID: "ses-1", messageID: "m", prompt: { text: "blocked" } }),
    ).rejects.toThrow("prompt-guard: no");
    expect(callCount()).toBe(1);
  });

  test("refresh picks up rules activated after setup", async () => {
    rulesResponse = { enabled: true, history: [] };
    const { toolHooks } = await setup();
    await toolHooks.before?.(toolEvent("blocked ssh"));
    expect(callCount()).toBe(0);
    rulesResponse = { enabled: true, history: [revision([rule("pre", ["pre_tool"])])] };
    offset = 31_000;
    await expect(toolHooks.before?.(toolEvent("blocked ssh"))).rejects.toThrow("guard: denied");
    expect(callCount()).toBe(1);
  });

  test("without a plan, blocking events still run the hook (fail closed)", async () => {
    const { toolHooks } = await setup({ apiBase: deadUrl });
    await expect(toolHooks.before?.(toolEvent("blocked ssh"))).rejects.toThrow("guard: denied");
    expect(callCount()).toBe(1);
  });
});

describe("execute.before", () => {
  test("a denied rule rejects the tool call with its reason", async () => {
    const { toolHooks } = await setup();
    await expect(toolHooks.before?.(toolEvent("blocked ssh prod"))).rejects.toThrow(
      "guard: denied",
    );
  });

  test("an allowed call passes through unchanged", async () => {
    const { toolHooks } = await setup();
    const event = toolEvent("ls");
    await toolHooks.before?.(event);
    expect(event.input).toEqual({ command: "ls" });
  });

  test("a rewrite replaces the tool input", async () => {
    const { toolHooks } = await setup();
    const event = toolEvent("rewrite git status");
    await toolHooks.before?.(event);
    expect(event.input).toEqual({ command: "ls" });
  });

  test("fails closed when the ORC command cannot run", async () => {
    const { toolHooks } = await setup({ command: "porc-missing-command-xyz", apiBase: deadUrl });
    await expect(toolHooks.before?.(toolEvent("ls"))).rejects.toThrow("ORC rule hook");
  });

  test("a nonzero hook exit blocks the call", async () => {
    const { toolHooks } = await setup();
    await expect(toolHooks.before?.(toolEvent("exit2"))).rejects.toThrow();
  });

  test("sends the session, workspace and tool identity to the adapter", async () => {
    const { toolHooks } = await setup();
    await toolHooks.before?.(toolEvent("ls"));
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const call = JSON.parse(lines[lines.length - 1] ?? "{}");
    expect(call.args).toEqual(["rules", "hook", "opencode", "execute.before"]);
    expect(call.payload.session_id).toBe("ses-1");
    expect(call.payload.cwd).toBe(directory);
    expect(call.payload.tool_call_id).toBe("call-1");
    expect(call.payload.tool_name).toBe("bash");
    expect(call.session).toBe("ses-1");
  });
});

describe("execute.after", () => {
  test("never throws, even when the hook cannot run", async () => {
    const { toolHooks } = await setup({ command: "porc-missing-command-xyz", apiBase: deadUrl });
    const event: ToolAfter = { ...toolEvent("ls"), status: "completed", result: { content: "ok" } };
    await toolHooks.after?.(event);
  });

  test("never defects on a broken host error shape", async () => {
    const { toolHooks } = await setup();
    const event = { ...toolEvent("ls"), status: "error" } as ToolAfter;
    await toolHooks.after?.(event);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const call = JSON.parse(lines[lines.length - 1] ?? "{}");
    expect(call.payload.tool_response).toEqual({ error: "tool error" });
  });

  test("reports failed tool results as errors", async () => {
    const { toolHooks } = await setup();
    const event: ToolAfter = {
      ...toolEvent("ls"),
      status: "error",
      error: { message: "boom" },
    };
    await toolHooks.after?.(event);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const call = JSON.parse(lines[lines.length - 1] ?? "{}");
    expect(call.args[3]).toBe("execute.after");
    expect(call.payload.tool_response).toEqual({ error: "boom" });
  });
});

describe("prompt admission", () => {
  test("a denied prompt is rejected", async () => {
    const { sessionHooks } = await setup();
    await expect(
      sessionHooks.prompt?.({
        sessionID: "ses-1",
        messageID: "m",
        prompt: { text: "blocked deploy" },
      }),
    ).rejects.toThrow("prompt-guard: no");
  });

  test("an allowed prompt passes and context is queued for the model", async () => {
    const { sessionHooks } = await setup();
    await sessionHooks.prompt?.({
      sessionID: "ses-1",
      messageID: "m",
      prompt: { text: "context please" },
    });
    const event: ContextEvent = { sessionID: "ses-1", system: [] };
    await sessionHooks.context?.(event);
    expect(event.system).toEqual([{ type: "text", text: "ORC rules:\nprompt guidance" }]);
    const again: ContextEvent = { sessionID: "ses-1", system: [] };
    await sessionHooks.context?.(again);
    expect(again.system).toEqual([]);
  });

  test("fails closed when the ORC command cannot run", async () => {
    const { sessionHooks } = await setup({ command: "porc-missing-command-xyz", apiBase: deadUrl });
    await expect(
      sessionHooks.prompt?.({ sessionID: "ses-1", messageID: "m", prompt: { text: "hello" } }),
    ).rejects.toThrow("ORC rule hook");
  });
});

describe("context delivery", () => {
  test("tool rule context reaches the next model request and is session-scoped", async () => {
    const { toolHooks, sessionHooks } = await setup();
    await toolHooks.before?.(toolEvent("context guidance"));
    const other: ContextEvent = { sessionID: "ses-other", system: [] };
    await sessionHooks.context?.(other);
    expect(other.system).toEqual([]);
    const event: ContextEvent = { sessionID: "ses-1", system: [] };
    await sessionHooks.context?.(event);
    expect(event.system).toEqual([{ type: "text", text: "ORC rules:\ntool guidance" }]);
  });

  test("compaction context is queued without blocking", async () => {
    const { sessionHooks } = await setup({ command: "porc-missing-command-xyz", apiBase: deadUrl });
    await sessionHooks.compaction?.({ sessionID: "ses-1" });
  });
});
