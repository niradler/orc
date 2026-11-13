import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AgentSession,
  chatBackendFor,
  createBackend,
  discoverAgentModels,
  type SessionOpts,
  sessionRules,
  UNKNOWN_CAPABILITIES,
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
  type ChatSpawn,
  type ChatThread,
  ChatThreadSchema,
  ChatWorkspaceSchema,
  chatSystemPrompt,
  nativeChatAgent,
  nativeChatResumeUnavailableReason,
} from "@orc/core/chat";
import { expandChatCommands } from "@orc/core/chat-commands";
import {
  type ChatTurnContext,
  ChatTurnContextSchema,
  withOrcContext,
} from "@orc/core/chat-context";
import { ChatAgentOptionsMapSchema } from "@orc/core/chat-options";
import { supportsModelDiscovery } from "@orc/core/coding-agents";
import { loadConfig } from "@orc/core/config";
import { ConflictError, NotFoundError, OrcError, ValidationError } from "@orc/core/errors";
import { execHostFor, hostHome, hostRuntime, resolveExecHost } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import { AgentSetupSchema } from "@orc/core/package-launch";
import {
  agentDefaultHome,
  providerChatDefaults,
  providerEffectiveHome,
  providerForAgent,
  providerRevision,
  readProviderSettings,
  storedProviderProfiles,
} from "@orc/core/provider-service";
import { ProviderIdSchema } from "@orc/core/providers";
import type { PushMessage } from "@orc/core/push";
import {
  type SessionFile,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  type UploadFile,
} from "@orc/core/session-file-types";
import { storeSessionFiles, uploadPrompt } from "@orc/core/session-files";
import {
  SESSION_MESSAGE_HOP_LIMIT,
  SESSION_SPAWN_HOURLY_LIMIT,
  type SessionSpawn,
  type SessionStatus,
} from "@orc/core/session-messages";
import { renderSkillInstructions } from "@orc/core/skill-service";
import { AgentCapabilitiesSchema } from "@orc/core/types";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { McpPromptStore } from "@orc/db/mcp-prompts";
import { notificationProjectLabel } from "@orc/db/notification-producers";
import { RuleStore } from "@orc/db/rules";
import { gateway_sessions } from "@orc/db/schema";
import { SessionMessageStore } from "@orc/db/session-messages";
import { SkillHistory } from "@orc/db/skill-history";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rememberTerminalFolder } from "../git/registry.js";
import { getHandoffService } from "../handoffs/service.js";
import { queuedAnswers } from "../human-request-delivery.js";
import { installPackageForChat } from "../lib/package-launch.js";
import { createRouter } from "../lib/router.js";
import { unbufferedSSE } from "../lib/sse.js";
import {
  recordChatNotification,
  resolveChatNotification,
  retireChatFinishedNotifications,
} from "../notifications.js";
import { notify, truncate } from "../push/service.js";
import { LIVE_CHAT_ID } from "../session-watcher.js";
import { chatHistory } from "../sessions/chat-history.js";
import { projectIdFor } from "../sessions/common.js";
import { notifySpawner, spawnChain } from "../sessions/control.js";
import { codexWriterOwned } from "../sessions/ownership.js";
import { readTranscriptBytes, type TranscriptTurn } from "../sessions/transcript.js";
import { loadTranscriptBytes, transcriptCacheKey } from "../sessions/transcript-source.js";
import { activeTurns, type ChatTarget, registerChatControl, turnKey } from "../sessions/turns.js";
import { selectedTerminalHost } from "../terminals/host.js";
import { launchDeps, sessionDirDeps } from "../terminals/service.js";
import { prepareSessionDirectory } from "../terminals/session-dir.js";
import { workspaceLaunch } from "../workspaces/service.js";

const logger = createLogger("api:chat");

// Browser suites chat through a mock that never launches a provider, so an
// installed-but-disabled agent profile must not block the turn.
const chatMockEnabled = () => process.env.ORC_E2E_CHAT_MOCK === "1";

function expandChatInput(input: string, projectId: string | null): string {
  if (input.trim() === "/compact") return "/compact";
  const prompts = new McpPromptStore(getSqlite());
  const skills = new SkillHistory(getSqlite());
  return expandChatCommands(input, {
    prompt: (name) => prompts.get(name),
    skill: (name) => {
      const skill = skills.read(name, projectId);
      if (!skill || !("files" in skill)) return null;
      skills.recordRead(name, projectId, "ui");
      return renderSkillInstructions(skill);
    },
  });
}
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
  steering: Map<string, { input: string; result: Promise<ChatThread> }>;
  threadId: string;
  thread: ChatThread;
  key: string;
  events: string[];
  listeners: Set<(data: string | null) => void>;
  stop: () => void;
}
const runs = new Map<string, ChatRun>();

/**
 * A turn is stopped after `idleMs` without any agent event, re-checking every
 * `recheckMs` while it waits for a human answer or an in-flight tool call, and
 * never runs past `hardMs`. After a cooperative Stop, `stopGraceMs` bounds how long
 * we wait for the agent to end the turn before forcing the transport closed. Tests
 * shorten these through setChatTurnLimits.
 */
const turnLimits = {
  idleMs: 15 * 60000,
  recheckMs: 60_000,
  hardMs: 4 * 60 * 60000,
  stopGraceMs: 10_000,
};
export function setChatTurnLimits(limits: Partial<typeof turnLimits>): () => void {
  const previous = { ...turnLimits };
  Object.assign(turnLimits, limits);
  return () => Object.assign(turnLimits, previous);
}

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
  return unbufferedSSE(c, async (s) => {
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
const active = activeTurns;
const params = z.object({ id });
const modelCatalogs = new Map<string, { at: number; result: Promise<ChatModels> }>();
let modelRequests = 0;

function requireThread(id: string): ChatThread {
  const thread = store().get(id);
  if (!thread) throw new NotFoundError("Chat", id);
  // Older conversations used the built-in adapter, never a later named default.
  thread.config.providerId ??= thread.config.agent;
  return thread;
}

function chatPush(thread: ChatThread, status: string, body: string): PushMessage {
  const project = notificationProjectLabel(getSqlite(), thread.projectId, thread.cwd);
  return {
    title: truncate(
      [project, status, truncate(thread.title, 120)].filter(Boolean).join(" · "),
      200,
    ),
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
        .object({
          agent: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i),
          threadId: id.optional(),
          providerId: ProviderIdSchema.optional(),
          host: z
            .string()
            .regex(/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/)
            .max(128)
            .optional(),
          cwd: z
            .string()
            .trim()
            .min(1)
            .max(4096)
            .refine((value) => !value.includes("\0"))
            .optional(),
        })
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
    const {
      agent,
      threadId,
      providerId,
      host: requestedHost,
      cwd: requestedCwd,
    } = c.req.valid("query");
    const thread = threadId ? requireThread(threadId) : null;
    if (thread && thread.config.agent !== agent)
      throw new ValidationError("The agent does not match this conversation.");
    // A conversation may ask for another profile of the same adapter so the
    // picker can preview models before switching accounts in place.
    const selectedProvider = providerId ?? thread?.config.providerId;
    providerForAgent(agent, selectedProvider, true);
    if (thread && (requestedHost !== undefined || requestedCwd !== undefined))
      throw new ValidationError("A conversation owns its execution host and working directory.");
    if (!supportsModelDiscovery(agent)) return c.json({ models: [], warning: null });
    const host = thread
      ? execHostFor(thread.host)
      : requestedHost === undefined
        ? resolveExecHost()
        : execHostFor(requestedHost === "__local__" ? null : requestedHost);
    const cwd =
      thread?.cwd ?? requestedCwd ?? (host.kind === "ssh" ? await hostHome(host) : homedir());
    const key = JSON.stringify([
      agent,
      host.kind === "ssh" ? host.alias : null,
      cwd,
      selectedProvider,
      providerRevision(),
    ]);
    const cached = modelCatalogs.get(key);
    if (cached && Date.now() - cached.at < 120_000) return c.json(await cached.result);
    if (modelRequests >= 2)
      return c.json({
        models: [],
        warning: "Model discovery is busy. Saved and custom models are still available.",
      });
    modelRequests++;
    const result = discoverAgentModels(agent, host, cwd, selectedProvider)
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

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/capabilities",
    tags: ["Chat"],
    summary: "Read supported chat features without starting an agent",
    request: {
      query: z.object({
        agent: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        threadId: z.string().uuid().optional(),
      }),
    },
    responses: {
      200: {
        description: "Adapter guarantees, or capabilities negotiated by this conversation",
        content: {
          "application/json": {
            schema: z.object({ backend: z.string(), capabilities: AgentCapabilitiesSchema }),
          },
        },
      },
    },
  }),
  (c) => {
    const { agent, threadId } = c.req.valid("query");
    const thread = threadId ? requireThread(threadId) : null;
    if (thread && thread.config.agent !== agent)
      throw new ValidationError("The agent does not match this conversation.");
    const backend = thread?.backend ?? chatBackendFor(agent);
    return c.json({
      backend,
      capabilities: thread?.capabilities ??
        createBackend(backend).capabilities ?? { ...UNKNOWN_CAPABILITIES },
    });
  },
);

const STEER_LIMIT = 32;

function steerable(
  run: ChatRun | undefined,
): run is ChatRun & { session: AgentSession & Required<Pick<AgentSession, "steer">> } {
  return !!run?.session?.steer && run.session.capabilities?.steering === true;
}

async function steerRun(run: ChatRun, input: string, requestId: string): Promise<ChatThread> {
  if (!steerable(run))
    throw new ConflictError("This response cannot be steered. Queue a message instead.");
  if (input.trim() === "/compact")
    throw new ConflictError("Wait for this turn to finish before compacting context.");
  const previous = run.steering.get(requestId);
  if (previous) {
    if (previous.input !== input)
      throw new ConflictError("This steering request ID already has different content.");
    return previous.result;
  }
  if (run.steering.size >= STEER_LIMIT)
    throw new ConflictError(
      "This response has reached its steering limit. Queue a message instead.",
    );
  if (run.thread.messages.some((message) => message.id === requestId))
    throw new ConflictError("This message ID is already in use.");
  const steer = run.session.steer.bind(run.session);
  let dispatched = false;
  const deliver = async (): Promise<ChatThread> => {
    const message: ChatMessage = {
      id: requestId,
      role: "user",
      content: input,
      timestamp: Date.now(),
      activity: [
        {
          type: "status",
          id: `steering:${requestId}`,
          text: "Sending this message into the active response.",
        },
      ],
    };
    run.thread.messages.push(message);
    run.thread.updatedAt = Date.now();
    try {
      store().save(run.thread);
    } catch (error) {
      run.thread.messages = run.thread.messages.filter((entry) => entry.id !== requestId);
      throw error;
    }
    const saveDelivery = () => {
      try {
        store().save(run.thread);
      } catch {
        publish(run, {
          type: "error",
          message:
            "The steering request was saved, but its delivery status could not be saved. Check the response before sending again.",
        });
      }
    };
    dispatched = true;
    try {
      await steer(expandChatInput(input, run.thread.projectId ?? null));
    } catch {
      message.activity = [
        {
          type: "status",
          id: `steering:${requestId}`,
          text: "Delivery unconfirmed. Check the response before sending again.",
        },
      ];
      saveDelivery();
      throw new ConflictError(
        "Steering delivery could not be confirmed. Reusing this request ID will not send it again; check the response before sending another message.",
      );
    }
    delete message.activity;
    saveDelivery();
    return run.thread;
  };
  const result = deliver();
  run.steering.set(requestId, { input, result });
  // A failed intent save sent nothing, so the same ID may safely retry after storage recovers.
  void result.catch(() => {
    if (!dispatched) run.steering.delete(requestId);
  });
  return result;
}

app.openapi(
  createRoute({
    method: "post",
    path: "/chat/runs/{id}/steer",
    tags: ["Chat"],
    summary: "Send a message into the active native turn",
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({ requestId: z.string().uuid(), input: z.string().trim().min(1).max(100000) })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Steering message accepted",
        content: { "application/json": { schema: ChatThreadSchema } },
      },
    },
  }),
  async (c) => {
    const run = runs.get(c.req.valid("param").id);
    if (!run) throw new ConflictError("This response cannot be steered. Queue a message instead.");
    const { input, requestId } = c.req.valid("json");
    return c.json(await steerRun(run, input, requestId));
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
  providerId?: string,
): Promise<ChatThread> {
  const config = providerChatDefaults(providerId, agent, chatMockEnabled());
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
      : homedir();
  const thread: ChatThread = {
    id: crypto.randomUUID(),
    title: "New chat",
    config,
    backend: chatBackendFor(config.agent),
    runtimeId: null,
    cwd,
    host: host.kind === "ssh" ? host.alias : null,
    sourceId: sourceId ?? null,
    messages: [],
    updatedAt: Date.now(),
  };
  const mappedProject = await projectIdFor(cwd, hostRuntime(host));
  if (mappedProject) thread.projectId = mappedProject;
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
    if (!(await runtime.isDirectory(source.cwd)))
      throw new ValidationError("The session working folder is unavailable on its execution host.");
    thread.config.agent = agent;
    if (agent === "pi") {
      const settings = readProviderSettings();
      const candidates = settings.providers.filter(
        (profile) => profile.agent === "pi" && profile.enabled,
      );
      const selected =
        candidates.find((profile) => profile.id === settings.default_provider_id) ??
        candidates.find((profile) => profile.id === "pi") ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (!selected)
        throw new ValidationError(
          "Enable a Pi provider and make it the default when several Pi providers are configured before resuming this session.",
        );
      thread.config.providerId = selected.id;
    } else {
      thread.config.providerId =
        (source.execution_host
          ? undefined
          : providerForNativeHome(agent, source.transcript_path)) ?? agent;
    }
    thread.config.agentOptions = {};
    thread.config.model = model ?? source.model ?? "";
    thread.backend = chatBackendFor(agent);
    if (source.project_id) thread.projectId = source.project_id;
    thread.runtimeId = source.runtime_session_id;
    thread.cwd = source.cwd;
    thread.host = source.execution_host ?? null;
    thread.title = source.title ?? "Resumed session";
    // Opening a conversation must not rewrite its date: recency belongs to the
    // session's last native activity, and only a sent message may bump it.
    thread.updatedAt = (source.last_activity_at ?? source.created_at).getTime();
    await importTranscript(thread, source);
  }
  return thread;
}

type NativeSource = typeof gateway_sessions.$inferSelect;

async function nativeSource(thread: ChatThread): Promise<NativeSource | null> {
  if (!thread.runtimeId) return null;
  const rows = await getDb().query.gateway_sessions.findMany({
    where: and(
      eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      eq(gateway_sessions.runtime_session_id, thread.runtimeId),
    ),
  });
  return (
    rows.find((row) => row.id === thread.sourceId) ??
    rows.find(
      (row) =>
        (row.execution_host ?? null) === thread.host &&
        nativeChatAgent(row.backend) === thread.config.agent,
    ) ??
    null
  );
}

async function transcriptMark(thread: ChatThread, source?: NativeSource | null) {
  const row = source === undefined ? await nativeSource(thread) : source;
  if (!row?.transcript_path) return null;
  const info = await hostRuntime(execHostFor(thread.host))
    .stat(row.transcript_path)
    .catch(() => null);
  return info ? `${info.size}:${info.mtimeMs}` : null;
}

async function importTranscript(thread: ChatThread, source: NativeSource): Promise<boolean> {
  const runtime = hostRuntime(execHostFor(thread.host));
  if (!source.transcript_path || !(await runtime.isFile(source.transcript_path))) return false;
  const mark = await transcriptMark(thread, source);
  const externalId = source.runtime_session_id ?? null;
  const bytes = await loadTranscriptBytes(
    runtime,
    source.backend,
    source.transcript_path,
    externalId,
  );
  const cacheKey = transcriptCacheKey(
    thread.host ?? "local",
    source.backend,
    source.transcript_path,
    externalId,
  );
  let transcript = await readTranscriptBytes(bytes, source.backend, cacheKey, {
    offset: 0,
    limit: CHAT_HISTORY_PAGE_SIZE,
  });
  if (transcript.total > CHAT_HISTORY_PAGE_SIZE)
    transcript = await readTranscriptBytes(bytes, source.backend, cacheKey, {
      offset: transcript.total - CHAT_HISTORY_PAGE_SIZE,
      limit: CHAT_HISTORY_PAGE_SIZE,
    });
  thread.messages = chatHistory(transcript.turns, source.backend);
  thread.importedMessages = thread.messages.length;
  thread.historyBefore = transcript.offset > 0 ? transcript.offset : null;
  if (mark) thread.transcriptMark = mark;
  return true;
}

function providerHomeFor(agent: string, providerId: string | undefined): string | undefined {
  try {
    const profile = providerForAgent(agent, providerId, true);
    return profile ? providerEffectiveHome(profile) : agentDefaultHome(agent);
  } catch {
    return undefined;
  }
}

/**
 * A discovered session belongs to the account whose CLI home holds its transcript;
 * resuming it through another profile would look for the native session in the
 * wrong directory. The most specific home wins; local sessions only.
 */
function providerForNativeHome(agent: string, transcriptPath: string | null): string | undefined {
  if (!transcriptPath) return undefined;
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const target = normalize(transcriptPath);
  let best: { id: string; length: number } | undefined;
  for (const profile of storedProviderProfiles()) {
    if (profile.agent !== agent) continue;
    const home = providerEffectiveHome(profile);
    if (!home) continue;
    const prefix = normalize(`${home}${sep}`);
    if (target.startsWith(prefix) && (!best || prefix.length > best.length))
      best = { id: profile.id, length: prefix.length };
  }
  return best?.id;
}

/**
 * A portable fork or account switch has no native session for this chat, so its
 * first turn carries a bounded, self-contained transcript. Tool work is included
 * because without edits and commands, a coding agent cannot continue the same
 * task. A fork gets the long budget; an account switch keeps its historical
 * 12k bound so a smaller-context provider is not handed a larger prompt than
 * it used to receive.
 */
const FORK_CONTINUATION_MAX_CHARS = 100_000;
const SWITCH_CONTINUATION_MAX_CHARS = 12_000;
const CONTINUATION_MESSAGE_MAX_CHARS = 8_000;
const CONTINUATION_TOOL_INPUT_MAX_CHARS = 600;
const CONTINUATION_TOOL_RESULT_MAX_CHARS = 1_200;
const CONTINUATION_ORIGINAL_REQUEST_MAX_CHARS = 2_000;

type ContinuationEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  activity: boolean;
};

function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed;
}

function continuationEntry(message: ChatMessage): ContinuationEntry | null {
  const parts: string[] = [];
  const content = message.content.trim();
  if (content)
    parts.push(
      `${message.role === "user" ? "User" : "Assistant"}: ${clipText(content, CONTINUATION_MESSAGE_MAX_CHARS)}`,
    );
  let activity = false;
  for (const item of message.activity ?? []) {
    if (item.type === "tool") {
      activity = true;
      const input = clipText(item.input, CONTINUATION_TOOL_INPUT_MAX_CHARS);
      parts.push(`Tool: ${item.name}${input ? ` ${input}` : ""}`);
      if (item.result !== undefined)
        parts.push(
          `Result${item.isError ? " (error)" : ""}: ${clipText(item.result, CONTINUATION_TOOL_RESULT_MAX_CHARS)}`,
        );
    } else if (item.type === "status") {
      activity = true;
      parts.push(`Status: ${clipText(item.text, CONTINUATION_TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  for (const attachment of message.attachments ?? []) {
    activity = true;
    parts.push(`Attachment: ${attachment.name} (${attachment.mimeType})`);
  }
  return parts.length
    ? { id: message.id, role: message.role, text: parts.join("\n"), activity }
    : null;
}

type Continuation = {
  prompt: string | undefined;
  messageCount: number;
  truncated: boolean;
  includesActivity: boolean;
};

function buildContinuation(
  messages: ChatMessage[],
  kind: "switch" | "fork" = "switch",
): Continuation {
  const entries = messages
    .map(continuationEntry)
    .filter((entry): entry is ContinuationEntry => entry !== null);
  const selected: ContinuationEntry[] = [];
  let used = 0;
  let omitted = false;
  // Reserve room for the wrapper and, on a fork, for the original request when
  // the tail fills the budget. Losing the opening task is worse than losing a
  // recent tool result, so a fork keeps both ends of the conversation.
  const budget =
    (kind === "fork" ? FORK_CONTINUATION_MAX_CHARS : SWITCH_CONTINUATION_MAX_CHARS) -
    (kind === "fork" ? CONTINUATION_ORIGINAL_REQUEST_MAX_CHARS + 500 : 0);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    const cost = entry.text.length + 2;
    if (used + cost > budget) {
      // A single long turn (text plus summarized tool work) must never swallow
      // the whole replay: the newest turn is the one the agent needs to continue.
      // Clip it into the remaining room and mark the rest as omitted.
      if (!selected.length) {
        const room = budget - used - 2;
        if (room > 1) selected.unshift({ ...entry, text: clipText(entry.text, room) });
      }
      omitted = true;
      break;
    }
    selected.unshift(entry);
    used += cost;
  }
  const firstUser = entries.find((entry) => entry.role === "user");
  if (
    kind === "fork" &&
    omitted &&
    firstUser &&
    !selected.some((entry) => entry.id === firstUser.id)
  ) {
    const original = `User (original request): ${clipText(
      firstUser.text.replace(/^User:\s*/, ""),
      CONTINUATION_ORIGINAL_REQUEST_MAX_CHARS,
    )}`;
    selected.unshift({ ...firstUser, text: original });
  }
  if (!selected.length)
    return { prompt: undefined, messageCount: 0, truncated: false, includesActivity: false };
  const intro =
    kind === "fork"
      ? "[ORC fork] This chat was forked from another ORC conversation. It starts without the previous native session. Continue the same work from the history below, then handle the new user message. Tool calls are summarized; do not repeat the history unless asked."
      : "[ORC account switch] This chat moved to another provider account, so the previous native session is unavailable. Continue the same work from the history below, then handle the new user message. Tool calls are summarized; do not repeat the history unless asked.";
  const prompt = [
    intro,
    "",
    "<chat-history>",
    ...(omitted ? ["[Earlier conversation omitted]"] : []),
    selected.map((entry) => entry.text).join("\n\n"),
    "</chat-history>",
    "",
    "--- End of prior conversation ---",
  ].join("\n");
  return {
    prompt,
    messageCount: selected.length,
    truncated: omitted,
    includesActivity: selected.some((entry) => entry.activity),
  };
}

function continuationPrompt(
  messages: ChatMessage[],
  kind: "switch" | "fork" = "switch",
): string | undefined {
  return buildContinuation(messages, kind).prompt;
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
                  projectId: z.string().nullable().optional(),
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
    method: "get",
    path: "/chat/threads/by-message/{id}",
    tags: ["Chat"],
    description:
      "Find the conversation holding a user message id, so a client can recover a first send whose response was lost.",
    request: { params },
    responses: response,
  }),
  (c) => {
    const messageId = c.req.valid("param").id;
    const thread = store().byMessage(messageId);
    if (!thread) throw new NotFoundError("Chat message", messageId);
    return c.json(thread);
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/chat/threads/{id}/session",
    tags: ["Chat"],
    description:
      "Whether the native session changed on disk since this conversation last showed it, whether a turn is running, and the human answers queued for it.",
    request: { params },
    responses: {
      200: {
        description: "Native session state",
        content: {
          "application/json": {
            schema: z.object({
              changed: z.boolean(),
              running: z.boolean(),
              queued: z.array(z.object({ id: z.string(), title: z.string() })),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const thread = requireThread(c.req.valid("param").id);
    const running = !!threadRun(thread.id);
    let changed = false;
    if (!running && thread.runtimeId) {
      const mark = await transcriptMark(thread);
      const latest = requireThread(thread.id);
      if (mark && !latest.transcriptMark && !threadRun(thread.id)) {
        latest.transcriptMark = mark;
        store().save(latest);
      } else changed = !!mark && !!latest.transcriptMark && mark !== latest.transcriptMark;
    }
    const queued = thread.runtimeId
      ? await queuedAnswers(turnKey(thread.host, thread.backend, thread.runtimeId))
      : [];
    return c.json({
      changed,
      running,
      queued: queued.map((request) => ({
        id: request.id,
        title: request.input.title ?? request.input.prompt.slice(0, 120),
      })),
    });
  },
);
app.openapi(
  createRoute({
    method: "post",
    path: "/chat/threads/{id}/refresh",
    tags: ["Chat"],
    description: "Rebuild the conversation from its native session transcript.",
    request: { params },
    responses: response,
  }),
  async (c) => {
    const thread = requireThread(c.req.valid("param").id);
    if (
      threadRun(thread.id) ||
      (thread.runtimeId && active.has(turnKey(thread.host, thread.backend, thread.runtimeId)))
    )
      throw new ConflictError("Wait for the agent to finish before refreshing.");
    const source = await nativeSource(thread);
    if (!source || !(await importTranscript(thread, source)))
      throw new NotFoundError("Native transcript", thread.id);
    store().save(thread);
    return c.json(thread);
  },
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
    if (before > (thread.historyBefore ?? 0))
      throw new ValidationError("No older history is available at this position.");
    const source = await nativeSource(thread);
    if (
      !source?.transcript_path ||
      nativeChatAgent(source.backend) !== thread.config.agent ||
      (source.execution_host ?? null) !== thread.host
    )
      throw new NotFoundError("Native transcript", thread.id);
    const runtime = hostRuntime(execHostFor(thread.host));
    if (!(await runtime.isFile(source.transcript_path)))
      throw new NotFoundError("Native transcript", thread.id);
    const externalId = source.runtime_session_id ?? null;
    const bytes = await loadTranscriptBytes(
      runtime,
      source.backend,
      source.transcript_path,
      externalId,
    );
    const offset = Math.max(0, before - CHAT_HISTORY_PAGE_SIZE);
    const page = await readTranscriptBytes(
      bytes,
      source.backend,
      transcriptCacheKey(
        thread.host ?? "local",
        source.backend,
        source.transcript_path,
        externalId,
      ),
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
    } else {
      const resumed = await newThread(undefined, undefined, body.sourceSessionId);
      // Reopening a conversation reuses its thread instead of forking a duplicate
      // whose fresh timestamp would push the session up the recents list.
      const candidates = resumed.runtimeId
        ? store()
            .byRuntime(resumed.backend, resumed.host, resumed.runtimeId)
            .filter((item) => item.config.agent === resumed.config.agent)
            .sort((a, b) => b.updatedAt - a.updatedAt)
        : [];
      const existing =
        candidates.find((item) => item.sourceId === body.sourceSessionId) ?? candidates[0];
      if (existing) {
        if (
          threadRun(existing.id) ||
          (existing.runtimeId &&
            active.has(turnKey(existing.host, existing.backend, existing.runtimeId)))
        )
          throw new ConflictError("Wait for the agent to finish before resuming.");
        thread = existing;
        if (resumed.transcriptMark && resumed.transcriptMark !== existing.transcriptMark) {
          thread.messages = resumed.messages;
          thread.importedMessages = resumed.importedMessages;
          thread.historyBefore = resumed.historyBefore;
          thread.transcriptMark = resumed.transcriptMark;
        }
        thread.sourceId = body.sourceSessionId;
        // Sync to real native activity without stamping the open time.
        thread.updatedAt = Math.max(thread.updatedAt, resumed.updatedAt);
      } else thread = resumed;
    }
    store().save(thread);
    return c.json(thread);
  },
);
const FORK_HISTORY_MAX_MESSAGES = 5_000;
/** Bound the copied display history; the replayed prompt has its own smaller cap. */
const FORK_HISTORY_MAX_CHARS = 2_000_000;

function transcriptTurnSize(turn: TranscriptTurn): number {
  return turn.blocks.reduce(
    (size, block) =>
      size +
      (block.type === "tool_use"
        ? block.input.length + (block.result?.length ?? 0)
        : block.text.length),
    0,
  );
}

/**
 * The copied display transcript must include the source's older native pages,
 * not only the last `CHAT_HISTORY_PAGE_SIZE` messages held on the thread.
 * Returning `partial` lets the caller refuse a lossy context fork instead of
 * silently dropping the beginning of a long conversation.
 */
async function forkPrefix(
  thread: ChatThread,
  messageId: string,
): Promise<{ messages: ChatMessage[]; partial: boolean }> {
  const index = thread.messages.findIndex((message) => message.id === messageId);
  if (index < 0) throw new NotFoundError("Chat message", messageId);
  const loaded = thread.messages.slice(0, index + 1);
  if (!thread.historyBefore) return { messages: loaded, partial: false };
  const source = await nativeSource(thread);
  if (!source?.transcript_path) return { messages: loaded, partial: true };
  const runtime = hostRuntime(execHostFor(thread.host));
  if (!(await runtime.isFile(source.transcript_path))) return { messages: loaded, partial: true };
  try {
    const externalId = source.runtime_session_id ?? null;
    const bytes = await loadTranscriptBytes(
      runtime,
      source.backend,
      source.transcript_path,
      externalId,
    );
    const cacheKey = transcriptCacheKey(
      thread.host ?? "local",
      source.backend,
      source.transcript_path,
      externalId,
    );
    const end = Math.max(0, thread.historyBefore);
    const turns: TranscriptTurn[] = [];
    let start = end;
    let chars = 0;
    // Walk newest pages backwards so the fork keeps the work nearest the answer.
    collect: while (start > 0 && turns.length < FORK_HISTORY_MAX_MESSAGES) {
      const from = Math.max(0, start - CHAT_HISTORY_PAGE_SIZE);
      const page = await readTranscriptBytes(bytes, source.backend, cacheKey, {
        offset: from,
        limit: start - from,
      });
      // The stored index says this chat had `end` turns; a transcript with fewer
      // means it was rewritten or truncated, so a copy would have silent gaps.
      if (page.total < end) throw new Error("The native transcript shrank.");
      for (let cursor = page.turns.length - 1; cursor >= 0; cursor--) {
        const turn = page.turns[cursor];
        if (!turn) continue;
        const size = transcriptTurnSize(turn);
        if (turns.length >= FORK_HISTORY_MAX_MESSAGES || chars + size > FORK_HISTORY_MAX_CHARS) {
          start = from + cursor + 1;
          break collect;
        }
        turns.unshift(turn);
        chars += size;
      }
      start = from;
    }
    return {
      messages: [...chatHistory(turns, thread.config.agent), ...loaded],
      partial: start > 0,
    };
  } catch (error) {
    logger.warn("Fork could not read older native history", { error, threadId: thread.id });
    return { messages: loaded, partial: true };
  }
}

function forkTitle(title: string): string {
  const base = title.replace(/\s+\(fork\)$/i, "").trim() || "Chat";
  return `${base.length > 94 ? base.slice(0, 93).trimEnd() : base} (fork)`;
}

/** Keep lineage immutable while recording how this fork ended up continuing. */
function markFork(
  thread: ChatThread,
  pending: { threadId: string; messageId: string },
  mode: "native" | "context",
  fallbackReason?: string,
): void {
  const current = thread.forkedFrom;
  thread.forkedFrom = {
    threadId: current?.threadId ?? pending.threadId,
    messageId: current?.messageId ?? pending.messageId,
    mode,
    ...(current?.sourceTitle ? { sourceTitle: current.sourceTitle } : {}),
    ...(current?.partial ? { partial: true } : {}),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

app.openapi(
  createRoute({
    method: "post",
    path: "/chat/threads/{id}/fork",
    tags: ["Chat"],
    description:
      "Start a new conversation from the context up to one completed assistant response. Uses the agent's native conversation fork when the source is at its latest response and the backend supports it; otherwise replays a bounded, tool-aware transcript.",
    request: {
      params,
      body: {
        content: {
          "application/json": {
            schema: z.object({ messageId: z.string().min(1).max(256) }).strict(),
          },
        },
      },
    },
    responses: response,
  }),
  async (c) => {
    const thread = requireThread(c.req.valid("param").id);
    if (
      threadRun(thread.id) ||
      (thread.runtimeId && active.has(turnKey(thread.host, thread.backend, thread.runtimeId)))
    )
      throw new ConflictError("Wait for the agent to finish before forking the conversation.");
    const { messageId } = c.req.valid("json");
    const index = thread.messages.findIndex((message) => message.id === messageId);
    if (index < 0) throw new NotFoundError("Chat message", messageId);
    if (thread.messages[index]?.role !== "assistant")
      throw new ValidationError("Fork from an assistant response.");

    const backend = createBackend(thread.backend);
    const isHead = index === thread.messages.length - 1;
    // A static adapter advertises fork from its build; ACP negotiates it per
    // session, so its static capabilities never claim one. Accept either, since
    // a chat captured before this feature may still record `fork: false`.
    const forkCapability =
      thread.capabilities?.fork === true || backend.capabilities?.fork === true;
    // Browser suites run without a provider, and their mock turns record a fake
    // runtime id; a native fork there would spawn the real agent.
    const nativeEligible =
      !chatMockEnabled() &&
      !!thread.runtimeId &&
      isHead &&
      forkCapability &&
      typeof backend.forkSession === "function";
    const fallbackReason = nativeEligible
      ? undefined
      : !thread.runtimeId
        ? "The source chat has no native session to fork."
        : !forkCapability
          ? `The ${thread.config.agent} agent does not support native session forks.`
          : !isHead
            ? "Native forks start from the latest response; earlier responses use a context replay."
            : "This environment has no provider session to fork.";

    const prefix = await forkPrefix(thread, messageId);
    if (prefix.partial && !nativeEligible)
      throw new ValidationError(
        "This chat has older history that could not be read, so a context fork would lose it. Fork the latest response or reopen the source session first.",
      );
    const continuation = nativeEligible ? undefined : buildContinuation(prefix.messages, "fork");
    if (!nativeEligible && !continuation?.prompt)
      throw new ValidationError("This response has no context to carry into a fork.");

    // Copied messages get fresh ids: the source keeps its send-recovery identity,
    // and a fork must never answer by-message lookups for the original send.
    const messages = prefix.messages.map((message) => ({
      ...structuredClone(message),
      id: crypto.randomUUID(),
    }));
    const forked: ChatThread = {
      ...structuredClone(thread),
      id: crypto.randomUUID(),
      title: forkTitle(thread.title),
      messages,
      // The prefix is fixed context rather than new turns in this chat, so it
      // does not count against the growing-history limit.
      importedMessages: messages.length,
      historyBefore: null,
      runtimeId: null,
      sourceId: null,
      updatedAt: Date.now(),
      forkedFrom: {
        threadId: thread.id,
        messageId,
        mode: nativeEligible ? "native" : "context",
        sourceTitle: thread.title.slice(0, 500),
        ...(fallbackReason ? { fallbackReason } : {}),
        ...(prefix.partial ? { partial: true } : {}),
      },
    };
    delete forked.transcriptMark;
    delete forked.providerSwitch;
    delete forked.forkPending;
    delete forked.forkContext;
    if (nativeEligible && thread.runtimeId) {
      // Native fork is deferred to the first turn: some backends only mint the
      // new identity when they resume with their fork flag, and no idle process
      // is left behind if the user never sends the first message.
      forked.forkPending = {
        threadId: thread.id,
        messageId,
        sourceRuntimeId: thread.runtimeId,
        sourceBackend: thread.backend,
        sourceHost: thread.host,
        sourceAgent: thread.config.agent,
        sourceCwd: thread.cwd,
      };
    } else if (continuation) {
      forked.forkContext = {
        messageCount: continuation.messageCount,
        truncated: continuation.truncated,
        includesActivity: continuation.includesActivity,
      };
    }
    store().save(forked);
    return c.json(forked);
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
    resolveChatNotification(run.thread.id, `${c.req.valid("param").id}:${requestId}`);
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
    if (!run.session?.setPermissionMode)
      throw new ValidationError("This backend does not support changing live permissions.");
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
    resolveChatNotification(run.thread.id, `${c.req.valid("param").id}:${requestId}`);
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
    providerId: ProviderIdSchema.optional(),
    threadId: id.optional(),
    // Stored as the user message id so a client can tell whether an interrupted send landed.
    clientMessageId: z.string().uuid().optional(),
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

const startingMessages = new Set<string>();

async function streamChat(
  c: Context,
  body: z.infer<typeof requestSchema>,
  uploads: UploadFile[] = [],
) {
  const messageId = !body.threadId ? body.clientMessageId : undefined;
  if (messageId && (startingMessages.has(messageId) || store().byMessage(messageId)))
    throw new OrcError(
      "This message is already being prepared or was sent.",
      "CHAT_MESSAGE_EXISTS",
      409,
    );
  if (messageId) startingMessages.add(messageId);
  try {
    return await startChat(c, body, uploads);
  } finally {
    if (messageId) startingMessages.delete(messageId);
  }
}

async function startChat(
  c: Context,
  body: z.infer<typeof requestSchema>,
  uploads: UploadFile[] = [],
) {
  return follow(c, await openChat(body, uploads));
}

async function openChat(
  body: z.infer<typeof requestSchema>,
  uploads: UploadFile[] = [],
  spawnedBy?: ChatSpawn,
  toolAllowlist?: string[],
): Promise<ChatRun> {
  const thread = body.threadId
    ? requireThread(body.threadId)
    : await newThread(body.agent, body.model, undefined, body.workspace, body.providerId);
  if (!body.threadId && body.projectId) thread.projectId = body.projectId;
  if (!body.threadId && spawnedBy) thread.spawnedBy = spawnedBy;
  if (!body.threadId && toolAllowlist) thread.toolAllowlist = toolAllowlist;
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
  const input = [...body.messages]
    .reverse()
    .find((message) => message.role === "user")
    ?.content.trim();
  if (!input) throw new ValidationError("A user message is required.");
  if (input === "/compact" && uploads.length)
    throw new ValidationError("Send attachments separately from context compaction.");
  if (body.permissionMode !== undefined) {
    if (createBackend(thread.backend).capabilities?.livePermissions === false)
      throw new ValidationError("This backend does not support ORC permission modes.");
    thread.config.permissionMode = body.permissionMode;
  }
  await checkChatWorkspaceRules(thread);
  // The switch mutates the shared thread, so every check that can reject the request
  // runs first: from the busy check below to beginTurn's reservation there must be no
  // await, or concurrent sends could move the conversation under each other.
  let continuation: string | undefined;
  if (body.threadId && body.providerId && body.providerId !== thread.config.providerId) {
    const profile = providerForAgent(thread.config.agent, body.providerId);
    if (!profile)
      throw new ValidationError("This provider is no longer configured. Choose another provider.");
    if (threadRun(thread.id))
      throw new ConflictError("Wait for the current response before switching providers.");
    const previous = thread.config.providerId;
    // Only a different CLI home moves the native session; profiles that share a
    // home keep resuming the same conversation with different credentials.
    const movesSession =
      providerHomeFor(thread.config.agent, previous) !== providerEffectiveHome(profile);
    thread.config.providerId = profile.id;
    if (body.model === undefined) thread.config.model = profile.model;
    if (body.agentOptions === undefined) {
      const options = { ...thread.config.agentOptions };
      delete options[thread.config.agent];
      if (profile.options) options[thread.config.agent] = profile.options;
      thread.config.agentOptions = options;
    }
    if (movesSession) {
      continuation = continuationPrompt(thread.messages);
      thread.runtimeId = null;
      thread.sourceId = null;
      delete thread.transcriptMark;
      thread.providerSwitch = { from: previous ?? thread.config.agent };
    }
  }
  // Replay only while the new account or a context fork has no native session:
  // once a turn established one, the continuation was delivered and must not be
  // injected into it again. A native fork is attempted by beginTurn instead.
  if (body.threadId && thread.providerSwitch && !thread.runtimeId)
    // A forked chat that also changed account keeps its fork intro; the native
    // branch replaces this continuation when the fork succeeds.
    continuation ??= continuationPrompt(thread.messages, thread.forkPending ? "fork" : "switch");
  if (
    body.threadId &&
    thread.forkedFrom?.mode === "context" &&
    !thread.runtimeId &&
    !thread.forkPending
  )
    continuation ??= continuationPrompt(thread.messages, "fork");
  // A turn that ended cleanly without establishing a native session — a Pi
  // extension-command turn, which Pi only persists once the transcript holds a
  // message — is safe to continue: the next send starts a fresh native session and
  // there is no prior native context to lose. A turn that failed holding no session
  // is still treated as unsafe to resume.
  const lastAssistant = [...thread.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const cleanSessionlessTurn =
    lastAssistant?.turn?.outcome === "completed" || lastAssistant?.turn?.outcome === "stopped";
  if (
    body.threadId &&
    thread.messages.length &&
    !thread.runtimeId &&
    !thread.providerSwitch &&
    !cleanSessionlessTurn &&
    !thread.forkedFrom &&
    !thread.forkPending
  )
    throw new ConflictError(
      "The previous turn did not establish a resumable session. Start a new chat.",
    );
  if (body.model !== undefined) thread.config.model = body.model;
  if (body.agentOptions !== undefined) thread.config.agentOptions = body.agentOptions;
  const { run } = await beginTurn(thread, input, {
    context: body.context,
    messageId: body.clientMessageId,
    continuation,
    prepare: async () => {
      if (!body.threadId && body.workspace?.worktree) {
        const host = selectedTerminalHost(loadConfig(), thread.host);
        const cwd = await prepareSessionDirectory(
          { cwd: thread.cwd, worktree: true, base: body.workspace.base },
          {
            ...sessionDirDeps(await launchDeps(loadConfig(), host), host),
            validateDirectory: (path) => checkChatWorkspaceRules(thread, path),
          },
        );
        if (cwd === thread.cwd)
          throw new ValidationError("Choose a Git repository folder to create a worktree.");
        thread.cwd = cwd;
      }
      return storeSessionFiles({
        host: execHostFor(thread.host),
        cwd: thread.cwd,
        sessionId: thread.id,
        directory: project?.upload_directory ?? null,
        files: uploads,
      });
    },
  });
  return run;
}

type TurnSetup = {
  context?: ChatTurnContext | undefined;
  reserved?: boolean;
  messageId?: string | undefined;
  continuation?: string | undefined;
  prepare?: () => Promise<SessionFile[]>;
};

async function beginTurn(
  thread: ChatThread,
  input: string,
  setup: TurnSetup = {},
): Promise<{ run: ChatRun; done: Promise<void> }> {
  if (input.trim() === "/compact") {
    if (!thread.runtimeId)
      throw new ValidationError("Start a conversation before compacting context.");
    if (thread.backend !== "claude" && thread.backend !== "codex-cli" && thread.backend !== "pi")
      throw new ValidationError("This integration does not support manual context compaction.");
    const options = thread.config.agentOptions.claude;
    if (
      thread.backend === "claude" &&
      options?.runtime === "claude-sdk" &&
      options.options.extraArgs?.["disable-slash-commands"] === null
    )
      throw new ValidationError(
        "Enable Claude slash commands in session settings before compacting context.",
      );
  }
  if (setup.messageId && thread.messages.some((message) => message.id === setup.messageId))
    throw new ConflictError("This message was already sent.");
  if (JSON.stringify(thread.messages.slice(thread.importedMessages ?? 0)).length > 5000000)
    throw new ValidationError("This chat reached its history size limit. Start a new chat.");
  const key = thread.runtimeId ? turnKey(thread.host, thread.backend, thread.runtimeId) : thread.id;
  if (!setup.reserved && (active.has(key) || threadRun(thread.id)))
    throw new ConflictError("This session is already responding.");
  if (runs.size >= 4)
    throw new ConflictError("All chat workers are busy. Try again when a response finishes.");
  const mock = chatMockEnabled();
  const backend = createBackend(thread.backend);
  active.add(key);
  const runId = crypto.randomUUID();
  let stopped = false;
  let halt = () => {};
  let stopFallback: ReturnType<typeof setTimeout> | undefined;
  const halted = new Promise<void>((resolve) => {
    halt = resolve;
  });
  let finish: (failure: string | null) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    finish = (failure) => (failure ? reject(new Error(failure)) : resolve());
  });
  done.catch(() => {});
  const run: ChatRun = {
    session: null,
    permissions: new Set(),
    questions: new Map(),
    steering: new Map(),
    threadId: thread.id,
    thread,
    key,
    events: [],
    listeners: new Set(),
    stop: () => {
      stopped = true;
      halt();
      const session = run.session;
      // Interrupt-capable backends end the turn cooperatively and keep the native
      // session resumable for the next send; the per-turn transport still closes when
      // the turn ends. Backends without a native interrupt (ACPX) are killed.
      if (session?.interrupt && session.capabilities?.interrupt === true) {
        void session.interrupt().catch(() => session.close().catch(() => {}));
        // An agent that acknowledges the interrupt but never ends the turn must not
        // hold the worker forever; force the transport closed after a grace period.
        // Idempotent per-run: repeated Stops do not stack timers.
        stopFallback ??= setTimeout(() => {
          void session.close().catch(() => {});
        }, turnLimits.stopGraceMs);
      } else void session?.close().catch(() => {});
    },
  };
  runs.set(runId, run);
  let attachments: SessionFile[] = [];
  let synced = true;
  try {
    if (!mock) {
      const check = await backend.preflight({
        providerId: thread.config.providerId,
        executionHost: thread.host,
        acpAgent: thread.config.agent,
        acpxAgent: thread.config.agent,
      });
      if (!check.ok) throw new ValidationError(check.error ?? "This agent is unavailable.");
    }
    attachments = (await setup.prepare?.()) ?? [];
    if (thread.transcriptMark)
      synced = (await transcriptMark(thread).catch(() => null)) === thread.transcriptMark;
  } catch (error) {
    active.delete(key);
    runs.delete(runId);
    throw error;
  }
  thread.messages.push({
    id: setup.messageId ?? crypto.randomUUID(),
    role: "user",
    content: input,
    ...(attachments.length ? { attachments } : {}),
    timestamp: Date.now(),
  });
  if (thread.title === "New chat") thread.title = input.slice(0, 100);
  const startedAt = Date.now();
  const assistant: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    agent: thread.config.agent,
    activity: [],
    turn: { startedAt },
  };
  thread.updatedAt = Date.now();
  try {
    store().save(thread);
    retireChatFinishedNotifications(thread);
    changes.publish("sessions");
  } catch (error) {
    active.delete(key);
    runs.delete(runId);
    throw error;
  }
  let failure: string | null = null;
  let completed = false;
  let responded = false;
  let noResumableSession = false;
  let agentDurationMs: number | undefined;
  let agentOutcome: "completed" | "stopped" | "failed" | undefined;
  const execute = async () => {
    // Activity watchdog: a quiet turn is stopped, but a turn waiting for a
    // human answer or a running tool call is re-checked instead of killed.
    let timedOut = false;
    let toolsPending = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      const waiting = run.questions.size > 0 || run.permissions.size > 0 || toolsPending > 0;
      if (waiting && Date.now() - startedAt < turnLimits.hardMs) {
        timer = setTimeout(expire, turnLimits.recheckMs);
        return;
      }
      timedOut = true;
      run.stop();
    };
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(expire, turnLimits.idleMs);
    };
    touch();
    const emit = async (event: ChatEvent) => {
      if (event.type === "tool_use" && assistant.content) {
        const narration = assistant.content;
        assistant.content = "";
        await emit({ type: "narration", text: narration });
      }
      if (
        event.type !== "thread" &&
        event.type !== "turn" &&
        event.type !== "error" &&
        event.type !== "capabilities"
      )
        responded = true;
      if (event.type === "text") assistant.content += event.text;
      if (event.type === "error") failure ??= event.message;
      assistant.activity = appendChatActivity(assistant.activity ?? [], event);
      publish(run, event);
    };
    try {
      // Slim event: metadata plus the just-pushed user message only. The full
      // transcript stays on GET /chat/threads/{id}; /live replays this on every
      // attach, so shipping the whole history there would resend up to 5MB.
      await emit({
        type: "thread",
        thread: { ...thread, messages: thread.messages.slice(-1) },
        runId,
      });
      await emit({ type: "turn", turn: { startedAt } });
      if (mock) {
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
        completed = !stopped;
      } else {
        const projectWorkspace = thread.projectId
          ? await workspaceLaunch(execHostFor(thread.host), thread.cwd, thread.projectId)
          : null;
        const opts: SessionOpts = {
          ...(projectWorkspace && Object.keys(projectWorkspace.env).length
            ? { env: projectWorkspace.env }
            : {}),
          providerId: thread.config.providerId,
          toolAllowlist: thread.toolAllowlist,
          chatAgentOptions: thread.config.agentOptions[thread.config.agent],
          interactive: true,
          attentionContext: { chatThreadId: thread.id, sessionTitle: thread.title },
          cwd: thread.cwd,
          executionHost: thread.host,
          autoApprove: thread.config.autoApprove,
          permissionMode: ["claude", "codex", "pi"].includes(thread.config.agent)
            ? thread.config.permissionMode
            : undefined,
          model: thread.config.model,
          systemPromptAppend: chatSystemPrompt(thread.config.system, { webchat: true }),
          orcMcp: thread.config.mcp === "orc",
          orcPreviewSessionId: thread.id,
          orcMcpMode: loadConfig().mcp.default_mode,
          mcpAlwaysLoad: true,
          acpxAgent: thread.config.agent,
          acpAgent: thread.config.agent,
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
            source.status === "running" &&
            (await hostRuntime(execHostFor(source.execution_host ?? null)).processAlive(source.pid))
          )
            throw new ConflictError(
              "This session is running a turn in its original agent. Wait for it to finish, or use Terminal.",
            );
          if (
            thread.config.agent === "codex" &&
            thread.runtimeId &&
            (await codexWriterOwned(hostRuntime(execHostFor(thread.host)), thread.runtimeId))
          )
            throw new ConflictError("End the original agent session before resuming it in chat.");
        }
        if (!thread.runtimeId && thread.forkPending) {
          const pending = thread.forkPending;
          if (mock) {
            // The mock never has a provider session; keep the notice honest.
            markFork(
              thread,
              pending,
              "context",
              "This environment has no provider session to fork.",
            );
            delete thread.forkPending;
          } else
            try {
              if (!backend.forkSession)
                throw new Error(`The ${thread.backend} backend does not support native forks.`);
              // The fork must continue the source in its own agent, host and
              // folder; changing any of them before the first message makes the
              // native identity meaningless.
              if (
                pending.sourceBackend !== thread.backend ||
                (pending.sourceHost ?? null) !== (thread.host ?? null) ||
                pending.sourceAgent !== thread.config.agent ||
                pending.sourceCwd !== thread.cwd
              )
                throw new Error(
                  "The fork's agent or workspace changed before the native fork started.",
                );
              const session = await backend.forkSession(pending.sourceRuntimeId, opts);
              // A provider that ignores the fork flag and keeps the source id
              // would make both chats share one native session.
              const forkedId = session.getRuntimeSessionId?.();
              if (forkedId && forkedId === pending.sourceRuntimeId) {
                await session.close().catch(() => {});
                throw new Error("The provider returned the source session instead of a new fork.");
              }
              run.session = session;
              markFork(thread, pending, "native");
              delete thread.forkPending;
              delete thread.forkContext;
              // The native session already holds the history; never prepend a
              // replay on top of it.
              setup.continuation = undefined;
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              markFork(thread, pending, "context", reason.slice(0, 500));
              delete thread.forkPending;
            }
          if (thread.forkedFrom?.mode === "context" && !thread.forkPending) {
            // The just-sent user message is appended after this context; do not
            // replay it twice.
            const fallback = buildContinuation(thread.messages.slice(0, -1), "fork");
            setup.continuation ??= fallback.prompt;
            thread.forkContext = {
              messageCount: fallback.messageCount,
              truncated: fallback.truncated,
              includesActivity: fallback.includesActivity,
            };
          }
          if (!mock)
            await emit({
              type: "thread",
              thread: { ...thread, messages: thread.messages.slice(-1) },
              runId,
            });
        }
        if (!run.session)
          run.session = thread.runtimeId
            ? await backend.resumeSession(thread.runtimeId, opts)
            : await backend.startSession(opts);
        if (stopped) return;
        // The transcript keeps the typed "/name" commands; the agent receives the expanded text.
        const turn = expandChatInput(input, thread.projectId ?? null) + uploadPrompt(attachments);
        const message =
          setup.context && input.trim() !== "/compact" ? withOrcContext(turn, setup.context) : turn;
        const sent =
          setup.continuation && input.trim() !== "/compact"
            ? `${setup.continuation}\n\n${message}`
            : message;
        const prompt =
          thread.backend === "acpx"
            ? [thread.config.system, sent].filter(Boolean).join("\n\n")
            : sent;
        thread.capabilities = run.session.capabilities ??
          backend.capabilities ?? { ...UNKNOWN_CAPABILITIES };
        await emit({ type: "capabilities", capabilities: thread.capabilities });
        await run.session.send(prompt);
        let receivedResult = false;
        let outputBytes = 0;
        for await (const event of run.session.events()) {
          // Always consume the terminal result — even after a Stop — so the turn's
          // outcome, native identity and resumability are recorded, not discarded.
          if (event.type === "result") {
            const duration = event.data.durationMs;
            if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0)
              agentDurationMs = duration;
            agentOutcome = event.data.outcome;
            noResumableSession = event.data.resumable === false;
            if (agentOutcome === "stopped") stopped = true;
            if (agentOutcome === "failed") failure ??= "The agent could not complete the response.";
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
            // A backend may have resumed the session in a folder it moved to (an
            // OpenCode worktree); follow it so the next turn loads from there.
            if (event.data.cwd && isAbsolute(event.data.cwd) && !event.data.cwd.includes("\0"))
              thread.cwd = event.data.cwd;
            if (thread.sourceId) await getHandoffService().markResumed(thread.sourceId);
            receivedResult = true;
            break;
          }
          // After a Stop, drain remaining events without emitting them; the loop ends
          // at the result above or when the session closes (bounded by stopFallback).
          if (stopped) continue;
          touch();
          if (event.type === "tool_use") toolsPending++;
          else if (event.type === "tool_result") toolsPending = Math.max(0, toolsPending - 1);
          outputBytes += event.type === "text" ? event.data.length : JSON.stringify(event).length;
          if (outputBytes > 2000000) throw new Error("Response exceeded the chat output limit.");
          if (event.type === "capabilities") {
            thread.capabilities = event.data;
            await emit({ type: "capabilities", capabilities: event.data });
            continue;
          }
          if (event.type === "text" || event.type === "thinking" || event.type === "system_status")
            await emit({ type: event.type, text: event.data });
          else if (event.type === "tool_use" || event.type === "tool_result") await emit(event);
          else if (event.type === "permission_request") {
            recordChatNotification(thread, `${runId}:${event.data.requestId}`, "approval");
            notifySpawner(thread, `${runId}:${event.data.requestId}`, "approval");
            run.permissions.add(event.data.requestId);
            changes.publish("human-requests");
            await emit(event);
            notify(
              "chat",
              chatPush(thread, "Approval needed", "The agent is waiting for your approval."),
            );
          } else if (event.type === "question_request") {
            recordChatNotification(thread, `${runId}:${event.data.requestId}`, "question");
            notifySpawner(thread, `${runId}:${event.data.requestId}`, "question");
            run.questions.set(event.data.requestId, event.data);
            changes.publish("human-requests");
            await emit(event);
            notify("chat", chatPush(thread, "Question", "The agent is waiting for your answer."));
          } else if (event.type === "request_resolved") {
            resolveChatNotification(thread.id, `${runId}:${event.data.requestId}`);
            run.permissions.delete(event.data.requestId);
            run.questions.delete(event.data.requestId);
            changes.publish("human-requests");
            await emit({ type: "request_resolved", requestId: event.data.requestId });
          } else if (event.type === "error") await emit({ type: "error", message: event.data });
        }
        if (!receivedResult && !stopped && failure === null)
          await emit({
            type: "error",
            message:
              "The agent ended before completing the turn. Start a new chat if the session cannot be resumed.",
          });
        const sessionId = noResumableSession ? undefined : run.session?.getRuntimeSessionId?.();
        if (!thread.runtimeId && sessionId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(sessionId))
          thread.runtimeId = sessionId;
        // A backend may explicitly finish with no resumable native session (Pi only
        // persists a session once its transcript has a message). That is a valid
        // completion: there is no native history to lose, so the next send starts fresh.
        completed = receivedResult && (!!thread.runtimeId || noResumableSession) && !stopped;
        if (receivedResult && !thread.runtimeId && !noResumableSession)
          await emit({
            type: "error",
            message:
              "The agent returned no session identity; this conversation cannot continue safely.",
          });
      }
    } catch (error) {
      logger.error("Chat turn failed", { error, runId });
      const message =
        error instanceof Error ? error.message : "The agent could not complete the response.";
      failure ??= message;
      if (!stopped) await emit({ type: "error", message }).catch(() => {});
    } finally {
      clearTimeout(timer);
      clearTimeout(stopFallback);
      if (timedOut) {
        // The stop path is otherwise silent; without this the chat shows a
        // stopped turn with no explanation of why the agent went quiet. The
        // activity entry keeps the reason visible after a reload.
        const hard = Date.now() - startedAt >= turnLimits.hardMs;
        const minutes = Math.max(
          1,
          Math.round((hard ? turnLimits.hardMs : turnLimits.idleMs) / 60000),
        );
        const span = `${minutes} minute${minutes === 1 ? "" : "s"}`;
        const message = hard
          ? `The response was stopped after running for ${span}.`
          : `The response was stopped after ${span} without agent activity.`;
        failure ??= message;
        assistant.activity = appendChatActivity(assistant.activity ?? [], {
          type: "system_status",
          text: message,
        });
        publish(run, { type: "error", message });
      }
      const finishedAt = Date.now();
      assistant.turn = {
        startedAt,
        finishedAt,
        durationMs: agentDurationMs ?? Math.max(0, finishedAt - startedAt),
        outcome: timedOut
          ? "failed"
          : stopped || agentOutcome === "stopped"
            ? "stopped"
            : failure || agentOutcome === "failed"
              ? "failed"
              : "completed",
      };
      assistant.timestamp = finishedAt;
      // Do not pin a native id the backend explicitly reported as non-resumable;
      // there is no persisted session behind it, so the next send starts fresh.
      const nativeId = noResumableSession ? undefined : run.session?.getRuntimeSessionId?.();
      if (!thread.runtimeId && nativeId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(nativeId))
        thread.runtimeId = nativeId;
      if (thread.forkedFrom?.mode === "native" && !thread.runtimeId && !thread.forkPending) {
        // The provider accepted the fork request but never returned an identity.
        // Do not silently start a context-free chat next turn: record the
        // fallback now, and carry the transcript on the retry.
        markFork(
          thread,
          thread.forkedFrom,
          "context",
          failure ?? "The native fork did not establish a session.",
        );
        const fallback = buildContinuation(thread.messages, "fork");
        thread.forkContext = {
          messageCount: fallback.messageCount,
          truncated: fallback.truncated,
          includesActivity: fallback.includesActivity,
        };
      }
      // A switched account has a working session again; stop replaying history.
      if (thread.providerSwitch && completed && thread.runtimeId) delete thread.providerSwitch;
      await run.session?.close().catch(() => {});
      thread.messages.push(assistant);
      if (synced) {
        const mark = await transcriptMark(thread).catch(() => null);
        if (mark) thread.transcriptMark = mark;
      }
      thread.updatedAt = Date.now();
      for (const requestId of [...run.permissions, ...run.questions.keys()])
        resolveChatNotification(thread.id, `${runId}:${requestId}`);
      if (!stopped && (completed || failure))
        recordChatNotification(thread, runId, failure ? "failed" : "finished");
      notifySpawner(
        thread,
        runId,
        timedOut || failure ? "failed" : stopped ? "stopped" : "finished",
      );
      // A watchdog stop is not a user stop: report it so an away user learns
      // the turn died instead of finding a silently frozen conversation.
      if (timedOut) recordChatNotification(thread, runId, "failed");
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
        changes.publish("human-requests", "session-messages");
        publish(run, { type: "turn", turn: assistant.turn });
        publish(run, { type: "done" });
        for (const listener of run.listeners) listener(null);
        finish(
          (completed && failure === null) || responded
            ? null
            : stopped
              ? "The response was stopped."
              : (failure ?? "The agent ended before completing the turn."),
        );
      }
    }
  };
  void execute();
  return { run, done };
}

type SpawnParent = {
  sessionId: string;
  cwd: string | null;
  projectId: string | null;
  host: string | null;
  agent: string | null;
};

function spawnParent(sessionId: string): SpawnParent {
  const chat = store().get(sessionId);
  if (chat)
    return {
      sessionId,
      cwd: chat.cwd,
      projectId: chat.projectId ?? null,
      host: chat.host,
      agent: chat.config.agent,
    };
  const row = getSqlite()
    .query<
      { id: string; cwd: string | null; project_id: string | null; execution_host: string | null },
      [string]
    >(
      "SELECT id, cwd, project_id, execution_host FROM gateway_sessions WHERE id = ?1 OR runtime_session_id = ?1 ORDER BY updated_at DESC LIMIT 1",
    )
    .get(sessionId);
  if (!row) throw new NotFoundError("Session", sessionId);
  return {
    sessionId: row.id,
    cwd: row.cwd,
    projectId: row.project_id,
    host: row.execution_host,
    agent: null,
  };
}

function projectRoot(projectId: string): string {
  const row = getSqlite()
    .query<{ scope: string | null }, [string]>(
      "SELECT scope FROM projects WHERE id = ? AND status = 'active'",
    )
    .get(projectId);
  if (!row) throw new NotFoundError("Project", projectId);
  if (!row.scope) throw new ValidationError("That project has no folder to work in");
  return row.scope;
}

const startingSpawns = new Set<string>();

export async function spawnChat(callerId: string, input: SessionSpawn): Promise<ChatThread> {
  const parent = spawnParent(callerId);
  const parentId = store().get(callerId) ? callerId : parent.sessionId;
  const children = store().children([parentId]);
  if (input.request_id) {
    const existing = children.find((child) => child.spawnedBy?.requestId === input.request_id);
    if (existing) return existing;
  }
  const key = input.request_id ? `${parentId}:${input.request_id}` : null;
  if (key && startingSpawns.has(key))
    throw new ConflictError(
      "This session is already being started; retry with the same request_id",
    );
  if (key) startingSpawns.add(key);
  try {
    return await startChild(parent, parentId, children, input);
  } finally {
    if (key) startingSpawns.delete(key);
  }
}

async function startChild(
  parent: SpawnParent,
  parentId: string,
  children: ChatThread[],
  input: SessionSpawn,
): Promise<ChatThread> {
  if (spawnChain(parentId).length + 1 >= SESSION_MESSAGE_HOP_LIMIT)
    throw new ConflictError(
      `Spawn depth limit (${SESSION_MESSAGE_HOP_LIMIT}) reached; ask a human to start this session`,
    );
  const hourAgo = Date.now() - 60 * 60 * 1000;
  if (
    children.filter((child) => (child.spawnedBy?.at ?? 0) >= hourAgo).length >=
    SESSION_SPAWN_HOURLY_LIMIT
  )
    throw new ConflictError(
      `Hourly spawn limit (${SESSION_SPAWN_HOURLY_LIMIT}) reached for this session`,
    );
  const projectId = input.project_id ?? parent.projectId;
  const crossProject = !!input.project_id && input.project_id !== parent.projectId;
  if (input.workspace === "same" && crossProject)
    throw new ValidationError(
      "A session in another project cannot share this folder; use workspace worktree or project",
    );
  const base =
    input.workspace === "same" || (input.workspace === "worktree" && !crossProject)
      ? parent.cwd
      : projectId
        ? projectRoot(projectId)
        : null;
  if (!base) throw new ValidationError("The calling session has no folder to start from");
  const source = store().get(parentId);
  const agent = input.agent ?? parent.agent ?? undefined;
  const sameAgent = !!source && agent === source.config.agent;
  if (source?.toolAllowlist && agent !== "claude")
    throw new ValidationError(
      "This session has a tool allowlist that only Claude can enforce; start a Claude child",
    );
  const backend = agent ? chatBackendFor(agent) : null;
  const permissionMode = source?.config.permissionMode ?? "default";
  const run = await openChat(
    {
      messages: [{ role: "user", content: input.prompt }],
      ...(agent ? { agent } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(projectId ? { projectId } : {}),
      ...(backend && createBackend(backend).capabilities?.livePermissions !== false
        ? { permissionMode }
        : {}),
      ...(sameAgent && source
        ? {
            agentOptions: source.config.agentOptions,
            ...(source.config.providerId ? { providerId: source.config.providerId } : {}),
          }
        : {}),
      workspace: {
        host: crossProject ? undefined : parent.host,
        cwd: base,
        worktree: input.workspace === "worktree",
      },
    },
    [],
    {
      sessionId: parentId,
      at: Date.now(),
      notify: input.notify,
      ...(input.request_id ? { requestId: input.request_id } : {}),
    },
    source?.toolAllowlist,
  );
  if (input.title) {
    run.thread.title = input.title;
    store().save(run.thread);
  }
  return run.thread;
}

export function chatStatus(id: string): SessionStatus {
  const thread = requireThread(id);
  const run = threadRun(id)?.[1];
  const last = [...thread.messages].reverse().find((message) => message.role === "assistant");
  const waitingFor = run?.permissions.size ? "approval" : run?.questions.size ? "question" : null;
  const outcome = last?.turn?.outcome;
  const queue = new SessionMessageStore(getSqlite())
    .queued(thread.id)
    .map(({ id, state, position }) => ({ id, state, position }));
  return {
    session_id: thread.id,
    title: thread.title,
    agent: thread.config.agent,
    status: run
      ? waitingFor
        ? "waiting"
        : "running"
      : queue.length
        ? "running"
        : outcome === "failed"
          ? "failed"
          : outcome === "stopped"
            ? "stopped"
            : "idle",
    waiting_for: waitingFor,
    last_message: last?.content || null,
    queue,
    parent_session_id: thread.spawnedBy?.sessionId ?? null,
    children: store()
      .children([thread.id])
      .map((child) => child.id),
    project_id: thread.projectId ?? null,
    cwd: thread.cwd,
    updated_at: thread.updatedAt,
  };
}

function nativeRun(target: ChatTarget): [string, ChatRun] | undefined {
  if ("threadId" in target) return threadRun(target.threadId);
  const key = turnKey(target.host, target.backend, target.runtimeId);
  return [...runs].find(([, run]) => run.key === key);
}

registerChatControl({
  turn: (target, prompt) => {
    const thread =
      "threadId" in target
        ? store().get(target.threadId)
        : store()
            .byRuntime(target.backend, target.host, target.runtimeId)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!thread || threadRun(thread.id) || runs.size >= 4) return null;
    return beginTurn(thread, prompt, { reserved: true }).then(({ done }) => done);
  },
  canSteer: (target) => {
    const run = nativeRun(target)?.[1];
    return steerable(run) && run.steering.size < STEER_LIMIT;
  },
  steer: async (target, text) => {
    const run = nativeRun(target)?.[1];
    if (!steerable(run) || run.steering.size >= STEER_LIMIT) return false;
    await steerRun(run, text, crypto.randomUUID());
    return true;
  },
  stop: (threadId) => {
    const run = threadRun(threadId)?.[1];
    run?.stop();
    return !!run;
  },
  running: (threadId) => !!threadRun(threadId),
  full: () => runs.size >= 4,
});

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

export { app as chatRouter, continuationPrompt };
