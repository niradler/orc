import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentBackend,
  type AgentEvent,
  type AgentSession,
  createBackend,
  registerBackend,
  type SessionOpts,
} from "@orc/agent-runtime";
import { type ChatEvent, ChatHistoryPageSchema, type ChatThread } from "@orc/core/chat";
import { resetConfig, updateGlobalConfig } from "@orc/core/config";
import { getDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { bridge_chats, gateway_sessions } from "@orc/db/schema";
import type { createApp } from "../server";
import { LIVE_CHAT_ID } from "../session-watcher";
import { setupTestApp, teardownTestApp } from "./helpers";

let app: ReturnType<typeof createApp>;
let original: AgentBackend;
const calls: { id: string | null; opts: SessionOpts; prompt?: string }[] = [];
const home = mkdtempSync(join(tmpdir(), "orc-chat-runtime-"));
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const oldMock = process.env.ORC_E2E_CHAT_MOCK;
let failResume = false;
let waitPermission = false;
let waitQuestion = false;
let secretQuestion = false;
let manyOptions = false;
let questionAnswers: Record<string, string[]> | undefined;
let failBeforeResult = false;
let resultIdentity: string | undefined;
let closed = 0;
let decision: string | undefined;
let liveMode: string | undefined;
const AUTH = { Authorization: "Bearer test-secret", "Content-Type": "application/json" };
function session(call: (typeof calls)[number]): AgentSession {
  let resolve: (() => void) | undefined;
  const permission = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    id: "fixture",
    getRuntimeSessionId: () => (waitPermission ? "early-native-fixture" : undefined),
    send: async (prompt) => {
      call.prompt = prompt;
    },
    respondPermission: (_id, value) => {
      decision = value;
      resolve?.();
    },
    setPermissionMode: (mode) => {
      liveMode = mode;
      if (mode === "bypassPermissions") {
        decision = "approved";
        resolve?.();
      }
    },
    respondQuestion: (_id, answers) => {
      questionAnswers = answers;
      resolve?.();
    },
    alive: () => true,
    close: async () => {
      closed++;
      resolve?.();
    },
    async *events(): AsyncIterable<AgentEvent> {
      yield { type: "thinking", data: "Visible provider reasoning summary" };
      yield {
        type: "tool_use",
        data: { id: "tool-1", name: "context", input: '{"project":"orc"}' },
      };
      if (waitPermission) {
        yield {
          type: "permission_request",
          data: { requestId: "permission-1", tool: "context", command: "Read context" },
        };
        await permission;
      }
      if (waitQuestion) {
        yield {
          type: "question_request",
          data: {
            requestId: "question-1",
            questions: [
              {
                id: "choice",
                header: "Choose",
                question: "Choose a color",
                ...(secretQuestion ? { isSecret: true } : {}),
                options: manyOptions
                  ? Array.from({ length: 21 }, (_, i) => ({
                      label: `Option ${i}`,
                      description: "",
                    }))
                  : [{ label: "Blue", description: "Blue color" }],
              },
            ],
          },
        };
        await permission;
      }
      yield {
        type: "tool_result",
        data: { toolUseId: "tool-1", content: "Workspace context", isError: false },
      };
      yield { type: "text", data: "Hello from the native session" };
      if (failBeforeResult) {
        yield { type: "error", data: "Native turn failed" };
        return;
      }
      yield {
        type: "result",
        data: { runtimeSessionId: resultIdentity ?? call.id ?? "native-fixture" },
      };
    },
  };
}
const request = (path: string, body?: unknown, auth = true) =>
  app.request(`/api${path}`, {
    method: body ? "POST" : "GET",
    headers: auth ? AUTH : { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function turn(body: unknown): Promise<{ response: Response; events: ChatEvent[] }> {
  const response = await request("/chat/stream", body);
  const text = await response.text();
  return {
    response,
    events: text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5))),
  };
}
beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.ORC_E2E_CHAT_MOCK;
  app = setupTestApp();
  updateGlobalConfig((raw) => {
    raw.preferences = {
      chat: {
        agent: "codex",
        model: "fixture-default",
        system: "Operator instructions",
        autoApprove: false,
        mcp: "orc",
      },
    };
  });
  original = createBackend("codex-cli");
  registerBackend("codex-cli", () => ({
    name: "codex-cli",
    preflight: async () => ({ ok: true }),
    stop: async () => {},
    startSession: async (opts) => {
      const call = { id: null, opts };
      calls.push(call);
      return session(call);
    },
    resumeSession: async (id, opts) => {
      if (failResume) throw new Error("Native resume rejected");
      const call = { id, opts };
      calls.push(call);
      return session(call);
    },
  }));
});
afterAll(() => {
  registerBackend("codex-cli", () => original);
  teardownTestApp();
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
  if (oldMock === undefined) delete process.env.ORC_E2E_CHAT_MOCK;
  else process.env.ORC_E2E_CHAT_MOCK = oldMock;
  resetConfig();
  rmSync(home, { recursive: true, force: true });
});

describe("native chat runtime", () => {
  test("should connect Cursor chat to ORC MCP and resume its selected provider", async () => {
    const originalAcpx = createBackend("acpx");
    const cursorCalls: { id: string | null; opts: SessionOpts; prompt?: string }[] = [];
    registerBackend("acpx", () => ({
      ...originalAcpx,
      startSession: async (opts) => {
        const call = { id: null, opts };
        cursorCalls.push(call);
        return session(call);
      },
      resumeSession: async (id, opts) => {
        const call = { id, opts };
        cursorCalls.push(call);
        return session(call);
      },
    }));
    try {
      const first = await turn({
        agent: "cursor",
        messages: [{ role: "user", content: "Cursor first turn" }],
      });
      expect(first.response.status).toBe(200);
      expect(first.events.some((event) => event.type === "done")).toBe(true);
      expect(cursorCalls[0]?.opts).toMatchObject({ acpxAgent: "cursor", orcMcp: true });
      const thread = first.events.find((event) => event.type === "thread");
      if (thread?.type !== "thread") throw new Error("Missing Cursor thread");
      const next = await turn({
        threadId: thread.thread.id,
        messages: [{ role: "user", content: "Cursor follow-up" }],
      });
      expect(next.response.status).toBe(200);
      expect(cursorCalls[1]?.id).toBe("native-fixture");
    } finally {
      registerBackend("acpx", () => originalAcpx);
    }
  });

  test("should bridge discovered Gemini sessions to their exact native ACPX identity", async () => {
    getDb()
      .insert(bridge_chats)
      .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: "chat-fixture" })
      .onConflictDoNothing()
      .run();
    const originalAcpx = createBackend("acpx");
    const nativeCalls: { id: string | null; opts: SessionOpts; prompt?: string }[] = [];
    registerBackend("acpx", () => ({
      ...originalAcpx,
      startSession: async () => {
        throw new Error("Native resume must not create a new session");
      },
      resumeSession: async (id, opts) => {
        const call = { id, opts };
        nativeCalls.push(call);
        return session(call);
      },
    }));
    try {
      for (const [backend, agent] of [["gemini", "gemini"]] as const) {
        const id = `native-${backend}`;
        getDb()
          .insert(gateway_sessions)
          .values({
            id,
            backend,
            mode: "direct",
            status: "idle",
            chat_id: LIVE_CHAT_ID,
            runtime_session_id: "native-fixture",
            cwd: home,
          })
          .run();
        const preparedResponse = await request("/chat/threads", { sourceSessionId: id });
        expect(preparedResponse.status).toBe(200);
        const prepared = (await preparedResponse.json()) as ChatThread;
        expect(prepared.config.agent).toBe(agent);
        expect(prepared.backend).toBe("acpx");
        const result = await turn({
          threadId: prepared.id,
          messages: [{ role: "user", content: "Continue original native work" }],
        });
        expect(result.events.some((event) => event.type === "error")).toBe(false);
        expect(nativeCalls.at(-1)).toMatchObject({
          id: "native-fixture",
          opts: { acpxAgent: agent, acpxNativeSessionId: "native-fixture", cwd: home },
          prompt: expect.stringContaining("Continue original native work"),
        });
      }
    } finally {
      registerBackend("acpx", () => originalAcpx);
    }
  });

  test("should admit Codex native pause policies while refusing policies it cannot enforce", async () => {
    const previous = process.env.ORC_RULES_ENABLED;
    process.env.ORC_RULES_ENABLED = "true";
    resetConfig();
    try {
      const store = new RuleStore(getSqlite());
      const policy = {
        workspace: process.cwd(),
        project_id: null,
        rules: [
          {
            id: "pause",
            kind: "event",
            enabled: true,
            reason: "Review",
            scope: { agents: ["codex"], events: ["runtime:permission_request"] },
            filter: { match: "all", conditions: [] },
            target: { type: "ask_user", kind: "approval", prompt: "Review" },
          },
        ],
      };
      const revision = store.activate(policy, null, "Native pause policy");
      const result = await turn({
        messages: [{ role: "user", content: "protected native turn" }],
        agent: "codex",
      });
      expect(result.events.some((event) => event.type === "done")).toBe(true);
      const count = calls.length;
      store.activate(
        { ...policy, rules: [{ ...policy.rules[0], target: { type: "block" } }] },
        revision.id,
        "Unsupported native policy",
      );
      expect(
        (
          await request("/chat/stream", {
            messages: [{ role: "user", content: "unsupported policy" }],
            agent: "codex",
          })
        ).status,
      ).toBe(503);
      expect(calls).toHaveLength(count);
    } finally {
      if (previous === undefined) delete process.env.ORC_RULES_ENABLED;
      else process.env.ORC_RULES_ENABLED = previous;
      resetConfig();
      calls.length = 0;
    }
  });
  test("a failed first turn cannot silently start a fresh agent on follow-up", async () => {
    failBeforeResult = true;
    const failed = await turn({
      messages: [{ role: "user", content: "fail before native identity" }],
    });
    failBeforeResult = false;
    const opened = failed.events[0];
    if (opened?.type !== "thread") throw new Error("Missing thread");
    const count = calls.length;
    expect(
      (
        await request("/chat/stream", {
          threadId: opened.thread.id,
          messages: [{ role: "user", content: "follow up" }],
        })
      ).status,
    ).toBe(409);
    expect(calls).toHaveLength(count);
    calls.length = 0;
  });
  test("streams structured activity, applies server settings and persists a resumable conversation", async () => {
    const result = await turn({
      messages: [{ role: "user", content: "first prompt" }],
      agent: "codex",
      model: "fixture-selected",
      system: "untrusted legacy override",
      autoApprove: true,
    });
    expect(result.response.status).toBe(200);
    expect(result.events.map((event) => event.type)).toEqual([
      "thread",
      "thinking",
      "tool_use",
      "tool_result",
      "text",
      "session",
      "done",
    ]);
    const opened = result.events[0];
    if (opened?.type !== "thread") throw new Error("No conversation identity");
    expect(result.events.at(-2)).toMatchObject({ type: "session", runtimeId: "native-fixture" });
    expect(calls[0]?.opts).toMatchObject({
      model: "fixture-selected",
      autoApprove: false,
      systemPromptAppend: expect.stringContaining("Operator instructions"),
      orcMcp: true,
      executionHost: null,
    });
    const stored = (await (
      await request(`/chat/threads/${opened.thread.id}`)
    ).json()) as ChatThread;
    expect(stored.runtimeId).toBe("native-fixture");
    expect(stored.messages).toHaveLength(2);
    expect(stored.messages[1]?.activity).toMatchObject([
      { type: "thinking" },
      { type: "tool", id: "tool-1", result: "Workspace context" },
    ]);
    await turn({
      threadId: stored.id,
      messages: [{ role: "user", content: "second prompt" }],
      model: "fixture-second",
    });
    expect(calls[1]).toMatchObject({
      id: "native-fixture",
      opts: { model: "fixture-second" },
      prompt: "second prompt",
    });
    expect(
      ((await (await request(`/chat/threads/${stored.id}`)).json()) as ChatThread).messages,
    ).toHaveLength(4);
    expect(closed).toBeGreaterThanOrEqual(2);
  });
  test("should save validated per-agent launch options and pass them on resume", async () => {
    const first = await turn({
      messages: [{ role: "user", content: "configure this conversation" }],
    });
    const opened = first.events[0];
    if (opened?.type !== "thread") throw new Error("No conversation");
    const options: ChatThread["config"]["agentOptions"] = {
      codex: { runtime: "codex", args: ["-c", 'model_reasoning_effort="high"'] },
      gemini: { runtime: "acpx", args: ["--approve-all"] },
    };
    const path = `/api/chat/threads/${opened.thread.id}/config`;
    const patch = (agentOptions: unknown, auth = true) =>
      app.request(path, {
        method: "PATCH",
        headers: auth ? AUTH : { "Content-Type": "application/json" },
        body: JSON.stringify({ agentOptions }),
      });
    expect((await patch(options, false)).status).toBe(401);
    expect((await patch({ codex: { runtime: "acpx", args: [] } })).status).toBe(400);
    expect(
      (await patch({ codex: { runtime: "codex", args: ["--listen", "ws://other"] } })).status,
    ).toBe(400);
    expect((await patch(options)).status).toBe(200);
    const saved = (await (await request(`/chat/threads/${opened.thread.id}`)).json()) as ChatThread;
    expect(saved.config.agentOptions).toEqual(options);
    await turn({
      threadId: opened.thread.id,
      messages: [{ role: "user", content: "resume with saved options" }],
    });
    expect(calls.at(-1)?.opts.chatAgentOptions).toEqual(options.codex);
  });

  test("model catalog validates auth, agent and conversation scope", async () => {
    expect((await request("/chat/models?agent=gemini", undefined, false)).status).toBe(401);
    expect((await request("/chat/models?agent=--bad")).status).toBe(400);
    expect((await request("/chat/models?agent=gemini&host=other")).status).toBe(400);
    const fallback = await (await request("/chat/models?agent=gemini")).json();
    expect(fallback).toMatchObject({ models: [], warning: expect.any(String) });
    const existing = await turn({ messages: [{ role: "user", content: "Model scope" }] });
    const threadEvent = existing.events.find((event) => event.type === "thread");
    if (threadEvent?.type !== "thread") throw new Error("No thread fixture");
    expect(
      (await request(`/chat/models?agent=claude&threadId=${threadEvent.thread.id}`)).status,
    ).toBe(400);
    expect(
      (await request("/chat/models?agent=codex&threadId=00000000-0000-4000-8000-000000000999"))
        .status,
    ).toBe(404);
  });

  test("loads 500 native turns, pages older history and continues beyond the old count/size caps", async () => {
    getDb()
      .insert(bridge_chats)
      .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: "chat-fixture" })
      .onConflictDoNothing()
      .run();
    const transcript = join(home, "long-native.jsonl");
    writeFileSync(
      transcript,
      Array.from({ length: 1105 }, (_, index) =>
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: index % 2 ? "assistant" : "user",
            content: [
              {
                type: index % 2 ? "output_text" : "input_text",
                text: `history-${index}: ${index >= 605 ? "x".repeat(11000) : "earlier"}`,
              },
            ],
          },
        }),
      ).join("\n"),
    );
    getDb()
      .insert(gateway_sessions)
      .values({
        id: "source-long",
        backend: "codex",
        mode: "direct",
        status: "stopped",
        chat_id: LIVE_CHAT_ID,
        runtime_session_id: "long-native",
        cwd: home,
        transcript_path: transcript,
      })
      .run();
    const prepared = (await (
      await request("/chat/threads", { sourceSessionId: "source-long" })
    ).json()) as ChatThread;
    expect(prepared.messages).toHaveLength(500);
    expect(prepared.messages[0]?.content).toStartWith("history-605:");
    expect(prepared.messages.at(-1)?.content).toStartWith("history-1104:");
    expect(prepared.historyBefore).toBe(605);
    expect(prepared.importedMessages).toBe(500);
    expect(JSON.stringify(prepared.messages).length).toBeGreaterThan(5000000);
    const historyUrl = `/chat/threads/${prepared.id}/history`;
    expect((await request(`${historyUrl}?before=605`, undefined, false)).status).toBe(401);
    for (const before of ["-1", "0", "606", "1.5", "bad"])
      expect((await request(`${historyUrl}?before=${before}`)).status).toBe(400);
    const older = ChatHistoryPageSchema.parse(
      await (await request(`${historyUrl}?before=605`)).json(),
    );
    expect(older.messages).toHaveLength(500);
    expect(older.messages[0]?.content).toStartWith("history-105:");
    expect(older.messages.at(-1)?.content).toStartWith("history-604:");
    expect(older.before).toBe(105);
    const first = ChatHistoryPageSchema.parse(
      await (await request(`${historyUrl}?before=105`)).json(),
    );
    expect(first.messages).toHaveLength(105);
    expect(first.messages[0]?.content).toStartWith("history-0:");
    expect(first.before).toBeNull();
    const continued = await turn({
      threadId: prepared.id,
      messages: [{ role: "user", content: "continue long history" }],
    });
    expect(continued.response.status).toBe(200);
    expect(calls.at(-1)).toMatchObject({ id: "long-native", prompt: "continue long history" });
    const saved = (await (await request(`/chat/threads/${prepared.id}`)).json()) as ChatThread;
    expect(saved.messages).toHaveLength(502);
    expect(saved.historyBefore).toBe(605);
  });

  test("resumes native identity and stale status while rejecting real owners, unsupported and missing sources", async () => {
    getDb()
      .insert(bridge_chats)
      .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: "chat-fixture" })
      .onConflictDoNothing()
      .run();
    const transcript = join(home, "native.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Earlier native history" }],
        },
      })}\n`,
    );
    for (const [id, backend, status] of [
      ["source-ended", "codex", "stopped"],
      ["source-running", "codex", "running"],
      ["source-other", "cursor", "stopped"],
    ] as const)
      getDb()
        .insert(gateway_sessions)
        .values({
          id,
          backend,
          mode: "direct",
          status,
          chat_id: LIVE_CHAT_ID,
          runtime_session_id: "discovered-native",
          cwd: home,
          transcript_path: transcript,
          title: id,
        })
        .run();
    expect((await request("/chat/threads", { sourceSessionId: "source-running" })).status).toBe(
      200,
    );
    for (const [id, pid] of [
      ["claude-owned", process.pid],
      ["claude-stale", 2147483647],
    ] as const) {
      getDb()
        .insert(gateway_sessions)
        .values({
          id,
          backend: "claude",
          mode: "direct",
          status: "idle",
          pid,
          chat_id: LIVE_CHAT_ID,
          runtime_session_id: id,
          cwd: home,
        })
        .run();
    }
    expect((await request("/chat/threads", { sourceSessionId: "claude-owned" })).status).toBe(409);
    const staleResponse = await request("/chat/threads", { sourceSessionId: "claude-stale" });
    expect(staleResponse.status).toBe(200);
    const staleThread = (await staleResponse.json()) as ChatThread;
    getSqlite()
      .query("UPDATE gateway_sessions SET pid = ? WHERE id = ?")
      .run(process.pid, "claude-stale");
    const nowOwned = await turn({
      threadId: staleThread.id,
      messages: [{ role: "user", content: "Do not overlap owners" }],
    });
    expect(nowOwned.events).toContainEqual({
      type: "error",
      message:
        "This session is still open in its original agent. End it there before resuming in chat, or use Terminal.",
    });
    expect((await request("/chat/threads", { sourceSessionId: "source-other" })).status).toBe(400);
    getDb()
      .insert(gateway_sessions)
      .values({
        id: "source-cursor-cli",
        backend: "cursor-agent",
        mode: "direct",
        status: "stopped",
        chat_id: LIVE_CHAT_ID,
        runtime_session_id: "native-cursor",
        cwd: home,
      })
      .run();
    const cursorResume = await request("/chat/threads", { sourceSessionId: "source-cursor-cli" });
    expect(cursorResume.status).toBe(400);
    expect(await cursorResume.text()).toContain("separate session stores");
    expect((await request("/chat/threads", { sourceSessionId: "missing" })).status).toBe(404);
    const prepared = (await (
      await request("/chat/threads", { sourceSessionId: "source-ended" })
    ).json()) as ChatThread;
    expect(prepared.runtimeId).toBe("discovered-native");
    expect(prepared.cwd).toBe(home);
    expect(prepared.messages[0]?.content).toContain("Earlier native history");
    await turn({
      threadId: prepared.id,
      messages: [{ role: "user", content: "continue native work" }],
    });
    expect(calls[calls.length - 1]).toMatchObject({
      id: "discovered-native",
      opts: { cwd: home },
      prompt: "continue native work",
    });
    failResume = true;
    const count = calls.length;
    const failed = await turn({
      threadId: prepared.id,
      messages: [{ role: "user", content: "do not start fresh" }],
    });
    expect(failed.events).toContainEqual({ type: "error", message: "Native resume rejected" });
    expect(calls.length).toBe(count);
    failResume = false;
  });

  test("rejects a stale stopped record when the Codex writer is still owned", async () => {
    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "../../scripts/verify-codex-silent-exit.ts"), "--resume-only"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20000 },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(stderr || stdout);
    expect(stderr).toContain("End the original agent session before resuming it in chat.");
    expect(stdout).toContain(
      "stopped Codex record rejects a held writer, resumes after release and blocks re-acquisition",
    );
  });
  test("requires auth, validates shapes and denies unknown conversations and permission requests", async () => {
    for (const [path, body] of [
      ["/chat/threads", undefined],
      ["/chat/stream", { messages: [{ role: "user", content: "x" }] }],
      [
        "/chat/runs/00000000-0000-4000-8000-000000000000/permission",
        { requestId: "x", decision: "approved" },
      ],
    ] as const)
      expect((await request(path, body, false)).status).toBe(401);
    for (const body of [
      { messages: [null] },
      { messages: [{ role: "user", content: {} }] },
      { messages: [{ role: "user", content: "x" }], model: "--help" },
      { messages: [{ role: "user", content: "x" }], sourceSessionId: "arbitrary-native" },
    ])
      expect((await request("/chat/stream", body)).status).toBe(400);
    expect((await request("/chat/threads/00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect(
      (
        await request("/chat/runs/00000000-0000-4000-8000-000000000000/permission", {
          requestId: "missing",
          decision: "approved",
        })
      ).status,
    ).toBe(409);
  });

  test("a provider cannot silently replace a resumed conversation identity", async () => {
    const started = await turn({ messages: [{ role: "user", content: "keep this identity" }] });
    const opened = started.events[0];
    if (opened?.type !== "thread") throw new Error("No thread");
    resultIdentity = "different-native-session";
    const resumed = await turn({
      threadId: opened.thread.id,
      messages: [{ role: "user", content: "resume without forking" }],
    });
    resultIdentity = undefined;
    expect(
      resumed.events.some(
        (event) => event.type === "error" && event.message.includes("different session"),
      ),
    ).toBe(true);
    expect(
      ((await (await request(`/chat/threads/${opened.thread.id}`)).json()) as ChatThread).runtimeId,
    ).toBe("native-fixture");
  });
  test("should validate question replies, reject stale responses and preserve explicit access settings", async () => {
    waitQuestion = true;
    const response = await request("/chat/stream", {
      permissionMode: "bypassPermissions",
      messages: [{ role: "user", content: "wait for an answer" }],
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No stream");
    try {
      let text = "";
      const decoder = new TextDecoder();
      while (!text.includes('"question_request"')) {
        const part = await reader.read();
        if (part.done) throw new Error("Ended before question");
        text += decoder.decode(part.value);
      }
      const opened = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
        .find((event) => event.type === "thread") as Extract<ChatEvent, { type: "thread" }>;
      const path = `/chat/runs/${opened.runId}/answer`;
      const inbox = (await (await request("/human-requests")).json()) as {
        input: { origin: { chat_thread_id?: string; session_title?: string } };
      }[];
      expect(
        inbox.some(
          (entry) =>
            entry.input.origin.chat_thread_id === opened.thread.id &&
            entry.input.origin.session_title === "wait for an answer",
        ),
      ).toBe(true);
      expect(
        (await request(path, { requestId: "question-1", answers: { choice: ["Blue"] } }, false))
          .status,
      ).toBe(401);
      expect(
        (await request(path, { requestId: "wrong", answers: { choice: ["Blue"] } })).status,
      ).toBe(409);
      expect(
        (await request(path, { requestId: "question-1", answers: { wrong: ["Blue"] } })).status,
      ).toBe(400);
      expect(
        (await request(path, { requestId: "question-1", answers: { choice: [""] } })).status,
      ).toBe(400);
      expect(
        (await request(path, { requestId: "question-1", answers: { choice: ["Blue"] } })).status,
      ).toBe(200);
      while (!(await reader.read()).done) {
        /* drain resumed turn */
      }
      expect(questionAnswers).toEqual({ choice: ["Blue"] });
      expect(
        (await request(path, { requestId: "question-1", answers: { choice: ["Blue"] } })).status,
      ).toBe(409);
      expect(calls.at(-1)?.opts).toMatchObject({
        interactive: true,
        permissionMode: "bypassPermissions",
      });
      const saved = (await (
        await request(`/chat/threads/${opened.thread.id}`)
      ).json()) as ChatThread;
      expect(saved.config.permissionMode).toBe("bypassPermissions");
      expect(JSON.stringify(saved.messages)).not.toContain('"choice"');
    } finally {
      waitQuestion = false;
      reader.releaseLock();
    }
  });

  for (const scenario of ["private", "many options"] as const) {
    test(`shows a safe chat notice for ${scenario} without blocking the native answer`, async () => {
      waitQuestion = true;
      secretQuestion = scenario === "private";
      manyOptions = scenario === "many options";
      const response = await request("/chat/stream", {
        messages: [{ role: "user", content: `question ${scenario}` }],
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No stream");
      try {
        let text = "";
        const decoder = new TextDecoder();
        while (!text.includes('"question_request"')) {
          const part = await reader.read();
          if (part.done) throw new Error("Ended before question");
          text += decoder.decode(part.value);
        }
        const opened = text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)))
          .find((event) => event.type === "thread") as Extract<ChatEvent, { type: "thread" }>;
        expect((await request("/chat/waiting", undefined, false)).status).toBe(401);
        const waiting = (await (await request("/chat/waiting")).json()) as {
          waiting: { thread_id: string; kind: string }[];
        };
        expect(waiting.waiting).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ thread_id: opened.thread.id, kind: "question" }),
          ]),
        );
        expect(JSON.stringify(waiting)).not.toContain("Choose a color");
        expect(
          (
            (await (await request("/human-requests")).json()) as {
              input: { origin: { chat_thread_id?: string } };
            }[]
          ).some(
            (entry: { input: { origin: { chat_thread_id?: string } } }) =>
              entry.input.origin.chat_thread_id === opened.thread.id,
          ),
        ).toBe(false);
        expect(
          (
            await request(`/chat/runs/${opened.runId}/answer`, {
              requestId: "question-1",
              answers: { choice: ["Blue"] },
            })
          ).status,
        ).toBe(200);
        while (!(await reader.read()).done) {}
        expect(
          (
            (await (await request("/chat/waiting")).json()) as { waiting: { thread_id: string }[] }
          ).waiting.some((entry: { thread_id: string }) => entry.thread_id === opened.thread.id),
        ).toBe(false);
      } finally {
        waitQuestion = false;
        secretQuestion = false;
        manyOptions = false;
        reader.releaseLock();
      }
    });
  }

  test("permissions can be loosened while the agent is responding and are kept", async () => {
    waitPermission = true;
    decision = undefined;
    const response = await request("/chat/stream", {
      messages: [{ role: "user", content: "wait for approval" }],
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No stream");
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes('"permission_request"')) {
      const part = await reader.read();
      if (part.done) throw new Error("Ended before permission");
      text += decoder.decode(part.value);
    }
    const opened = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .find((event) => event.type === "thread") as Extract<ChatEvent, { type: "thread" }>;
    const path = `/chat/runs/${opened.runId}/permission-mode`;
    expect((await request(path, { mode: "yolo" })).status).toBe(400);
    const changed = await request(path, { mode: "bypassPermissions" });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as ChatThread).config.permissionMode).toBe("bypassPermissions");
    expect(liveMode).toBe("bypassPermissions");
    while (!(await reader.read()).done) {
      /* the pending approval was granted by the new mode */
    }
    reader.releaseLock();
    expect(decision as string | undefined).toBe("approved");
    const saved = (await (await request(`/chat/threads/${opened.thread.id}`)).json()) as ChatThread;
    expect(saved.config.permissionMode).toBe("bypassPermissions");
    expect((await request(path, { mode: "default" })).status).toBe(409);
    waitPermission = false;
  });

  test("a settings save failure does not loosen a pending permission", async () => {
    waitPermission = true;
    liveMode = undefined;
    const response = await request("/chat/stream", {
      messages: [{ role: "user", content: "fail-mode-save" }],
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No stream");
    try {
      let text = "";
      const decoder = new TextDecoder();
      while (!text.includes('"permission_request"')) {
        const part = await reader.read();
        if (part.done) throw new Error("Ended before permission");
        text += decoder.decode(part.value);
      }
      const opened = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
        .find((event) => event.type === "thread") as Extract<ChatEvent, { type: "thread" }>;
      getSqlite().exec(
        "CREATE TEMP TRIGGER fail_mode_save BEFORE UPDATE ON chat_threads WHEN NEW.title = 'fail-mode-save' AND json_extract(NEW.data, '$.config.permissionMode') = 'bypassPermissions' BEGIN SELECT RAISE(FAIL, 'fixture mode save failure'); END",
      );
      expect(
        (await request(`/chat/runs/${opened.runId}/permission-mode`, { mode: "bypassPermissions" }))
          .status,
      ).toBe(500);
      expect(liveMode).toBeUndefined();
      const saved = (await (
        await request(`/chat/threads/${opened.thread.id}`)
      ).json()) as ChatThread;
      expect(saved.config.permissionMode).not.toBe("bypassPermissions");
      expect(
        (
          await request(`/chat/runs/${opened.runId}/permission`, {
            requestId: "permission-1",
            decision: "denied",
          })
        ).status,
      ).toBe(200);
      while (!(await reader.read()).done) {}
    } finally {
      waitPermission = false;
      reader.releaseLock();
    }
  });

  test("permission replies unblock the correct run and concurrent sends are refused", async () => {
    waitPermission = true;
    const response = await request("/chat/stream", {
      messages: [{ role: "user", content: "wait for approval" }],
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No stream");
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes('"permission_request"')) {
      const part = await reader.read();
      if (part.done) throw new Error("Ended before permission");
      text += decoder.decode(part.value);
    }
    const opened = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .find((event) => event.type === "thread") as Extract<ChatEvent, { type: "thread" }>;
    expect(
      (
        await request("/chat/stream", {
          threadId: opened.thread.id,
          messages: [{ role: "user", content: "duplicate" }],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request(`/api/chat/threads/${opened.thread.id}/config`, {
          method: "PATCH",
          headers: AUTH,
          body: JSON.stringify({ agentOptions: {} }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/chat/runs/${opened.runId}/permission`, {
          requestId: "wrong",
          decision: "approved",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/chat/runs/${opened.runId}/permission`, {
          requestId: "permission-1",
          decision: "denied",
        })
      ).status,
    ).toBe(200);
    while (!(await reader.read()).done) {
      /* drain completed turn */
    }
    reader.releaseLock();
    expect(decision).toBe("denied");
    expect(
      (
        await request(`/chat/runs/${opened.runId}/permission`, {
          requestId: "permission-1",
          decision: "approved",
        })
      ).status,
    ).toBe(409);
    waitPermission = false;
  });

  test("cancelling while awaiting permission closes the agent and expires the approval", async () => {
    waitPermission = true;
    const response = await request("/chat/stream", {
      messages: [{ role: "user", content: "cancel permission wait" }],
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing reader");
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes('"permission_request"')) {
      const part = await reader.read();
      if (part.done) throw new Error("Ended early");
      text += decoder.decode(part.value);
    }
    const opened = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .find((event) => event.type === "thread") as Extract<ChatEvent, { type: "thread" }>;
    const previousClosed = closed;
    expect((await request(`/chat/runs/${opened.runId}/cancel`, {})).status).toBe(200);
    while (!(await reader.read()).done) {
      /* wait for finally cleanup */
    }
    expect((await request(`/chat/runs/${opened.runId}/cancel`, {})).status).toBe(409);
    reader.releaseLock();
    expect(closed).toBeGreaterThan(previousClosed);
    expect(
      ((await (await request(`/chat/threads/${opened.thread.id}`)).json()) as ChatThread).runtimeId,
    ).toBe("early-native-fixture");
    expect(
      (
        await request(`/chat/runs/${opened.runId}/permission`, {
          requestId: "permission-1",
          decision: "approved",
        })
      ).status,
    ).toBe(409);
    waitPermission = false;
    await turn({
      threadId: opened.thread.id,
      messages: [{ role: "user", content: "continue after stopping" }],
    });
    expect(calls[calls.length - 1]?.id).toBe("early-native-fixture");
  });

  test("a turn keeps running after the browser disconnects and can be reattached", async () => {
    waitPermission = true;
    const controller = new AbortController();
    const response = await app.request("/api/chat/stream", {
      method: "POST",
      headers: AUTH,
      signal: controller.signal,
      body: JSON.stringify({ messages: [{ role: "user", content: "background turn" }] }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No stream");
    try {
      let text = "";
      const decoder = new TextDecoder();
      while (!text.includes('"permission_request"')) {
        const part = await reader.read();
        if (part.done) throw new Error("Ended early");
        text += decoder.decode(part.value);
      }
      const opened = text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
        .find((event) => event.type === "thread") as Extract<ChatEvent, { type: "thread" }>;
      const previousClosed = closed;
      controller.abort();
      expect(closed).toBe(previousClosed);
      const listed = (await (await request("/chat/threads")).json()) as {
        threads: { id: string; running: boolean }[];
      };
      expect(listed.threads.find((thread) => thread.id === opened.thread.id)?.running).toBe(true);
      const live = await request(`/chat/threads/${opened.thread.id}/live`);
      expect(live.status).toBe(200);
      const liveReader = live.body?.getReader();
      if (!liveReader) throw new Error("No live stream");
      let replay = "";
      while (!replay.includes('"permission_request"')) {
        const part = await liveReader.read();
        if (part.done) throw new Error("Live stream ended early");
        replay += decoder.decode(part.value);
      }
      expect(replay).toContain('"type":"thread"');
      expect(
        (
          await request(`/chat/runs/${opened.runId}/permission`, {
            requestId: "permission-1",
            decision: "approved",
          })
        ).status,
      ).toBe(200);
      while (true) {
        const part = await liveReader.read();
        if (part.done) break;
        replay += decoder.decode(part.value);
      }
      expect(replay).toContain("Hello from the native session");
      expect(replay).toContain('"type":"done"');
      const saved = (await (
        await request(`/chat/threads/${opened.thread.id}`)
      ).json()) as ChatThread;
      expect(
        saved.messages.some((message) => message.content === "Hello from the native session"),
      ).toBe(true);
      expect(decision).toBe("approved");
      expect((await request(`/chat/threads/${opened.thread.id}/live`)).status).toBe(204);
    } finally {
      waitPermission = false;
      reader.releaseLock();
    }
  });

  test("database failures release workers and report unsaved responses", async () => {
    getSqlite().exec(
      "CREATE TEMP TRIGGER fail_chat_insert BEFORE INSERT ON chat_threads WHEN NEW.title = 'fail-persist' BEGIN SELECT RAISE(FAIL, 'fixture storage failure'); END",
    );
    for (let attempt = 0; attempt < 5; attempt++)
      expect(
        (await request("/chat/stream", { messages: [{ role: "user", content: "fail-persist" }] }))
          .status,
      ).toBe(500);
    getSqlite().exec(
      "CREATE TEMP TRIGGER fail_chat_update BEFORE UPDATE ON chat_threads WHEN NEW.title = 'fail-final-persist' BEGIN SELECT RAISE(FAIL, 'fixture final save failure'); END",
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await turn({ messages: [{ role: "user", content: "fail-final-persist" }] });
      expect(result.response.status).toBe(200);
      expect(result.events).toContainEqual({
        type: "error",
        message: "This response could not be saved. Start a new chat before continuing.",
      });
    }
  });
});
