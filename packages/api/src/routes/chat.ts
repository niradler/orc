import { createRoute, z } from "@hono/zod-openapi";
import {
  type AgentSession,
  createBackend,
  discoverAgentModels,
  type SessionOpts,
} from "@orc/agent-runtime";
import {
  appendChatActivity,
  CHAT_HISTORY_PAGE_SIZE,
  ChatAnswersSchema,
  type ChatEvent,
  ChatHistoryPageSchema,
  type ChatMessage,
  ChatModelSchema,
  type ChatModels,
  ChatModelsSchema,
  ChatPermissionModeSchema,
  type ChatQuestion,
  ChatSettingsSchema,
  type ChatThread,
  ChatThreadSchema,
} from "@orc/core/chat";
import { ChatAgentOptionsMapSchema } from "@orc/core/chat-options";
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
  {
    session: AgentSession | null;
    permissions: Set<string>;
    questions: Map<string, ChatQuestion>;
    threadId: string;
    key: string;
  }
>();
const active = new Set<string>();
const params = z.object({ id });
const modelCatalogs = new Map<string, { at: number; result: Promise<ChatModels> }>();
let modelRequests = 0;

function requireThread(id: string): ChatThread {
  const thread = store().get(id);
  if (!thread) throw new NotFoundError("Chat", id);
  return thread;
}

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/models",
    tags: ["Chat"],
    request: {
      query: z
        .object({ agent: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i), threadId: id.optional() })
        .strict(),
    },
    responses: {
      200: {
        description: "Models reported by the selected coding agent",
        content: { "application/json": { schema: ChatModelsSchema } },
      },
    },
  }),
  async (c) => {
    const { agent, threadId } = c.req.valid("query");
    const thread = threadId ? requireThread(threadId) : null;
    if (thread && thread.config.agent !== agent)
      throw new ValidationError("The agent does not match this conversation.");
    if (agent !== "codex" && agent !== "claude")
      return c.json({ models: [], warning: "Choose a saved model or enter a custom model ID." });
    const host = thread ? execHostFor(thread.host) : resolveExecHost();
    const cwd = thread?.cwd ?? (host.kind === "ssh" ? await hostHome(host) : process.cwd());
    const key = JSON.stringify([agent, host.kind === "ssh" ? host.alias : null, cwd]);
    const cached = modelCatalogs.get(key);
    if (cached && Date.now() - cached.at < 120_000) return c.json(await cached.result);
    if (modelRequests >= 2)
      return c.json({
        models: [],
        warning: "Model discovery is busy. Saved and custom models are still available.",
      });
    modelRequests++;
    const result = discoverAgentModels(agent, host, cwd)
      .then(
        (models): ChatModels => ({
          models,
          warning: models.length
            ? null
            : "No models were reported. Choose a saved or custom model.",
        }),
      )
      .catch(
        (): ChatModels => ({
          models: [],
          warning: "Models could not be loaded from this agent. Choose a saved or custom model.",
        }),
      )
      .finally(() => {
        modelRequests--;
      });
    if (modelCatalogs.size >= 32) {
      const oldest = modelCatalogs.keys().next().value;
      if (oldest !== undefined) modelCatalogs.delete(oldest);
    }
    modelCatalogs.set(key, { at: Date.now(), result });
    return c.json(await result);
  },
);

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
        { offset: 0, limit: CHAT_HISTORY_PAGE_SIZE },
      );
      if (transcript.total > CHAT_HISTORY_PAGE_SIZE)
        transcript = await readTranscriptBytes(
          bytes,
          source.backend,
          `${thread.host ?? "local"}:${source.transcript_path}`,
          { offset: transcript.total - CHAT_HISTORY_PAGE_SIZE, limit: CHAT_HISTORY_PAGE_SIZE },
        );
      thread.messages = chatHistory(transcript.turns, source.backend);
      thread.importedMessages = thread.messages.length;
      thread.historyBefore = transcript.offset > 0 ? transcript.offset : null;
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
    method: "patch",
    path: "/chat/threads/{id}/config",
    tags: ["Chat"],
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z.object({ agentOptions: ChatAgentOptionsMapSchema }).strict(),
          },
        },
      },
    },
    responses: response,
  }),
  (c) => {
    const thread = requireThread(c.req.valid("param").id);
    const key = thread.runtimeId
      ? `${thread.host ?? "local"}:${thread.backend}:${thread.runtimeId}`
      : thread.id;
    if (active.has(key) || [...runs.values()].some((run) => run.threadId === thread.id))
      throw new ConflictError("Wait for the agent to finish before changing launch options.");
    thread.config.agentOptions = c.req.valid("json").agentOptions;
    thread.updatedAt = Date.now();
    store().save(thread);
    return c.json(thread);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/threads/{id}/history",
    tags: ["Chat"],
    request: {
      params,
      query: z.object({ before: z.coerce.number().int().positive().max(2147483647) }),
    },
    responses: {
      200: {
        description: "Older native transcript messages",
        content: { "application/json": { schema: ChatHistoryPageSchema } },
      },
    },
  }),
  async (c) => {
    const thread = requireThread(c.req.valid("param").id);
    const { before } = c.req.valid("query");
    if (!thread.sourceId || before > (thread.historyBefore ?? 0))
      throw new ValidationError("No older history is available at this position.");
    const source = await getDb().query.gateway_sessions.findFirst({
      where: and(
        eq(gateway_sessions.id, thread.sourceId),
        eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      ),
    });
    if (
      !source?.transcript_path ||
      source.backend !== thread.config.agent ||
      source.runtime_session_id !== thread.runtimeId ||
      (source.execution_host ?? null) !== thread.host
    )
      throw new NotFoundError("Native transcript", thread.sourceId);
    const runtime = hostRuntime(execHostFor(thread.host));
    if (!(await runtime.isFile(source.transcript_path)))
      throw new NotFoundError("Native transcript", thread.sourceId);
    const bytes = await runtime.readFile(source.transcript_path, MAX_TRANSCRIPT_BYTES);
    const offset = Math.max(0, before - CHAT_HISTORY_PAGE_SIZE);
    const page = await readTranscriptBytes(
      bytes,
      source.backend,
      `${thread.host ?? "local"}:${source.transcript_path}`,
      { offset, limit: before - offset },
    );
    if (page.total < before)
      throw new ConflictError(
        "The native transcript changed. Reopen the session to load its history.",
      );
    return c.json({
      messages: chatHistory(page.turns, source.backend),
      before: offset > 0 ? offset : null,
    });
  },
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
    if (!run?.session || !run.permissions.has(requestId))
      throw new ConflictError("This permission request is no longer pending.");
    run.session.respondPermission(requestId, decision);
    run.permissions.delete(requestId);
    return c.json({ ok: true });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/chat/runs/{id}/answer",
    tags: ["Chat"],
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ requestId: z.string().min(1).max(256), answers: ChatAnswersSchema })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Answer delivered to the agent",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
    },
  }),
  async (c) => {
    const run = runs.get(c.req.valid("param").id);
    const { requestId, answers } = c.req.valid("json");
    const question = run?.questions.get(requestId);
    if (!run?.session?.respondQuestion || !question)
      throw new ConflictError("This question is no longer pending.");
    const ids = question.questions.map((question) => question.id);
    if (
      Object.keys(answers).length !== ids.length ||
      ids.some((id) => !answers[id]?.some((answer) => answer.trim()))
    )
      throw new ValidationError("Answer every question before continuing.");
    run.questions.delete(requestId);
    try {
      await run.session.respondQuestion(requestId, answers);
    } catch (error) {
      run.questions.set(requestId, question);
      throw error;
    }
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
    permissionMode: ChatPermissionModeSchema.optional(),
    agentOptions: ChatAgentOptionsMapSchema.optional(),
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
    if (JSON.stringify(thread.messages.slice(thread.importedMessages ?? 0)).length > 5000000)
      throw new ValidationError("This chat reached its history size limit. Start a new chat.");
    const key = thread.runtimeId
      ? `${thread.host ?? "local"}:${thread.backend}:${thread.runtimeId}`
      : thread.id;
    if (active.has(key) || [...runs.values()].some((run) => run.threadId === thread.id))
      throw new ConflictError("This session is already responding.");
    if (body.agentOptions !== undefined) thread.config.agentOptions = body.agentOptions;
    if (body.permissionMode !== undefined) {
      if (!["codex", "claude"].includes(thread.config.agent))
        throw new ValidationError("Permission modes are supported by Claude and Codex.");
      thread.config.permissionMode = body.permissionMode;
    }
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
      questions: new Map<string, ChatQuestion>(),
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
            chatAgentOptions: thread.config.agentOptions[thread.config.agent],
            interactive: true,
            cwd: thread.cwd,
            executionHost: thread.host,
            autoApprove: thread.config.autoApprove,
            permissionMode: ["claude", "codex"].includes(thread.config.agent)
              ? thread.config.permissionMode
              : undefined,
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
            } else if (event.type === "question_request") {
              run.questions.set(event.data.requestId, event.data);
              await emit(event);
            } else if (event.type === "request_resolved") {
              run.permissions.delete(event.data.requestId);
              run.questions.delete(event.data.requestId);
              await emit({ type: "request_resolved", requestId: event.data.requestId });
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
          if (!stopped)
            await s
              .writeSSE({ data: JSON.stringify({ type: "session", runtimeId: thread.runtimeId }) })
              .catch(close);
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
