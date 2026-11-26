import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentBackend,
  type AgentEvent,
  type AgentSession,
  type AgentUnexpectedExit,
  createBackend,
  registerBackend,
} from "@orc/agent-runtime";
import { ChatThreadSchema } from "@orc/core/chat";
import type { SessionStatus } from "@orc/core/session-messages";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { reconcileChatTurnLeases } from "../chat-recovery.js";
import { chatStatus, drainChatTurns, setChatTurnLimits } from "../routes/chat.js";
import type { createApp } from "../server.js";
import { chatHistory } from "../sessions/chat-history.js";
import { parseTranscriptContent } from "../sessions/transcript.js";
import { req as appReq, setupTestApp, teardownTestApp } from "./helpers.js";

let tempDir: string;
let workDir: string;
let app: ReturnType<typeof createApp>;
let originalClaude: AgentBackend;
let originalOrcHome: string | undefined;

async function req(method: string, path: string, body?: unknown) {
  return appReq(app, method, path, body);
}

async function waitFor<T>(fn: () => Promise<T | null> | T | null, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null) return val;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for condition");
}

beforeAll(() => {
  originalClaude = createBackend("claude");
  tempDir = mkdtempSync(join(tmpdir(), "orc-stability-api-"));
  workDir = join(tempDir, "repo");
  mkdirSync(workDir, { recursive: true });
  originalOrcHome = process.env.ORC_HOME;
  process.env.ORC_HOME = join(tempDir, "home");
  mkdirSync(process.env.ORC_HOME, { recursive: true });
  app = setupTestApp();
});

afterEach(async () => {
  await drainChatTurns();
});

afterAll(() => {
  teardownTestApp();
  if (originalOrcHome === undefined) delete process.env.ORC_HOME;
  else process.env.ORC_HOME = originalOrcHome;
  rmSync(tempDir, { recursive: true, force: true });
});

async function parseSseThreadId(response: Response): Promise<string> {
  const text = await response.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim()) as {
        type?: string;
        thread?: { id?: string };
      };
      if (parsed.type === "thread" && parsed.thread?.id) return parsed.thread.id;
    } catch {}
  }
  throw new Error(`No thread event in SSE stream:\n${text}`);
}

describe("session stability (#565, #566, #567)", () => {
  test("#565: observed runtimeModel propagates to thread, list, status, and transcript history preserves per-turn model", async () => {
    const backend: AgentBackend = {
      name: "claude",
      preflight: async () => ({ ok: true }),
      stop: async () => {},
      startSession: async () => ({
        id: "s-model",
        alive: () => true,
        send: async () => {},
        respondPermission: () => {},
        close: async () => {},
        async *events(): AsyncIterable<AgentEvent> {
          yield { type: "model", data: "qwen4-max" };
          yield { type: "text", data: "Serving from custom model." };
          yield {
            type: "result",
            data: { runtimeSessionId: "rt-qwen-1", model: "qwen4-max", durationMs: 25 },
          };
        },
      }),
      resumeSession: async () => {
        throw new Error("unexpected resume");
      },
    };
    registerBackend("claude", () => backend);
    try {
      const sendRes = await req("POST", "/chat/stream", {
        agent: "claude",
        model: "",
        workspace: { cwd: workDir },
        messages: [{ role: "user", content: "Which model are you?" }],
      });
      expect(sendRes.status).toBe(200);
      const threadId = await parseSseThreadId(sendRes);

      const saved = await waitFor(() => {
        const current = new ChatStore(getSqlite()).get(threadId);
        return current?.runtimeModel ? current : null;
      });
      expect(saved.runtimeModel).toBe("qwen4-max");
      const lastAssistant = [...saved.messages].reverse().find((m) => m.role === "assistant");
      expect(lastAssistant?.model).toBe("qwen4-max");

      const listRes = await req("GET", "/chat/threads");
      const listed = (await listRes.json()) as {
        threads: { id: string; runtimeModel?: string | null }[];
      };
      expect(listed.threads.find((t) => t.id === threadId)?.runtimeModel).toBe("qwen4-max");

      const st = chatStatus(threadId);
      expect(st.runtime_model).toBe("qwen4-max");

      const jsonl = [
        JSON.stringify({
          type: "user",
          timestamp: "2026-11-26T10:00:00Z",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-26T10:00:01Z",
          message: {
            id: "msg-1",
            model: "qwen4-max",
            role: "assistant",
            content: [{ type: "text", text: "hi from qwen" }],
          },
        }),
      ].join("\n");
      const turns = await parseTranscriptContent(jsonl, "claude", "cache-qwen", "v1");
      const history = chatHistory(turns, "claude", "opus");
      expect(history.find((m) => m.role === "assistant")?.model).toBe("qwen4-max");
    } finally {
      registerBackend("claude", () => originalClaude);
    }
  });

  test("#567: background_task defers idle watchdog, exposes background_tasks on status, and retries empty resumed turn", async () => {
    const restoreLimits = setChatTurnLimits({ idleMs: 120, recheckMs: 40 });
    const gate: { releaseBg: (() => void) | null } = { releaseBg: null };
    const bgGate = new Promise<void>((resolve) => {
      gate.releaseBg = resolve;
    });
    let startCalls = 0;
    let resumeCalls = 0;

    const backend: AgentBackend = {
      name: "claude",
      preflight: async () => ({ ok: true }),
      stop: async () => {},
      startSession: async () => {
        startCalls++;
        const call = startCalls;
        return {
          id: `s-bg-${call}`,
          alive: () => true,
          send: async () => {},
          respondPermission: () => {},
          close: async () => {},
          async *events(): AsyncIterable<AgentEvent> {
            if (call === 1) {
              yield {
                type: "background_task",
                data: {
                  id: "bg-ci",
                  kind: "shell",
                  description: "bun run ci:pr",
                  command: "bun run ci:pr",
                  startedAt: Date.now(),
                  status: "running",
                },
              };
              await bgGate;
              yield {
                type: "background_task",
                data: {
                  id: "bg-ci",
                  kind: "shell",
                  description: "bun run ci:pr",
                  command: "bun run ci:pr",
                  startedAt: Date.now() - 250,
                  finishedAt: Date.now(),
                  status: "completed",
                },
              };
              yield { type: "text", data: "Validation gate succeeded." };
              yield {
                type: "result",
                data: { runtimeSessionId: "rt-bg-1", durationMs: 260 },
              };
            } else {
              yield { type: "text", data: "Recovered answer after empty resume." };
              yield {
                type: "result",
                data: { runtimeSessionId: "rt-bg-recovered", durationMs: 30 },
              };
            }
          },
        };
      },
      resumeSession: async () => {
        resumeCalls++;
        return {
          id: "s-empty-resume",
          alive: () => true,
          send: async () => {},
          respondPermission: () => {},
          close: async () => {},
          async *events(): AsyncIterable<AgentEvent> {
            yield {
              type: "result",
              data: { runtimeSessionId: "rt-bg-1", durationMs: 5 },
            };
          },
        };
      },
    };

    registerBackend("claude", () => backend);
    try {
      const turn1Promise = req("POST", "/chat/stream", {
        agent: "claude",
        model: "",
        workspace: { cwd: workDir },
        messages: [{ role: "user", content: "Run gate" }],
      });

      const found = await waitFor(() => {
        const list = new ChatStore(getSqlite()).list();
        for (const row of list) {
          try {
            const st = chatStatus(row.id);
            if (st.background_tasks?.some((t) => t.id === "bg-ci" && t.status === "running"))
              return { id: row.id, status: st };
          } catch {}
        }
        return null;
      });
      const threadId = found.id;
      expect(found.status.status).toBe("running");
      expect(found.status.background_tasks?.[0]?.description).toBe("bun run ci:pr");

      const midTurnRow = new ChatStore(getSqlite()).get(threadId);
      expect(midTurnRow?.turn?.backgroundTasks).toEqual([
        { kind: "shell", id: "bg-ci", label: "bun run ci:pr" },
      ]);

      // Wait longer than idleMs (120ms) while background task is running — watchdog must NOT kill it!
      await Bun.sleep(220);
      expect(chatStatus(threadId).status).toBe("running");

      gate.releaseBg?.();
      const res1 = await turn1Promise;
      expect(res1.status).toBe(200);
      await res1.text();

      const after1 = await waitFor(() => {
        const st = chatStatus(threadId);
        return st.status === "idle" ? st : null;
      });
      expect(after1.last_message).toContain("Validation gate succeeded.");

      // Turn 2: resume returns an empty result -> must automatically retry via transcript handoff!
      const res2 = await req("POST", "/chat/stream", {
        threadId,
        messages: [{ role: "user", content: "Follow up" }],
      });
      expect(res2.status).toBe(200);
      await res2.text();

      const after2 = await waitFor(() => {
        const st = chatStatus(threadId);
        return st.status === "idle" && st.last_message?.includes("Recovered answer") ? st : null;
      });
      expect(resumeCalls).toBe(1);
      expect(startCalls).toBe(2);
      expect(after2.last_message).toBe("Recovered answer after empty resume.");
    } finally {
      restoreLimits();
      registerBackend("claude", () => originalClaude);
    }
  });

  test("#566: resident session pools across turns, handles unexpected idle exit -> interrupted + recovery note, and lease reconcile preserves lostBackgroundWork", async () => {
    let startCount = 0;
    const promptsReceived: string[] = [];
    const hooks: { exitTrigger: ((info: AgentUnexpectedExit) => void) | null } = {
      exitTrigger: null,
    };
    let alive = true;

    const backend: AgentBackend = {
      name: "claude",
      preflight: async () => ({ ok: true }),
      stop: async () => {},
      startSession: async (opts) => {
        startCount++;
        const sid = opts.runtimeSessionId ?? `rt-res-${startCount}`;
        alive = true;
        let lastPrompt = "";
        const session: AgentSession = {
          id: `res-${startCount}`,
          reusable: true,
          alive: () => alive,
          canStopRuntime: () => true,
          onUnexpectedExit: (cb) => {
            hooks.exitTrigger = cb;
            return () => {
              if (hooks.exitTrigger === cb) hooks.exitTrigger = null;
            };
          },
          send: async (prompt) => {
            lastPrompt = prompt;
            promptsReceived.push(prompt);
          },
          respondPermission: () => {},
          close: async () => {
            alive = false;
          },
          async *events(): AsyncIterable<AgentEvent> {
            yield { type: "text", data: `ack:${lastPrompt.slice(-10)}` };
            yield {
              type: "result",
              data: { runtimeSessionId: sid, durationMs: 10 },
            };
          },
        };
        return session;
      },
      resumeSession: async (runtimeSessionId, opts) => {
        return backend.startSession({ ...opts, runtimeSessionId });
      },
    };

    registerBackend("claude", () => backend);
    try {
      const r1 = await req("POST", "/chat/stream", {
        agent: "claude",
        model: "",
        workspace: { cwd: workDir },
        messages: [{ role: "user", content: "turn-one" }],
      });
      const threadId = await parseSseThreadId(r1);
      await waitFor(() => (chatStatus(threadId).status === "idle" ? true : null));

      const r2 = await req("POST", "/chat/stream", {
        threadId,
        messages: [{ role: "user", content: "turn-two" }],
      });
      await r2.text();
      await waitFor(() => (chatStatus(threadId).status === "idle" ? true : null));

      // Resident session reused across turns: only 1 startSession call!
      expect(startCount).toBe(1);

      // Simulate unexpected provider crash while parked idle with lost background work
      alive = false;
      hooks.exitTrigger?.({
        code: null,
        signal: "SIGKILL",
        stderr: "killed",
        lostBackgroundWork: [{ kind: "shell", id: "bg-1", label: "bun run ci:pr" }],
      });

      const interrupted: SessionStatus = chatStatus(threadId);
      expect(interrupted.status).toBe("interrupted");
      expect(interrupted.interruption_reason).toContain("bun run ci:pr");

      // Next turn injects <orc-recovery> note and clears lostBackgroundWork
      const r3 = await req("POST", "/chat/stream", {
        threadId,
        messages: [{ role: "user", content: "turn-three" }],
      });
      await r3.text();
      await waitFor(() => (chatStatus(threadId).status === "idle" ? true : null));

      expect(promptsReceived[2]).toContain("<orc-recovery>");
      expect(promptsReceived[2]).toContain("bun run ci:pr");
      expect(new ChatStore(getSqlite()).get(threadId)?.lostBackgroundWork).toBeUndefined();

      // Reconcile stale running lease with active backgroundTasks on daemon boot
      const crashStore = new ChatStore(getSqlite());
      const crashThread = ChatThreadSchema.parse({
        id: crypto.randomUUID(),
        title: "Crash Boot Test",
        config: { agent: "claude", model: "" },
        cwd: workDir,
        host: null,
        runtimeId: "rt-boot-1",
        backend: "claude",
        sourceId: null,
        messages: [],
        turn: {
          runId: crypto.randomUUID(),
          startedAt: Date.now() - 5000,
          status: "running",
          pid: 999_999_999,
          backgroundTasks: [{ kind: "shell", id: "bg-boot", label: "bun run ci:full" }],
        },
        updatedAt: Date.now(),
      });
      crashStore.save(crashThread);

      const reconciled = await reconcileChatTurnLeases({ db: getSqlite() });
      expect(reconciled.interrupted).toBe(1);
      const afterBoot = chatStatus(crashThread.id);
      expect(afterBoot.status).toBe("interrupted");
      expect(afterBoot.interruption_reason).toContain("bun run ci:full");
      expect(crashStore.get(crashThread.id)?.lostBackgroundWork?.cause).toBe("server_restart");
    } finally {
      registerBackend("claude", () => originalClaude);
    }
  });

  test("#566: /api/background-jobs starts, inspects, logs, and stops detached shell jobs", async () => {
    const command =
      process.platform === "win32"
        ? 'echo "detached-ok" & ping -n 21 127.0.0.1 >nul'
        : 'echo "detached-ok"; sleep 20';
    const startRes = await req("POST", "/background-jobs", {
      command,
      cwd: workDir,
      label: "api detached test",
    });
    expect(startRes.status).toBe(201);
    const created = (await startRes.json()) as { id: string; status: string };
    expect(created.status).toBe("running");

    try {
      const withLog = await waitFor(async () => {
        const res = await req("GET", `/background-jobs/${created.id}?logs=true`);
        const body = (await res.json()) as { log_tail?: string };
        return body.log_tail?.includes("detached-ok") ? body : null;
      });
      expect(withLog.log_tail).toContain("detached-ok");

      const listRes = await req("GET", "/background-jobs");
      expect(listRes.status).toBe(200);
      const listed = (await listRes.json()) as { jobs: { id: string }[] };
      expect(listed.jobs.some((j) => j.id === created.id)).toBe(true);

      const stopRes = await req("POST", `/background-jobs/${created.id}/stop`);
      expect(stopRes.status).toBe(200);
      const stopped = (await stopRes.json()) as { status: string };
      expect(stopped.status).toBe("stopped");
    } finally {
      await req("POST", `/background-jobs/${created.id}/stop`).catch(() => undefined);
    }
  });
});
