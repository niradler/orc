import { createRoute, z } from "@hono/zod-openapi";
import { type AgentSession, createBackend, type SessionOpts } from "@orc/agent-runtime";
import {
  appendChatActivity,
  type ChatEvent,
  type ChatMessage,
  ChatModelSchema,
  ChatSettingsSchema,
  type ChatThread,
  ChatThreadSchema,
} from "@orc/core/chat";
import { loadConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, OrcError, ValidationError } from "@orc/core/errors";
import { execHostFor, hostHome, hostRuntime, resolveExecHost } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { getHandoffService } from "../handoffs/service.js";
import { createRouter } from "../lib/router.js";
import { LIVE_CHAT_ID } from "../session-watcher.js";
import { chatHistory } from "../sessions/chat-history.js";
import { MAX_TRANSCRIPT_BYTES, readTranscriptBytes } from "../sessions/transcript.js";

const logger = createLogger("api:chat");
const app = createRouter();
const id = z.string().uuid();
const response = {
  200: {
    description: "Chat conversation",
    content: { "application/json": { schema: ChatThreadSchema } },
  },
};
const store = () => new ChatStore(getSqlite());
const runs = new Map<
  string,
  { session: AgentSession | null; permissions: Set<string>; threadId: string; key: string }
>();
const active = new Set<string>();
const params = z.object({ id });

function requireThread(id: string): ChatThread {
  const thread = store().get(id);
  if (!thread) throw new NotFoundError("Chat", id);
  return thread;
}

async function newThread(agent?: string, model?: string, sourceId?: string): Promise<ChatThread> {
  const config = ChatSettingsSchema.parse(loadConfig().preferences.chat ?? {});
  if (agent) config.agent = agent;
  if (model !== undefined) config.model = model;
  const host = resolveExecHost();
  const thread: ChatThread = {
    id: crypto.randomUUID(),
    title: "New chat",
    config,
    backend: config.agent === "codex" ? "codex-cli" : config.agent === "claude" ? "claude" : "acpx",
    runtimeId: null,
    cwd: host.kind === "ssh" ? await hostHome(host) : process.cwd(),
    host: host.kind === "ssh" ? host.alias : null,
    sourceId: sourceId ?? null,
    messages: [],
    updatedAt: Date.now(),
  };
  if (sourceId) {
    const source = await getDb().query.gateway_sessions.findFirst({
      where: and(eq(gateway_sessions.id, sourceId), eq(gateway_sessions.chat_id, LIVE_CHAT_ID)),
    });
    if (!source) throw new NotFoundError("Session", sourceId);
    if (!["claude", "codex"].includes(source.backend))
      throw new ValidationError(
        "Chat resume currently supports Claude and Codex. Use Terminals to resume other agents.",
      );
    if (
      !source.runtime_session_id ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(source.runtime_session_id) ||
      !source.cwd
    )
      throw new ValidationError("Session has no valid native session identity or working folder.");
    if (source.status === "running" || source.status === "idle")
      throw new ConflictError("End the original agent session before resuming it in chat.");
    await getHandoffService().verifyResume(source.id);
    const runtime = hostRuntime(execHostFor(source.execution_host ?? null));
    if (!(await runtime.isDirectory(source.cwd)))
      throw new ValidationError("The session working folder is unavailable on its execution host.");
    thread.config.agent = source.backend;
    thread.config.model = model ?? source.model ?? "";
    thread.backend = source.backend === "codex" ? "codex-cli" : "claude";
    thread.runtimeId = source.runtime_session_id;
    thread.cwd = source.cwd;
    thread.host = source.execution_host ?? null;
    thread.title = source.title ?? "Resumed session";
    if (source.transcript_path && (await runtime.isFile(source.transcript_path))) {
      const bytes = await runtime.readFile(source.transcript_path, MAX_TRANSCRIPT_BYTES);
      let transcript = await readTranscriptBytes(
        bytes,
        source.backend,
        `${thread.host ?? "local"}:${source.transcript_path}`,
        { offset: 0, limit: 200 },
      );
      if (transcript.total > 100)
        transcript = await readTranscriptBytes(
          bytes,
          source.backend,
          `${thread.host ?? "local"}:${source.transcript_path}`,
          { offset: transcript.total - 100, limit: 100 },
        );
      thread.messages = chatHistory(transcript.turns, source.backend);
    }
  }
  return thread;
}

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/threads",
    tags: ["Chat"],
    responses: {
      200: {
        description: "Recent chats",
        content: {
          "application/json": {
            schema: z.object({
              threads: z.array(z.object({ id, title: z.string(), updatedAt: z.number() })),
            }),
          },
        },
      },
    },
  }),
  (c) => c.json({ threads: store().list() }),
);
app.openapi(
  createRoute({
    method: "get",
    path: "/chat/threads/{id}",
    tags: ["Chat"],
    request: { params },
    responses: response,
  }),
  (c) => c.json(requireThread(c.req.valid("param").id)),
);
app.openapi(
  createRoute({
    method: "post",
    path: "/chat/threads",
    tags: ["Chat"],
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({ sourceSessionId: z.string().min(1).max(256) }).strict(),
          },
        },
      },
    },
    responses: response,
  }),
  async (c) => {
    const source = c.req.valid("json").sourceSessionId;
    const thread = await newThread(undefined, undefined, source);
    store().save(thread);
    return c.json(thread);
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/chat/runs/{id}/permission",
    tags: ["Chat"],
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                requestId: z.string().min(1).max(256),
                decision: z.enum(["approved", "denied"]),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Permission resolved",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
    },
  }),
  (c) => {
    const run = runs.get(c.req.valid("param").id);
    const { requestId, decision } = c.req.valid("json");
    if (!run?.session || !run.permissions.delete(requestId))
      throw new ConflictError("This permission request is no longer pending.");
    run.session.respondPermission(requestId, decision);
    return c.json({ ok: true });
  },
);

const requestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant", "system"]),
            content: z.string().max(500000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    agent: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/i)
      .optional(),
    model: ChatModelSchema.optional(),
    threadId: id.optional(),
    // Retained for older clients; server settings own the effective prompt and permissions.
    system: z.string().max(20000).optional(),
    autoApprove: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => body.messages.reduce((sum, message) => sum + message.content.length, 0) <= 500000,
    "messages content too large (max 500k chars)",
  );
app.openapi(
  createRoute({
    method: "post",
    path: "/chat/stream",
    tags: ["Chat"],
    request: { body: { content: { "application/json": { schema: requestSchema } } } },
    responses: {
      200: {
        description: "Chat events, activity, permissions and conversation identity",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
  async (c) => {
    const body = c.req.valid("json");
    const thread = body.threadId
      ? requireThread(body.threadId)
      : await newThread(body.agent, body.model);
    if (body.threadId && body.agent && body.agent !== thread.config.agent)
      throw new ValidationError("Start a new chat to change agents.");
    if (body.threadId && thread.messages.length && !thread.runtimeId)
      throw new ConflictError(
        "The previous turn did not establish a resumable session. Start a new chat.",
      );
    if (body.model !== undefined) thread.config.model = body.model;
    if (
      thread.backend !== "claude" &&
      loadConfig().rules.enabled &&
      new RuleStore(getSqlite()).active(thread.cwd).length > 0
    )
      throw new OrcError(
        "Protected workspace requires the Claude SDK rule adapter; CLI/remote chat fallback is refused",
        "CHAT_RULE_ADAPTER",
        503,
      );
    const input = [...body.messages]
      .reverse()
      .find((message) => message.role === "user")
      ?.content.trim();
    if (!input) throw new ValidationError("A user message is required.");
    if (thread.messages.length >= 200)
      throw new ValidationError("This chat reached its message limit. Start a new chat.");
    if (JSON.stringify(thread.messages).length > 5000000)
      throw new ValidationError("This chat reached its history size limit. Start a new chat.");
    const key = thread.runtimeId
      ? `${thread.host ?? "local"}:${thread.backend}:${thread.runtimeId}`
      : thread.id;
    if (active.has(key) || [...runs.values()].some((run) => run.threadId === thread.id))
      throw new ConflictError("This session is already responding.");
    if (runs.size >= 4)
      throw new ConflictError("All chat workers are busy. Try again when a response finishes.");
    const mock = process.env.ORC_E2E_CHAT_MOCK === "1";
    if (!mock && thread.backend === "acpx" && thread.config.mcp === "orc")
      throw new ValidationError(
        "The ORC MCP connection is supported by Claude and Codex. Select host configuration in Settings to use other agents.",
      );
    const backend = createBackend(thread.backend);
    active.add(key);
    const runId = crypto.randomUUID();
    const run = {
      session: null as AgentSession | null,
      permissions: new Set<string>(),
      threadId: thread.id,
      key,
    };
    runs.set(runId, run);
    try {
      if (!mock) {
        const check = await backend.preflight({ executionHost: thread.host });
        if (!check.ok) throw new ValidationError(check.error ?? "This agent is unavailable.");
      }
    } catch (error) {
      active.delete(key);
      runs.delete(runId);
      throw error;
    }
    thread.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      content: input,
      timestamp: Date.now(),
    });
    if (thread.title === "New chat") thread.title = input.slice(0, 100);
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      agent: thread.config.agent,
      activity: [],
    };
    thread.updatedAt = Date.now();
    try {
      store().save(thread);
    } catch (error) {
      active.delete(key);
      runs.delete(runId);
      throw error;
    }
    return streamSSE(c, async (s) => {
      let stopped = false;
      const close = () => {
        stopped = true;
        void run.session?.close().catch(() => {});
      };
      s.onAbort(close);
      c.req.raw.signal.addEventListener("abort", close, { once: true });
      if (c.req.raw.signal.aborted) close();
      const ping = setInterval(() => {
        void s.writeSSE({ data: JSON.stringify({ type: "ping" }) }).catch(close);
      }, 25000);
      const timer = setTimeout(close, 15 * 60000);
      const emit = async (event: ChatEvent) => {
        if (event.type === "text") assistant.content += event.text;
        assistant.activity = appendChatActivity(assistant.activity ?? [], event);
        await s.writeSSE({ data: JSON.stringify(event) });
      };
      try {
        await emit({ type: "thread", thread, runId });
        if (mock) {
          await Bun.sleep(75);
          if (!stopped)
            await emit({
              type: "text",
              text: input.match(/Reply with exactly:\s*([^.?!\n]+)[.?!]?/i)?.[1]?.trim() || input,
            });
          await Bun.sleep(75);
          thread.runtimeId ??= `mock-${thread.id}`;
        } else {
          const opts: SessionOpts = {
            cwd: thread.cwd,
            executionHost: thread.host,
            autoApprove: thread.config.autoApprove,
            model: thread.config.model || undefined,
            systemPromptAppend: thread.config.system,
            orcMcp: thread.config.mcp === "orc",
            mcpAlwaysLoad: true,
            acpxAgent: thread.config.agent,
          };
          if (thread.sourceId) await getHandoffService().verifyResume(thread.sourceId);
          run.session = thread.runtimeId
            ? await backend.resumeSession(thread.runtimeId, opts)
            : await backend.startSession(opts);
          if (stopped) return;
          const prompt =
            thread.backend === "acpx"
              ? [thread.config.system, input].filter(Boolean).join("\n\n")
              : input;
          await run.session.send(prompt);
          let receivedResult = false;
          let outputBytes = 0;
          for await (const event of run.session.events()) {
            if (stopped) break;
            outputBytes += JSON.stringify(event).length;
            if (outputBytes > 2000000) throw new Error("Response exceeded the chat output limit.");
            if (event.type === "result") {
              if (
                event.data.runtimeSessionId &&
                !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(event.data.runtimeSessionId)
              )
                throw new Error("The agent returned an invalid session identity.");
              if (
                thread.runtimeId &&
                event.data.runtimeSessionId &&
                thread.runtimeId !== event.data.runtimeSessionId
              )
                throw new Error(
                  "The agent returned a different session instead of resuming this conversation. The original session identity was kept.",
                );
              thread.runtimeId = event.data.runtimeSessionId ?? thread.runtimeId;
              if (thread.sourceId) await getHandoffService().markResumed(thread.sourceId);
              receivedResult = true;
              break;
            }
            if (
              event.type === "text" ||
              event.type === "thinking" ||
              event.type === "system_status"
            )
              await emit({ type: event.type, text: event.data });
            else if (event.type === "tool_use" || event.type === "tool_result") await emit(event);
            else if (event.type === "permission_request") {
              run.permissions.add(event.data.requestId);
              await emit(event);
            } else if (event.type === "error") await emit({ type: "error", message: event.data });
          }
          if (!receivedResult && !stopped)
            await emit({
              type: "error",
              message:
                "The agent ended before completing the turn. Start a new chat if the session cannot be resumed.",
            });
          if (receivedResult && !thread.runtimeId)
            await emit({
              type: "error",
              message:
                "The agent returned no session identity; this conversation cannot continue safely.",
            });
        }
      } catch (error) {
        logger.error("Chat turn failed", { error, runId });
        if (!stopped)
          await emit({
            type: "error",
            message:
              error instanceof Error ? error.message : "The agent could not complete the response.",
          }).catch(() => {});
      } finally {
        clearInterval(ping);
        clearTimeout(timer);
        c.req.raw.signal.removeEventListener("abort", close);
        const nativeId = run.session?.getRuntimeSessionId?.();
        if (!thread.runtimeId && nativeId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(nativeId))
          thread.runtimeId = nativeId;
        await run.session?.close().catch(() => {});
        if (assistant.content || assistant.activity?.length) thread.messages.push(assistant);
        thread.updatedAt = Date.now();
        try {
          store().save(thread);
        } catch (error) {
          logger.error("Chat history could not be saved", { error, runId });
          if (!stopped)
            await s
              .writeSSE({
                data: JSON.stringify({
                  type: "error",
                  message: "This response could not be saved. Start a new chat before continuing.",
                }),
              })
              .catch(() => {});
        } finally {
          active.delete(key);
          runs.delete(runId);
        }
        await s.writeSSE({ data: JSON.stringify({ type: "done" }) }).catch(() => {});
      }
    });
  },
);

export { app as chatRouter };
