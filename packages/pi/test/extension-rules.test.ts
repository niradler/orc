import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistrations } from "@orc/core/live-session";
import porc from "../extensions/orc.js";

type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

function fakePi() {
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    api: {
      registerFlag: () => undefined,
      getFlag: () => undefined,
      registerEntryRenderer: () => undefined,
      registerTool: () => undefined,
      registerCommand: () => undefined,
      appendEntry: () => undefined,
      on: (name: string, handler: Handler) => {
        handlers[name] = handler;
      },
    },
  };
}

function fakeCtx(cwd: string, trusted = false, entries: { type: string }[] = []) {
  return {
    cwd,
    hasUI: false,
    signal: undefined,
    sessionManager: {
      getSessionId: () => "pi-extension-test",
      getSessionFile: () => undefined,
      getEntries: () => entries,
    },
    isProjectTrusted: () => trusted,
    ui: {
      setStatus: () => undefined,
      notify: () => undefined,
      setWidget: () => undefined,
    },
  };
}

const directory = mkdtempSync(join(tmpdir(), "orc-pi-extension-"));
const log = join(directory, "calls.jsonl");
const decisionFile = join(directory, "decision.json");
writeFileSync(decisionFile, "{}");
const stubSource = `import { appendFileSync, readFileSync } from "node:fs";
const payload = JSON.parse(await Bun.stdin.text());
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), payload }) + "\\n");
console.log(readFileSync(${JSON.stringify(decisionFile)}, "utf8"));
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

let rulesResponse: {
  enabled: boolean;
  history: unknown[];
  history_truncated?: boolean;
} = { enabled: true, history: [], history_truncated: false };
function startServer(port: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/health") return Response.json({ status: "ok" });
      if (url.pathname === "/api/rules") return Response.json(rulesResponse);
      if (url.pathname === "/api/skills/project-folders") return Response.json({ projects: [] });
      return new Response("not found", { status: 404 });
    },
  });
}
let server = startServer(0);
const apiPort = server.port;
if (apiPort === undefined) throw new Error("Stub API server did not bind a port");

const envKeys = [
  "PORC_API_BASE",
  "PORC_ORC_COMMAND",
  "PORC_AUTO_PROJECT",
  "PORC_CONTEXT",
  "PORC_RECALL",
  "PORC_RULES",
] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.PORC_API_BASE = `http://127.0.0.1:${apiPort}`;
process.env.PORC_ORC_COMMAND = stubCommand;
process.env.PORC_AUTO_PROJECT = "false";
process.env.PORC_CONTEXT = "false";
process.env.PORC_RECALL = "false";
process.env.PORC_RULES = "true";

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

afterAll(() => {
  Date.now = realNow;
  server.stop(true);
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});
afterEach(() => {
  offset = 0;
  writeFileSync(log, "");
  writeFileSync(decisionFile, "{}");
});

function callCount(): number {
  const text = readFileSync(log, "utf8").trim();
  return text ? text.split("\n").length : 0;
}

const toolCall = { toolCallId: "t1", toolName: "bash", input: { command: "ls" } };
const agentStart = {
  messageType: "user",
  prompt: "hello",
  systemPromptOptions: { sections: {}, skills: [] },
};

function preToolRevision() {
  return {
    id: "rev1",
    workspace: directory,
    project_id: null,
    current: true,
    policy: {
      workspace: directory,
      project_id: null,
      rules: [
        {
          id: "no-ssh",
          reason: "No ssh",
          kind: "event",
          enabled: true,
          scope: { agents: "all", events: ["pre_tool"] },
          filter: { match: "all", conditions: [] },
          target: { type: "block" },
        },
      ],
    },
  };
}

describe("porc rule enforcement (issue #260)", () => {
  test("blocking events run the hook even when ORC is offline (fail closed)", async () => {
    server.stop(true);
    try {
      const { handlers, api } = fakePi();
      porc(api as never, join(directory, "live"));
      const ctx = fakeCtx(directory);
      await handlers.session_start?.({ reason: "startup" }, ctx);
      writeFileSync(
        decisionFile,
        JSON.stringify({
          hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "guard: no" },
        }),
      );
      const decision = await handlers.tool_call?.(toolCall, ctx);
      expect(decision).toEqual({ block: true, reason: "guard: no" });
      expect(callCount()).toBe(1);
    } finally {
      server = startServer(apiPort);
    }
  });

  test("a loaded plan skips events without rules", async () => {
    rulesResponse = { enabled: true, history: [], history_truncated: false };
    const { handlers, api } = fakePi();
    porc(api as never, join(directory, "live"));
    const ctx = fakeCtx(directory);
    await handlers.session_start?.({ reason: "startup" }, ctx);
    const decision = await handlers.tool_call?.(toolCall, ctx);
    expect(decision).toBeUndefined();
    expect(callCount()).toBe(0);
  });

  test("periodic refresh picks up rules activated after session start", async () => {
    rulesResponse = { enabled: true, history: [], history_truncated: false };
    const { handlers, api } = fakePi();
    porc(api as never, join(directory, "live"));
    const ctx = fakeCtx(directory);
    await handlers.session_start?.({ reason: "startup" }, ctx);
    expect(await handlers.tool_call?.(toolCall, ctx)).toBeUndefined();

    rulesResponse = { enabled: true, history: [preToolRevision()], history_truncated: false };
    offset = 31_000;
    await handlers.before_agent_start?.(agentStart, ctx);
    writeFileSync(
      decisionFile,
      JSON.stringify({
        hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "guard: no" },
      }),
    );
    const decision = await handlers.tool_call?.(toolCall, ctx);
    expect(decision).toEqual({ block: true, reason: "guard: no" });
    expect(callCount()).toBe(1);
  });

  test("a config error fails closed unless rules are explicitly opted out", async () => {
    const badDir = join(directory, "badcfg");
    mkdirSync(join(badDir, ".pi"), { recursive: true });
    writeFileSync(join(badDir, ".pi", "porc.json"), "{ not json");
    const ctx = fakeCtx(badDir, true);
    process.env.PORC_RULES = "true";
    const guarded = fakePi();
    porc(guarded.api as never, join(directory, "live"));
    await guarded.handlers.session_start?.({ reason: "startup" }, ctx);
    expect(await guarded.handlers.tool_call?.(toolCall, ctx)).toEqual({
      block: true,
      reason: expect.stringContaining("configuration"),
    });
    process.env.PORC_RULES = "false";
    const optedOut = fakePi();
    porc(optedOut.api as never, join(directory, "live"));
    await optedOut.handlers.session_start?.({ reason: "startup" }, ctx);
    expect(await optedOut.handlers.tool_call?.(toolCall, ctx)).toBeUndefined();
    process.env.PORC_RULES = "true";
  });

  test("a confirmed global disable skips enforcement", async () => {
    rulesResponse = { enabled: false, history: [preToolRevision()], history_truncated: false };
    const { handlers, api } = fakePi();
    porc(api as never, join(directory, "live"));
    const ctx = fakeCtx(directory);
    await handlers.session_start?.({ reason: "startup" }, ctx);
    const decision = await handlers.tool_call?.(toolCall, ctx);
    expect(decision).toBeUndefined();
    expect(callCount()).toBe(0);
    rulesResponse = { enabled: true, history: [], history_truncated: false };
  });
});

test("the session registers its pid and turn status in the ORC live registry (issue #259)", async () => {
  const liveDir = join(directory, "live-259");
  const { handlers, api } = fakePi();
  porc(api as never, liveDir);
  const ctx = fakeCtx(directory);
  const status = () =>
    readRegistrations(liveDir).map((record) => [
      record.backend,
      record.externalId,
      record.pid,
      record.cwd,
      record.status,
    ]);
  await handlers.session_start?.({ reason: "startup" }, ctx);
  expect(status()).toEqual([]);
  await handlers.agent_start?.({}, ctx);
  expect(status()).toEqual([["pi", "pi-extension-test", process.pid, directory, "running"]]);
  await handlers.agent_end?.({ messages: [] }, ctx);
  expect(status()).toEqual([["pi", "pi-extension-test", process.pid, directory, "idle"]]);
  await handlers.session_shutdown?.({ reason: "quit" }, ctx);
  expect(status()).toEqual([["pi", "pi-extension-test", process.pid, directory, "stopped"]]);
});

test("a Pi launched without a prompt leaves no ORC session behind", async () => {
  const liveDir = join(directory, "live-empty");
  mkdirSync(liveDir, { recursive: true });
  // A registration left by an earlier process for a session that never held a message.
  writeFileSync(
    join(liveDir, "pi-pi-extension-test.json"),
    JSON.stringify({
      backend: "pi",
      externalId: "pi-extension-test",
      pid: 1,
      title: "Pi session",
      status: "stopped",
      createdAt: 1,
      updatedAt: 1,
    }),
  );
  const { handlers, api } = fakePi();
  porc(api as never, liveDir);
  const ctx = fakeCtx(directory);
  await handlers.session_start?.({ reason: "startup" }, ctx);
  expect(readRegistrations(liveDir)).toEqual([]);
  await handlers.session_shutdown?.({ reason: "quit" }, ctx);
  expect(readRegistrations(liveDir)).toEqual([]);
});

test("a resumed Pi session registers its history immediately", async () => {
  const liveDir = join(directory, "live-resume");
  const { handlers, api } = fakePi();
  porc(api as never, liveDir);
  const ctx = fakeCtx(directory, false, [{ type: "message" }]);
  await handlers.session_start?.({ reason: "resume" }, ctx);
  expect(
    readRegistrations(liveDir).map((record) => [record.backend, record.externalId, record.status]),
  ).toEqual([["pi", "pi-extension-test", "idle"]]);
});
