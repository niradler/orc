import { createHash } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AgentSession,
  createBackend,
  discoverAgentModels,
  type SessionOpts,
  sessionRules,
} from "@orc/agent-runtime";
import { readAgent, renderAgentInstructions } from "@orc/core/agent-service";
import { changes } from "@orc/core/changes";
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
  ChatWorkspaceSchema,
  chatSystemPrompt,
  nativeChatAgent,
  nativeChatResumeUnavailableReason,
} from "@orc/core/chat";
import { ChatTurnContextSchema, withOrcContext } from "@orc/core/chat-context";
import { ChatAgentOptionsMapSchema } from "@orc/core/chat-options";
import { loadConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, OrcError, ValidationError } from "@orc/core/errors";
import { execHostFor, hostHome, hostRuntime, resolveExecHost } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import { AgentSetupSchema } from "@orc/core/package-launch";
import type { PushMessage } from "@orc/core/push";
import {
  type SessionFile,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  type UploadFile,
} from "@orc/core/session-file-types";
import { storeSessionFiles, uploadPrompt } from "@orc/core/session-files";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { RuleStore } from "@orc/db/rules";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { rememberTerminalFolder } from "../git/registry.js";
import { getHandoffService } from "../handoffs/service.js";
import { installPackageForChat } from "../lib/package-launch.js";
import { createRouter } from "../lib/router.js";
import { notify, truncate } from "../push/service.js";
import { LIVE_CHAT_ID } from "../session-watcher.js";
import { chatHistory } from "../sessions/chat-history.js";
import { codexWriterOwned } from "../sessions/ownership.js";
import { MAX_TRANSCRIPT_BYTES, readTranscriptBytes } from "../sessions/transcript.js";
import { selectedTerminalHost } from "../terminals/host.js";
import { launchDeps, sessionDirDeps } from "../terminals/service.js";
import { prepareSessionDirectory } from "../terminals/session-dir.js";

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
interface ChatRun {
  session: AgentSession | null;
  permissions: Set<string>;
  questions: Map<string, ChatQuestion>;
  threadId: string;
  /** The streaming turn saves this object when it ends, so live changes must land on it. */
  thread: ChatThread;
  key: string;
  /** Serialized events of this turn, replayed to every client that attaches. */
  events: string[];
  /** Attached clients; `null` marks the end of the turn. */
  listeners: Set<(data: string | null) => void>;
  stop: () => void;
}
const runs = new Map<string, ChatRun>();

const waitingKey = (id: string) => createHash("sha256").update(id).digest("hex");

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/waiting",
    tags: ["Chat"],
    responses: {
      200: {
        description: "Active chat requests without private question or answer content",
        content: {
          "application/json": {
            schema: z.object({
              waiting: z.array(
                z.object({
                  thread_id: id,
                  title: z.string(),
                  agent: z.string(),
                  request_key: z.string(),
                  kind: z.enum(["question", "approval"]),
                  native_session_id: z.string().nullable(),
                  host: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  (c) =>
    c.json(
      {
        waiting: [...runs.values()].flatMap((run) => {
          const base = {
            thread_id: run.threadId,
            title: run.thread.title,
            agent: run.thread.config.agent,
            host: run.thread.host,
            native_session_id: run.session?.getRuntimeSessionId?.() ?? run.thread.runtimeId ?? null,
          };
          return [
            ...[...run.permissions].map((id) => ({
              ...base,
              request_key: waitingKey(id),
              kind: "approval" as const,
            })),
            ...[...run.questions.keys()].map((id) => ({
              ...base,
              request_key: waitingKey(id),
              kind: "question" as const,
            })),
          ];
        }),
      },
      200,
    ),
);

function publish(run: ChatRun, event: ChatEvent): void {
  const data = JSON.stringify(event);
  run.events.push(data);
  for (const listener of run.listeners) listener(data);
}

// The turn runs independently of its clients: closing a stream only detaches that client.
function follow(c: Context, run: ChatRun) {
  return streamSSE(c, async (s) => {
    let write = Promise.resolve();
    let end = () => {};
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const send = (data: string) => {
      write = write.then(() => s.writeSSE({ data })).catch(end);
    };
    const listener = (data: string | null) => (data === null ? end() : send(data));
    for (const data of run.events) send(data);
    run.listeners.add(listener);
    s.onAbort(end);
    const ping = setInterval(() => send(JSON.stringify({ type: "ping" })), 25000);
    await ended;
    clearInterval(ping);
    run.listeners.delete(listener);
    await write;
  });
}

function threadRun(threadId: string): [string, ChatRun] | undefined {
  return [...runs].find(([, run]) => run.threadId === threadId);
}
const active = new Set<string>();
const params = z.object({ id });
const modelCatalogs = new Map<string, { at: number; result: Promise<ChatModels> }>();
let modelRequests = 0;

function requireThread(id: string): ChatThread {
  const thread = store().get(id);
  if (!thread) throw new NotFoundError("Chat", id);
  return thread;
}

function chatPush(thread: ChatThread, status: string, body: string): PushMessage {
  return {
    title: `${status} · ${truncate(thread.title, 120)}`,
    body,
    url: `/?chat=open&chatThread=${encodeURIComponent(thread.id)}`,
    tag: `chat:${thread.id}`,
  };
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

async function newThread(
  agent?: string,
  model?: string,
  sourceId?: string,
  launch?: {
    host?: string | null | undefined;
    cwd?: string | undefined;
    worktree?: boolean | undefined;
  },
): Promise<ChatThread> {
  const config = ChatSettingsSchema.parse(loadConfig().preferences.chat ?? {});
  if (agent) config.agent = agent;
  if (model !== undefined) config.model = model;
  const host = launch ? selectedTerminalHost(loadConfig(), launch.host) : resolveExecHost();
  const cwd = launch
    ? await prepareSessionDirectory(
        { ...launch, worktree: false },
        sessionDirDeps(await launchDeps(loadConfig(), host), host),
      )
    : host.kind === "ssh"
      ? await hostHome(host)
      : process.cwd();
  const thread: ChatThread = {
    id: crypto.randomUUID(),
    title: "New chat",
    config,
    backend: config.agent === "codex" ? "codex-cli" : config.agent === "claude" ? "claude" : "acpx",
    runtimeId: null,
    cwd,
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
    const agent = nativeChatAgent(source.backend);
    if (!agent)
      throw new ValidationError(
        nativeChatResumeUnavailableReason(source.backend) ?? "This session cannot resume in chat.",
      );
    if (
      !source.runtime_session_id ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(source.runtime_session_id) ||
      !source.cwd
    )
      throw new ValidationError("Session has no valid native session identity or working folder.");
    await getHandoffService().verifyResume(source.id);
    const runtime = hostRuntime(execHostFor(source.execution_host ?? null));
    if (
      source.backend !== "codex" &&
      (source.status === "running" || source.status === "idle") &&
      source.pid &&
      (await runtime.processAlive(source.pid))
    )
      throw new ConflictError(
        "This session is still open in its original agent. End it there before resuming in chat, or use Terminal.",
      );
    if (source.backend === "codex" && (await codexWriterOwned(runtime, source.runtime_session_id)))
      throw new ConflictError("End the original agent session before resuming it in chat.");
    if (!(await runtime.isDirectory(source.cwd)))
      throw new ValidationError("The session working folder is unavailable on its execution host.");
    thread.config.agent = agent;
    thread.config.model = model ?? source.model ?? "";
    thread.backend =
      source.backend === "codex" ? "codex-cli" : source.backend === "claude" ? "claude" : "acpx";
    if (source.project_id) thread.projectId = source.project_id;
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
              threads: z.array(
                z.object({
                  id,
                  title: z.string(),
                  updatedAt: z.number(),
                  running: z.boolean(),
                  agent: z.string().nullable().optional(),
                  runtimeId: z.string().nullable().optional(),
                  sourceId: z.string().nullable().optional(),
                  host: z.string().nullable().optional(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  (c) =>
    c.json({
      threads: store()
        .list()
        .map((thread) => ({ ...thread, running: !!threadRun(thread.id) })),
    }),
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
            schema: z.union([
              z.object({ sourceSessionId: z.string().min(1).max(256) }).strict(),
              z.object({ setup: AgentSetupSchema }).strict(),
            ]),
          },
        },
      },
    },
    responses: response,
  }),
  async (c) => {
    const body = c.req.valid("json");
    let thread: ChatThread;
    if ("setup" in body) {
      const setup = body.setup;
      if (!["claude", "codex"].includes(setup.backend))
        throw new ValidationError(
          "Package chat currently supports Claude and Codex. Use a terminal for Copilot.",
        );
      thread = await newThread(setup.backend, setup.model, undefined, setup);
      const host = selectedTerminalHost(loadConfig(), thread.host);
      if (setup.agent) {
        const profile = readAgent(setup.agent, host.kind === "local" ? setup.cwd : undefined);
        if (!profile) throw new NotFoundError("Agent", setup.agent);
        const tools = profile.fields.tools;
        if (tools !== undefined) {
          if (setup.backend !== "claude")
            throw new ValidationError(
              "Codex cannot enforce this agent's tool allowlist. Choose Claude.",
            );
          thread.toolAllowlist =
            typeof tools === "string"
              ? tools.split(/[\s,]+/).filter(Boolean)
              : Array.isArray(tools)
                ? tools
                : Object.entries(tools)
                    .filter(([, allowed]) => allowed)
                    .map(([name]) => name);
        }
        thread.config.model = setup.model ?? profile.fields.model ?? thread.config.model;
        thread.config.system = [thread.config.system, renderAgentInstructions(profile)]
          .filter(Boolean)
          .join("\n\n");
        if (!ChatSettingsSchema.safeParse(thread.config).success)
          throw new ValidationError(
            "The agent's combined chat instructions or model configuration exceed the supported limits",
          );
        thread.title = profile.name;
      }
      if (
        loadConfig().rules.enabled &&
        new RuleStore(getSqlite()).active(setup.cwd).length &&
        setup.packages.length
      )
        throw new ValidationError("Package installation cannot bypass protected workspace rules");
      thread.cwd = await installPackageForChat(setup, host);
    } else thread = await newThread(undefined, undefined, body.sourceSessionId);
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
    changes.publish("human-requests");
    return c.json({ ok: true });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/chat/runs/{id}/permission-mode",
    tags: ["Chat"],
    description:
      "Change permissions while the agent is responding. Prompts the new mode would not ask for, including pending ones, are approved; the mode is kept for later messages.",
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z.object({ mode: ChatPermissionModeSchema }).strict(),
          },
        },
      },
    },
    responses: response,
  }),
  (c) => {
    const run = runs.get(c.req.valid("param").id);
    if (!run) throw new ConflictError("This response already finished.");
    const { mode } = c.req.valid("json");
    const { thread } = run;
    if (!["codex", "claude"].includes(thread.config.agent))
      throw new ValidationError("Permission modes are supported by Claude and Codex.");
    const updated: ChatThread = {
      ...thread,
      config: structuredClone(thread.config),
      updatedAt: Date.now(),
    };
    updated.config.permissionMode = mode;
    // Explicit SDK launch options take precedence over the conversation mode.
    const options = updated.config.agentOptions[updated.config.agent];
    if (options?.runtime === "claude-sdk" && options.options.permissionMode)
      options.options.permissionMode = mode;
    getSqlite()
      .transaction(() => {
        store().save(updated);
        run.session?.setPermissionMode?.(mode);
      })
      .immediate();
    thread.config = updated.config;
    thread.updatedAt = updated.updatedAt;
    return c.json(thread);
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
    changes.publish("human-requests");
    return c.json({ ok: true });
  },
);

async function checkChatWorkspaceRules(thread: ChatThread, cwd = thread.cwd): Promise<void> {
  if (
    thread.backend === "claude" ||
    !loadConfig().rules.enabled ||
    !new RuleStore(getSqlite()).active(cwd).length
  )
    return;
  try {
    await sessionRules(thread.backend, { cwd, executionHost: thread.host });
  } catch (error) {
    throw new OrcError(
      error instanceof Error ? error.message : "This backend cannot enforce the workspace rules",
      "CHAT_RULE_ADAPTER",
      503,
    );
  }
}

const requestSchema = z
  .object({
    projectId: z.string().min(1).max(100).optional(),
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
    workspace: ChatWorkspaceSchema.optional(),
    // Retained for older clients; server settings own the effective prompt and permissions.
    system: z.string().max(20000).optional(),
    autoApprove: z.boolean().optional(),
    permissionMode: ChatPermissionModeSchema.optional(),
    agentOptions: ChatAgentOptionsMapSchema.optional(),
    // Where the user is chatting from. Sent to the agent only; the stored message stays the user's text.
    context: ChatTurnContextSchema.optional(),
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
  async (c) => streamChat(c, c.req.valid("json")),
);

let pendingUploads = 0;
app.use("/chat/uploads", async (_c, next) => {
  if (pendingUploads >= 4 || runs.size >= 4)
    throw new ConflictError("All upload workers are busy. Try again shortly.");
  pendingUploads++;
  try {
    await next();
  } finally {
    pendingUploads--;
  }
});
app.use("/chat/uploads", bodyLimit({ maxSize: UPLOAD_MAX_BYTES + 1_000_000 }));
const uploadFileSchema = z.instanceof(File).openapi({ type: "string", format: "binary" });
app.openapi(
  createRoute({
    method: "post",
    path: "/chat/uploads",
    tags: ["Chat"],
    request: {
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({
              payload: z.string().max(600000),
              files: z.union([uploadFileSchema, z.array(uploadFileSchema)]),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Chat events after saving attached files",
        content: { "text/event-stream": { schema: z.string() } },
      },
    },
  }),
  async (c) => {
    const form = c.req.valid("form");
    const files = Array.isArray(form.files) ? form.files : [form.files];
    if (
      !files.length ||
      files.length > UPLOAD_MAX_FILES ||
      files.reduce((sum, file) => sum + file.size, 0) > UPLOAD_MAX_BYTES
    )
      throw new ValidationError("Attach at most 10 files, totaling at most 20 MB");
    let payload: unknown;
    try {
      payload = JSON.parse(form.payload);
    } catch {
      throw new ValidationError("Invalid upload message");
    }
    const parsed = requestSchema.safeParse(payload);
    if (!parsed.success) throw new ValidationError("Invalid upload message");
    const body = parsed.data;
    const uploads: UploadFile[] = [];
    for (const file of files)
      uploads.push({
        name: file.name,
        mimeType: file.type,
        data: new Uint8Array(await file.arrayBuffer()),
      });
    return streamChat(c, body, uploads);
  },
);

async function streamChat(
  c: Context,
  body: z.infer<typeof requestSchema>,
  uploads: UploadFile[] = [],
) {
  const thread = body.threadId
    ? requireThread(body.threadId)
    : await newThread(body.agent, body.model, undefined, body.workspace);
  if (!body.threadId && body.projectId) thread.projectId = body.projectId;
  if (body.threadId && body.projectId && body.projectId !== thread.projectId)
    throw new ValidationError("An existing conversation keeps its project");
  const project = thread.projectId
    ? getSqlite()
        .query<{ upload_directory: string | null }, [string]>(
          "SELECT upload_directory FROM projects WHERE id=? AND status='active'",
        )
        .get(thread.projectId)
    : null;
  if (uploads.length && thread.projectId && !project)
    throw new ValidationError("Select an active project for uploads");
  if (body.threadId && body.workspace)
    throw new ValidationError("An existing conversation keeps its working folder.");
  rememberTerminalFolder(thread.cwd, thread.host);
  if (body.threadId && body.agent && body.agent !== thread.config.agent)
    throw new ValidationError("Start a new chat to change agents.");
  if (body.threadId && thread.messages.length && !thread.runtimeId)
    throw new ConflictError(
      "The previous turn did not establish a resumable session. Start a new chat.",
    );
  if (body.model !== undefined) thread.config.model = body.model;
  await checkChatWorkspaceRules(thread);
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
  const backend = createBackend(thread.backend);
  active.add(key);
  const runId = crypto.randomUUID();
  let stopped = false;
  let halt = () => {};
  const halted = new Promise<void>((resolve) => {
    halt = resolve;
  });
  const run: ChatRun = {
    session: null,
    permissions: new Set(),
    questions: new Map(),
    threadId: thread.id,
    thread,
    key,
    events: [],
    listeners: new Set(),
    stop: () => {
      stopped = true;
      halt();
      void run.session?.close().catch(() => {});
    },
  };
  runs.set(runId, run);
  let attachments: SessionFile[] = [];
  try {
    if (!mock) {
      const check = await backend.preflight({ executionHost: thread.host });
      if (!check.ok) throw new ValidationError(check.error ?? "This agent is unavailable.");
    }
    if (!body.threadId && body.workspace?.worktree) {
      const host = selectedTerminalHost(loadConfig(), thread.host);
      const cwd = await prepareSessionDirectory(
        { cwd: thread.cwd, worktree: true },
        {
          ...sessionDirDeps(await launchDeps(loadConfig(), host), host),
          validateDirectory: (path) => checkChatWorkspaceRules(thread, path),
        },
      );
      if (cwd === thread.cwd)
        throw new ValidationError("Choose a Git repository folder to create a worktree.");
      thread.cwd = cwd;
    }
    attachments = await storeSessionFiles({
      host: execHostFor(thread.host),
      cwd: thread.cwd,
      sessionId: thread.id,
      directory: project?.upload_directory ?? null,
      files: uploads,
    });
  } catch (error) {
    active.delete(key);
    runs.delete(runId);
    throw error;
  }
  thread.messages.push({
    id: crypto.randomUUID(),
    role: "user",
    content: input,
    ...(attachments.length ? { attachments } : {}),
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
  const execute = async () => {
    const timer = setTimeout(run.stop, 15 * 60000);
    const emit = async (event: ChatEvent) => {
      if (event.type === "text") assistant.content += event.text;
      assistant.activity = appendChatActivity(assistant.activity ?? [], event);
      publish(run, event);
    };
    try {
      await emit({ type: "thread", thread, runId });
      if (mock) {
        // "Respond after 2000ms" holds the mock turn open for background-run tests.
        await Promise.race([
          Bun.sleep(Math.min(Number(input.match(/after (\d+)ms/i)?.[1] ?? 75), 10000)),
          halted,
        ]);
        if (!stopped)
          await emit({
            type: "text",
            text: input.match(/Reply with exactly:\s*([^.?!\n]+)[.?!]?/i)?.[1]?.trim() || input,
          });
        await Bun.sleep(75);
        thread.runtimeId ??= `mock-${thread.id}`;
      } else {
        const opts: SessionOpts = {
          toolAllowlist: thread.toolAllowlist,
          chatAgentOptions: thread.config.agentOptions[thread.config.agent],
          interactive: true,
          attentionContext: { chatThreadId: thread.id, sessionTitle: thread.title },
          cwd: thread.cwd,
          executionHost: thread.host,
          autoApprove: thread.config.autoApprove,
          permissionMode: ["claude", "codex"].includes(thread.config.agent)
            ? thread.config.permissionMode
            : undefined,
          model: thread.config.model || undefined,
          systemPromptAppend: chatSystemPrompt(thread.config.system),
          orcMcp: thread.config.mcp === "orc",
          orcMcpMode: "meta",
          mcpAlwaysLoad: true,
          acpxAgent: thread.config.agent,
          acpxNativeSessionId:
            thread.backend === "acpx" && thread.sourceId
              ? (thread.runtimeId ?? undefined)
              : undefined,
        };
        if (thread.sourceId) {
          await getHandoffService().verifyResume(thread.sourceId);
          const source = await getDb().query.gateway_sessions.findFirst({
            where: and(
              eq(gateway_sessions.id, thread.sourceId),
              eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
            ),
          });
          if (
            source &&
            source.backend !== "codex" &&
            source.pid &&
            (source.status === "running" || source.status === "idle") &&
            (await hostRuntime(execHostFor(source.execution_host ?? null)).processAlive(source.pid))
          )
            throw new ConflictError(
              "This session is still open in its original agent. End it there before resuming in chat, or use Terminal.",
            );
          if (
            thread.config.agent === "codex" &&
            thread.runtimeId &&
            (await codexWriterOwned(hostRuntime(execHostFor(thread.host)), thread.runtimeId))
          )
            throw new ConflictError("End the original agent session before resuming it in chat.");
        }
        run.session = thread.runtimeId
          ? await backend.resumeSession(thread.runtimeId, opts)
          : await backend.startSession(opts);
        if (stopped) return;
        const turn = input + uploadPrompt(attachments);
        const sent = body.context ? withOrcContext(turn, body.context) : turn;
        const prompt =
          thread.backend === "acpx"
            ? [thread.config.system, sent].filter(Boolean).join("\n\n")
            : sent;
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
          if (event.type === "text" || event.type === "thinking" || event.type === "system_status")
            await emit({ type: event.type, text: event.data });
          else if (event.type === "tool_use" || event.type === "tool_result") await emit(event);
          else if (event.type === "permission_request") {
            run.permissions.add(event.data.requestId);
            changes.publish("human-requests");
            await emit(event);
            notify(
              "chat",
              chatPush(thread, "Approval needed", "The agent is waiting for your approval."),
            );
          } else if (event.type === "question_request") {
            run.questions.set(event.data.requestId, event.data);
            changes.publish("human-requests");
            await emit(event);
            notify("chat", chatPush(thread, "Question", "The agent is waiting for your answer."));
          } else if (event.type === "request_resolved") {
            run.permissions.delete(event.data.requestId);
            run.questions.delete(event.data.requestId);
            changes.publish("human-requests");
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
      clearTimeout(timer);
      const nativeId = run.session?.getRuntimeSessionId?.();
      if (!thread.runtimeId && nativeId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(nativeId))
        thread.runtimeId = nativeId;
      await run.session?.close().catch(() => {});
      if (assistant.content || assistant.activity?.length) thread.messages.push(assistant);
      thread.updatedAt = Date.now();
      try {
        store().save(thread);
        if (!stopped) publish(run, { type: "session", runtimeId: thread.runtimeId });
        if (!stopped && assistant.content)
          notify("chat", chatPush(thread, "Reply ready", truncate(assistant.content, 180)));
      } catch (error) {
        logger.error("Chat history could not be saved", { error, runId });
        if (!stopped)
          publish(run, {
            type: "error",
            message: "This response could not be saved. Start a new chat before continuing.",
          });
      } finally {
        active.delete(key);
        runs.delete(runId);
        changes.publish("human-requests");
        publish(run, { type: "done" });
        for (const listener of run.listeners) listener(null);
      }
    }
  };
  void execute();
  return follow(c, run);
}

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/threads/{id}/live",
    tags: ["Chat"],
    description:
      "Attach to the conversation's running turn: replays its events so far, then streams the rest.",
    request: { params },
    responses: {
      200: {
        description: "Chat events of the running turn",
        content: { "text/event-stream": { schema: z.string() } },
      },
      204: { description: "The conversation is not responding" },
    },
  }),
  (c) => {
    const found = threadRun(requireThread(c.req.valid("param").id).id);
    return found ? follow(c, found[1]) : c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/chat/runs/{id}/cancel",
    tags: ["Chat"],
    request: { params },
    responses: {
      200: {
        description: "The agent was asked to stop",
        content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
      },
    },
  }),
  (c) => {
    const run = runs.get(c.req.valid("param").id);
    if (!run) throw new ConflictError("This response already finished.");
    run.stop();
    return c.json({ ok: true });
  },
);

export { app as chatRouter };
