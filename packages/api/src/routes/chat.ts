import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, posix, sep } from "node:path";
import { createRoute, z } from "@hono/zod-openapi";
import {
  type AgentSession,
  chatBackendFor,
  createBackend,
  discoverAgentCommands,
  discoverAgentModels,
  discoverOpenCodeEffortChoices,
  type RuleGap,
  type SessionOpts,
  SteerNotConsumedError,
  sessionRules,
  UNKNOWN_CAPABILITIES,
} from "@orc/agent-runtime";
import { readAgent, renderAgentInstructions } from "@orc/core/agent-service";
import { changes } from "@orc/core/changes";
import {
  AGENT_COMMAND_PATTERN,
  appendChatActivity,
  CHAT_HISTORY_PAGE_SIZE,
  CHAT_PROVIDER_REFS_MAX,
  CHAT_SESSION_BUSY_CODE,
  CHAT_SUBAGENT_DONE,
  CHAT_TURN_HARD_LIMIT_MS,
  type ChatAgentCommands,
  ChatAgentCommandsSchema,
  ChatAnswersSchema,
  type ChatEvent,
  ChatFilesSchema,
  ChatHistoryPageSchema,
  type ChatMessage,
  ChatMessageSchema,
  ChatModelSchema,
  type ChatModels,
  ChatModelsSchema,
  ChatPermissionModeSchema,
  type ChatProviderRefSource,
  type ChatQuestion,
  ChatSettingsSchema,
  type ChatSpawn,
  type ChatThread,
  ChatThreadSchema,
  type ChatTurn,
  ChatWorkspaceSchema,
  chatAnswerText,
  chatSystemPrompt,
  nativeChatAgent,
  nativeChatResumeUnavailableReason,
  ownsChatActivity,
} from "@orc/core/chat";
import { ChatAnalyticsSchema } from "@orc/core/chat-analytics";
import { expandChatCommands } from "@orc/core/chat-commands";
import {
  type ChatTurnContext,
  ChatTurnContextSchema,
  VOICE_TURN_INSTRUCTION,
  withOrcContext,
} from "@orc/core/chat-context";
import { chatTurnLeaseIsLive } from "@orc/core/chat-lease";
import { ChatAgentOptionsMapSchema, unsupportedPermissionMode } from "@orc/core/chat-options";
import { canonicalAgentId, codingAgent, supportsModelDiscovery } from "@orc/core/coding-agents";
import { loadConfig } from "@orc/core/config";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  OrcError,
  ValidationError,
} from "@orc/core/errors";
import {
  execHostFor,
  hostAlias,
  hostHome,
  hostRuntime,
  listHostEntries,
  resolveExecHost,
} from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import { notificationTitle } from "@orc/core/notifications";
import { AgentSetupSchema } from "@orc/core/package-launch";
import { SecretRefsMapSchema } from "@orc/core/project-secrets";
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
import { prepareSessionDirectory } from "@orc/core/session-dir";
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
  type SessionDelivery,
  type SessionMessageSender,
  type SessionSpawn,
  type SessionStatus,
} from "@orc/core/session-messages";
import { renderSkillInstructions } from "@orc/core/skill-service";
import { AgentCapabilitiesSchema } from "@orc/core/types";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { McpPromptStore } from "@orc/db/mcp-prompts";
import { notificationProjectLabel } from "@orc/db/notification-producers";
import { resolveExplicitSecretRefs } from "@orc/db/project-secrets";
import { RuleStore } from "@orc/db/rules";
import { gateway_sessions, session_handoffs } from "@orc/db/schema";
import { SessionMessageStore } from "@orc/db/session-messages";
import { SkillHistory } from "@orc/db/skill-history";
import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rememberTerminalFolder } from "../git/registry.js";
import { getHandoffService } from "../handoffs/service.js";
import { queuedAnswers } from "../human-request-delivery.js";
import { installPackageForChat } from "../lib/package-launch.js";
import { createRouter } from "../lib/router.js";
import { unbufferedSSE } from "../lib/sse.js";
import { isDraining } from "../lifecycle.js";
import {
  recordChatNotification,
  resolveChatNotification,
  retireChatNotifications,
} from "../notifications.js";
import { notify, truncate } from "../push/service.js";
import { parseRemoteTarget, startRemoteChat } from "../remote-hosts.js";
import { LIVE_CHAT_ID, liveRunFields, settleStaleRun } from "../session-watcher.js";
import { loadSessionCacheUsage } from "../sessions/cache-usage.js";
import { chatAnalyticsFor } from "../sessions/chat-analytics.js";
import { chatHistory } from "../sessions/chat-history.js";
import { isClaudeProcessName } from "../sessions/claude.js";
import { isAlive, projectIdFor } from "../sessions/common.js";
import {
  childWorkCounts,
  childWorkCountsMany,
  notifySpawner,
  requireAncestor,
  spawnChain,
} from "../sessions/control.js";
import { opencodeSessionUpdated } from "../sessions/opencode.js";
import { codexWriterOwned } from "../sessions/ownership.js";
import { resolveSessionRef } from "../sessions/resolve.js";
import { readTranscriptBytes, type TranscriptTurn } from "../sessions/transcript.js";
import { loadTranscriptBytes, transcriptCacheKey } from "../sessions/transcript-source.js";
import { activeTurns, type ChatTarget, registerChatControl, turnKey } from "../sessions/turns.js";
import { selectedTerminalHost } from "../terminals/host.js";
import { launchDeps, sessionDirDeps } from "../terminals/service.js";
import { voiceNotice } from "../voice.js";
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
const sessionGrants = new Map<string, Set<string>>();
interface ChatRun {
  session: AgentSession | null;
  permissions: Map<string, string>;
  questions: Map<string, ChatQuestion>;
  steering: Map<string, { input: string; result: Promise<ChatThread> }>;
  threadId: string;
  thread: ChatThread;
  key: string;
  runId: string;
  startedAt: number;
  lastActivityAt: number;
  lastActivity: string | null;
  activityCount: number;
  /** Identity this turn resumed, so a shutdown flush never swaps it silently. */
  runtimeIdAtStart?: string | null;
  /** This turn continued on a fresh session because the pinned one was gone. */
  handedOff?: boolean;
  /** Resolves once the turn has settled its transcript and terminal lease, or
   *  failed to save; either way it no longer holds the thread. A confirmed push
   *  waits on this rather than `ended`. */
  finalized: Promise<void>;
  markFinalized: () => void;
  events: string[];
  /** Events from here on reconstruct the live turn; earlier prose is already stored. */
  replayFrom?: number;
  /** Still-pending prompts, re-emitted on attach so a replay cutoff never hides one. */
  pending: Map<string, ChatEvent>;
  listeners: Set<(data: string | null) => void>;
  stop: () => void;
  /** Stop was requested; the turn stays in `runs` until it drains. */
  stopping?: boolean;
  say?: (text: string) => Promise<void>;
  /** Set once the event stream is over: later interjections append, never seal. */
  ended: boolean;
  /** Messages recorded after the boundary; the final segment is inserted before them. */
  lateMessages: string[];
  /** Request ids the agent or a successful respond already resolved. */
  resolved: Set<string>;
  /** Freeze the prose streamed so far as its own assistant message, before `beforeId`. */
  sealAssistant?: (beforeId?: string) => ChatMessage | undefined;
  /** Undo a seal whose human message was refused, when no later interjection owns it. */
  unsealAssistant?: (sealed: ChatMessage, beforeId: string) => void;
  settleHeld?: () => Promise<void>;
}
const runs = new Map<string, ChatRun>();

/**
 * A turn is stopped after `idleMs` without any agent event, re-checking every
 * `recheckMs` while it waits for a human answer or an in-flight tool call, and
 * never runs past `hardMs`. After a cooperative Stop, `stopGraceMs` bounds how long
 * we wait for the agent to end the turn before forcing the transport closed. Tests
 * shorten these through setChatTurnLimits.
 *
 * `leaseHeartbeatMs` debounces the durable liveness beat of a running turn lease.
 * `shutdownWaitMs`/`shutdownStopMs` bound the daemon-shutdown drain: how long
 * active turns get to finish on their own, then how long a cooperative Stop gets
 * to record their outcome before the resumable identity is flushed as-is.
 */
const turnLimits = {
  idleMs: 15 * 60000,
  recheckMs: 60_000,
  hardMs: CHAT_TURN_HARD_LIMIT_MS,
  stopGraceMs: 10_000,
  leaseHeartbeatMs: 15_000,
  shutdownWaitMs: 3_000,
  shutdownStopMs: 3_000,
  /** How long a confirmed push waits for the running turn to stop and finalize. */
  confirmBusyGraceMs: 12_000,
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
            ...[...run.permissions.keys()].map((id) => ({
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
    for (const data of run.events.slice(run.replayFrom ?? 0)) send(data);
    // A replay cutoff can hide a prompt raised before the last interjection. Re-emit
    // anything still pending (unbuffered) so a reattached client never misses a card
    // the turn is still waiting on.
    if (!run.ended) for (const event of run.pending.values()) send(JSON.stringify(event));
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

type BusyTurn =
  | { kind: "local"; run: ChatRun }
  | { kind: "other-daemon"; pid: number | null }
  | { kind: "reserved" };

/**
 * Who currently owns a turn for this thread. Only a turn this daemon is running
 * can be taken over: a lease held by another live daemon on this machine cannot
 * be stopped from here, and writing into its native session from a second
 * process would open the same conversation twice.
 */
function busyTurnFor(thread: ChatThread, key: string): BusyTurn | undefined {
  const local = threadRun(thread.id)?.[1];
  if (local) return { kind: "local", run: local };
  const lease = thread.turn;
  if (lease && chatTurnLeaseIsLive(lease)) return { kind: "other-daemon", pid: lease.pid ?? null };
  if (active.has(key)) return { kind: "reserved" };
  return undefined;
}

/** Resolves true when the promise settles, false when the budget runs out. */
function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(1, ms));
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Settles a live turn before a new send starts. Without `confirmBusy` it answers
 * the client's SESSION_BUSY contract; with it, the turn this daemon owns is
 * stopped and this waits for its transcript and terminal lease to be saved. The
 * returned thread is the one the caller must continue from: the stopped turn's
 * assistant message and final lease are only on disk after that save.
 *
 * A turn owned by another live daemon cannot be stopped from here, and writing
 * into its native session from a second process would open the conversation
 * twice, so it is refused either way.
 */
async function settleBusyTurn(
  thread: ChatThread,
  confirmBusy: boolean | undefined,
): Promise<ChatThread> {
  const keyOf = (value: ChatThread) =>
    value.runtimeId ? turnKey(value.host, value.backend, value.runtimeId) : value.id;
  const busy = busyTurnFor(thread, keyOf(thread));
  if (!busy) return thread;
  const busyError = () =>
    new ConflictError("This session is already responding.", CHAT_SESSION_BUSY_CODE, {
      canTakeOver: busy.kind === "local",
      reason: busy.kind,
      ...(busy.kind === "other-daemon" && busy.pid ? { pid: busy.pid } : {}),
    });
  if (!confirmBusy) throw busyError();
  if (busy.kind !== "local")
    throw new ConflictError(
      busy.kind === "other-daemon"
        ? `Another ORC daemon${busy.pid ? ` (pid ${busy.pid})` : ""} owns the live turn in this conversation. Pushing in would open a second agent session on the same conversation. Wait for it to finish, or stop that daemon first.`
        : "This session is reserved by another request. Wait for it to finish.",
      CHAT_SESSION_BUSY_CODE,
      { canTakeOver: false },
    );
  busy.run.stop();
  // `finalized`, not `ended`: the turn has saved its transcript and lease.
  if (!(await withTimeout(busy.run.finalized, turnLimits.confirmBusyGraceMs)))
    throw new ConflictError(
      "The running turn did not stop in time. Try again; the conversation stays resumable.",
      CHAT_SESSION_BUSY_CODE,
      { canTakeOver: true },
    );
  const settled = store().get(thread.id) ?? thread;
  // Another request may have claimed the thread while the stop was finalizing.
  const still = busyTurnFor(settled, keyOf(settled));
  if (still)
    throw new ConflictError("This session is already responding.", CHAT_SESSION_BUSY_CODE, {
      canTakeOver: still.kind === "local",
    });
  return settled;
}

/** A native identity must look like one before it is trusted on disk. */
const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/** Written into the transcript when a turn continues on a fresh session. */
const CHAT_RECOVERY_NOTICE =
  "This conversation's agent session was no longer available, so it continues on a fresh session with the stored transcript.";

/** A ref is `resumed` only when this turn continued the identity it started with. */
function providerRefSource(
  runtimeIdAtStart: string | null | undefined,
  handedOff: boolean | undefined,
): ChatProviderRefSource {
  return runtimeIdAtStart && !handedOff ? "resumed" : "started";
}

/**
 * Records an attachment to a native session in the thread's ref history. Refs
 * are deduplicated by identity and kept most-recent-last: a resume refreshes
 * the entry instead of growing the array, while a provider switch keeps the old
 * ref because it may still be resumable.
 */
function attachProviderRef(
  thread: ChatThread,
  runtimeId: string,
  source: ChatProviderRefSource,
): void {
  const refs = (thread.providerRefs ?? []).filter(
    (ref) =>
      !(
        ref.backend === thread.backend &&
        (ref.host ?? null) === (thread.host ?? null) &&
        ref.runtimeId === runtimeId
      ),
  );
  refs.push({
    backend: thread.backend,
    host: thread.host,
    runtimeId,
    cwd: thread.cwd,
    attachedAt: Date.now(),
    source,
  });
  thread.providerRefs = refs.slice(-CHAT_PROVIDER_REFS_MAX);
}

/**
 * Write-through of the resumable identity: the moment a backend exposes its
 * native id it goes to disk (targeted json_set, no message rewrite), so a crash
 * before the terminal result can never orphan the thread from its session. A
 * failed write is logged, not fatal: the turn-end save retries it.
 */
function persistProviderRef(thread: ChatThread, runId: string): void {
  try {
    store().setRuntimeRef(
      thread.id,
      runId,
      thread.turn?.epoch ?? 0,
      thread.runtimeId,
      thread.providerRefs ?? [],
    );
  } catch (error) {
    logger.warn("Provider ref write-through failed", { error, threadId: thread.id, runId });
  }
}

/**
 * Pins the session's current native id (if the backend already exposes one)
 * into the thread and writes it through. `source` records how this turn
 * attached: resuming the pinned identity, or starting/forking a fresh one.
 * A session that reports a DIFFERENT id than the thread's pinned one never
 * overwrites it here: the result-event guard owns identity replacement, so a
 * silent provider swap cannot steal the durable ref mid-turn.
 */
function writeThroughRuntimeId(
  thread: ChatThread,
  runId: string,
  session: AgentSession | null,
  source: ChatProviderRefSource,
): void {
  const nativeId = session?.getRuntimeSessionId?.();
  if (!nativeId || !NATIVE_SESSION_ID_PATTERN.test(nativeId)) return;
  if (thread.runtimeId && thread.runtimeId !== nativeId) return;
  thread.runtimeId = nativeId;
  attachProviderRef(thread, nativeId, source);
  persistProviderRef(thread, runId);
}
const params = z.object({ id });
const modelCatalogs = new Map<string, { at: number; result: Promise<ChatModels> }>();
let modelRequests = 0;

export function requireThread(id: string): ChatThread {
  const thread = store().get(id);
  if (!thread) throw new NotFoundError("Chat", id);
  // Older conversations used the built-in adapter, never a later named default.
  thread.config.providerId ??= thread.config.agent;
  return thread;
}

function chatPush(thread: ChatThread, status: string, body: string): PushMessage {
  const project = notificationProjectLabel(getSqlite(), thread.projectId, thread.cwd);
  return {
    title: notificationTitle(`${status} · ${truncate(thread.title, 120)}`, project),
    body,
    url: `/chat?chatThread=${encodeURIComponent(thread.id)}&project=${encodeURIComponent(thread.projectId ?? "all")}`,
    tag: `chat:${thread.id}`,
  };
}

async function chatTarget(
  thread: ChatThread | null,
  requestedHost: string | undefined,
  requestedCwd: string | undefined,
) {
  if (thread && (requestedHost !== undefined || requestedCwd !== undefined))
    throw new ValidationError("A conversation owns its execution host and working directory.");
  const host = thread
    ? execHostFor(thread.host)
    : requestedHost === undefined
      ? resolveExecHost()
      : execHostFor(requestedHost === "__local__" ? null : requestedHost);
  const cwd =
    thread?.cwd ?? requestedCwd ?? (host.kind === "ssh" ? await hostHome(host) : homedir());
  return { host, cwd };
}

const chatTargetQuery = {
  threadId: id.optional(),
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
};

const commandCatalogs = new Map<string, { at: number; result: Promise<ChatAgentCommands> }>();

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/commands",
    tags: ["Chat"],
    summary: "List the agent's own slash commands and skills",
    request: {
      query: z
        .object({
          agent: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i),
          providerId: ProviderIdSchema.optional(),
          ...chatTargetQuery,
        })
        .strict(),
    },
    responses: {
      200: {
        description: "Commands and skills reported by the selected coding agent",
        content: { "application/json": { schema: ChatAgentCommandsSchema } },
      },
    },
  }),
  async (c) => {
    const { agent, threadId, providerId, host: requestedHost, cwd } = c.req.valid("query");
    const thread = threadId ? requireThread(threadId) : null;
    if (thread && thread.config.agent !== agent)
      throw new ValidationError("The agent does not match this conversation.");
    const selectedProvider = providerId ?? thread?.config.providerId;
    providerForAgent(agent, selectedProvider, true);
    const target = await chatTarget(thread, requestedHost, cwd);
    const key = JSON.stringify([
      agent,
      target.host.kind === "ssh" ? target.host.alias : null,
      target.cwd,
      selectedProvider,
      providerRevision(),
    ]);
    const cached = commandCatalogs.get(key);
    if (cached && Date.now() - cached.at < 60_000) return c.json(await cached.result);
    const result = discoverAgentCommands(agent, target.host, target.cwd, selectedProvider)
      .then((commands): ChatAgentCommands => ({ commands, warning: null }))
      .catch(
        (): ChatAgentCommands => ({
          commands: [],
          warning: "Agent commands unavailable",
        }),
      );
    if (commandCatalogs.size >= 32) {
      const oldest = commandCatalogs.keys().next().value;
      if (oldest !== undefined) commandCatalogs.delete(oldest);
    }
    commandCatalogs.set(key, { at: Date.now(), result });
    const response = await result;
    if (response.warning) commandCatalogs.delete(key);
    return c.json(response);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/files",
    tags: ["Chat"],
    summary: "List a folder under the conversation's working directory on its execution host",
    request: {
      query: z
        .object({
          path: z
            .string()
            .max(4096)
            .refine(
              (value) =>
                !value.includes("\0") && !isAbsolute(value) && !value.split(/[\\/]/).includes(".."),
              "Use a path inside the working directory",
            )
            .default(""),
          ...chatTargetQuery,
        })
        .strict(),
    },
    responses: {
      200: {
        description: "Files and folders in that folder",
        content: { "application/json": { schema: ChatFilesSchema } },
      },
    },
  }),
  async (c) => {
    const { threadId, host: requestedHost, cwd, path } = c.req.valid("query");
    const target = await chatTarget(threadId ? requireThread(threadId) : null, requestedHost, cwd);
    const folder =
      target.host.kind === "ssh" ? posix.join(target.cwd, path) : join(target.cwd, path);
    return c.json({ entries: await listHostEntries(target.host, folder) });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/models",
    tags: ["Chat"],
    request: {
      query: z
        .object({
          agent: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/i),
          providerId: ProviderIdSchema.optional(),
          ...chatTargetQuery,
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
    const { host, cwd } = await chatTarget(thread, requestedHost, requestedCwd);
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
      .then(async (models): Promise<ChatModels> => {
        // OpenCode's effort levels are model-dependent and only readable over a
        // live ACP handshake; probe them alongside the catalog for a new chat.
        const effortChoices =
          agent === "opencode"
            ? await discoverOpenCodeEffortChoices(host, cwd, selectedProvider).catch(() => null)
            : null;
        return {
          models,
          warning: models.length
            ? null
            : "No models were reported. Choose a saved or custom model.",
          ...(effortChoices ? { effortChoices } : {}),
        };
      })
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

function permissionModeSupported(
  backend: string,
  mode: z.infer<typeof ChatPermissionModeSchema>,
): boolean {
  return createBackend(backend).capabilities?.permissionModes?.includes(mode) === true;
}

const STEER_LIMIT = 32;
/** The message may already be in the conversation, so a client must not resend it. */
const STEER_UNCONFIRMED = "STEER_UNCONFIRMED";

/**
 * Record a human message that joined the running turn (a steer or an answer).
 * The prose streamed so far is sealed before it so the transcript keeps the
 * order things happened in, and attached clients split their live stream at the
 * same point. A reattach replays only what follows: the sealed prose is already
 * in the stored thread, and the slim thread event still names the run. Once the
 * turn's final segment is pushed the message appends without sealing — the reply
 * was already complete, so it belongs below it.
 */
async function recordInterjection(
  run: ChatRun,
  message: ChatMessage,
): Promise<ChatMessage | undefined> {
  // Voice holds prose for a settle pass; it belongs to the segment being sealed.
  await run.settleHeld?.();
  const sealed = run.ended ? undefined : run.sealAssistant?.(message.id);
  if (!run.thread.messages.some((entry) => entry.id === message.id)) {
    run.thread.messages.push(message);
    if (run.ended) run.lateMessages.push(message.id);
  }
  run.thread.updatedAt = Date.now();
  publish(run, { type: "interjection", message });
  publishThreadSnapshot(run);
  return sealed;
}

/** Slim thread + turn events; reattach replays from here, after the interjection. */
function publishThreadSnapshot(run: ChatRun): void {
  publish(run, {
    type: "thread",
    thread: { ...run.thread, messages: run.thread.messages.slice(-1) },
    runId: run.runId,
  });
  publish(run, { type: "turn", turn: { startedAt: run.startedAt } });
  run.replayFrom = run.events.length - 2;
}

function steerable(
  run: ChatRun | undefined,
): run is ChatRun & { session: AgentSession & Required<Pick<AgentSession, "steer">> } {
  return (
    !!run?.session?.steer &&
    run.session.capabilities?.steering === true &&
    !run.ended &&
    !run.permissions.size &&
    !run.questions.size
  );
}

async function steerRun(
  run: ChatRun,
  input: string,
  requestId: string,
  deliveries?: SessionDelivery[],
): Promise<ChatThread> {
  if (run.permissions.size || run.questions.size)
    throw new ConflictError("Answer the pending prompt first. Queue a message instead.");
  if (!steerable(run))
    throw new ConflictError("This response cannot be steered. Queue a message instead.");
  if (input.trim() === "/compact")
    throw new ConflictError("Wait for this turn to finish before compacting context.");
  const previous = run.steering.get(requestId);
  if (previous) {
    if (previous.input !== input)
      throw new ConflictError(
        "This steering request ID already has different content.",
        STEER_UNCONFIRMED,
      );
    return previous.result;
  }
  if (run.steering.size >= STEER_LIMIT)
    throw new ConflictError(
      "This response has reached its steering limit. Queue a message instead.",
    );
  if (run.thread.messages.some((message) => message.id === requestId))
    throw new ConflictError("This message ID is already in use.", STEER_UNCONFIRMED);
  const steer = run.session.steer.bind(run.session);
  let dispatched = false;
  const deliver = async (): Promise<ChatThread> => {
    const message: ChatMessage = {
      id: requestId,
      role: "user",
      content: input,
      ...(deliveries?.length ? { deliveries } : {}),
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
    // Record at dispatch: the moment the human sent the message is its place in the
    // transcript, independent of when (or whether) the agent acknowledges delivery.
    const sealed = await recordInterjection(run, message);
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
    } catch (error) {
      if (error instanceof SteerNotConsumedError) {
        // The agent confirmed it did not take the text: roll the intent back so
        // the client can queue the same message without duplicating it.
        run.thread.messages = run.thread.messages.filter((entry) => entry.id !== requestId);
        if (sealed) run.unsealAssistant?.(sealed, requestId);
        run.steering.delete(requestId);
        saveDelivery();
        // Reattaching clients must not replay the rolled-back interjection.
        publishThreadSnapshot(run);
        throw new ConflictError(
          "This response cannot take the message right now. Queue a message instead.",
        );
      }
      message.activity = [
        {
          type: "status",
          id: `steering:${requestId}`,
          text: "Delivery unconfirmed. Check the response before sending again.",
        },
      ];
      saveDelivery();
      throw new ConflictError(
        "Steering delivery could not be confirmed. Check the response before sending another message; this text may already be in the conversation.",
        STEER_UNCONFIRMED,
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
  const normalizedAgent = agent ? canonicalAgentId(agent) : undefined;
  const config = providerChatDefaults(providerId, normalizedAgent, chatMockEnabled());
  if (normalizedAgent) config.agent = normalizedAgent;
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
    // A moved session carries a one-time briefing into its first chat turn so
    // the agent knows it resumed on another machine. Only an unconsumed ready
    // handoff supplies it; later resumes must not repeat it.
    const handoff = await getDb().query.session_handoffs.findFirst({
      where: eq(session_handoffs.live_session_id, source.id),
    });
    if (handoff?.status === "ready" && handoff.request.briefing)
      thread.handoffBriefing = handoff.request.briefing;
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

/** A chat can attach to a native session ORC already discovered (for example
 *  when a second chat reuses it); record that source so Resume session ID and
 *  handoff checks name the real session instead of showing empty. */
async function linkNativeSource(thread: ChatThread): Promise<ChatThread> {
  if (thread.sourceId || !thread.runtimeId) return thread;
  const source = await nativeSource(thread);
  if (!source) return thread;
  // A targeted update, not save(): readers can race a running turn's save.
  store().setSourceId(thread.id, source.id);
  thread.sourceId = source.id;
  return thread;
}

async function transcriptMark(thread: ChatThread, source?: NativeSource | null) {
  const row = source === undefined ? await nativeSource(thread) : source;
  if (!row?.transcript_path) return null;
  const runtime = hostRuntime(execHostFor(thread.host));
  if (row.backend === "opencode") {
    const updated = await opencodeSessionUpdated(
      runtime,
      row.transcript_path,
      row.runtime_session_id ?? "",
    ).catch(() => null);
    return updated === null ? null : `opencode:${updated}`;
  }
  const info = await runtime.stat(row.transcript_path).catch(() => null);
  return info ? `${info.size}:${info.mtimeMs}` : null;
}

/** Freeze the session's latest recorded request as this turn's token figure so a
 *  finished turn does not keep drifting as later requests are recorded. Best-effort:
 *  a read failure leaves the figure to the live usage view. */
async function captureTurnUsage(
  thread: ChatThread,
  startedAt: number,
  contextWindow: number | undefined,
): Promise<NonNullable<ChatTurn["usage"]> | undefined> {
  try {
    const source = await nativeSource(thread);
    if (!source?.transcript_path || !["claude", "codex", "pi", "opencode"].includes(source.backend))
      return undefined;
    const usage = await loadSessionCacheUsage(
      hostRuntime(execHostFor(source.execution_host ?? null)),
      source.backend,
      source.transcript_path,
      source.runtime_session_id ?? null,
    );
    const latest = usage.latest;
    if (!latest || latest.input_tokens <= 0) return undefined;
    const at = latest.recorded_at ? Date.parse(latest.recorded_at) : Number.NaN;
    // A figure recorded before this turn began belongs to an earlier turn.
    if (Number.isFinite(at) && at < startedAt) return undefined;
    const window = contextWindow ?? latest.context_window;
    return {
      input_tokens: latest.input_tokens,
      cached_input_tokens: latest.cached_input_tokens,
      ...(latest.context_tokens !== null ? { context_tokens: latest.context_tokens } : {}),
      ...(window ? { context_window: window } : {}),
    };
  } catch {
    return undefined;
  }
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
  thread.messages = chatHistory(transcript.turns, source.backend, thread.config.model);
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
  kind: "switch" | "fork" | "recovery" = "switch",
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
      : kind === "recovery"
        ? "[ORC recovery] This conversation could not resume its previous agent session, so it continues on a fresh one. The history below is the conversation so far. Continue the same work, then handle the new user message. Tool calls are summarized; do not repeat the history unless asked. Before repeating an external side effect (a push, a filed issue, a sent message), check whether it already happened."
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
  kind: "switch" | "fork" | "recovery" = "switch",
): string | undefined {
  return buildContinuation(messages, kind).prompt;
}

/**
 * A moved session delivers its one-time handoff briefing with the first real
 * turn, so the agent knows it resumed on another machine. Consuming clears the
 * field; /compact leaves it for the next turn.
 */
export function consumeHandoffBriefing(
  thread: ChatThread,
  input: string,
  continuation: string | undefined,
): string | undefined {
  if (!thread.handoffBriefing || input.trim() === "/compact") return continuation;
  const briefing = thread.handoffBriefing;
  delete thread.handoffBriefing;
  return continuation ? `${briefing}\n\n${continuation}` : briefing;
}

app.openapi(
  createRoute({
    method: "get",
    path: "/chat/threads",
    tags: ["Chat"],
    request: {
      query: z.object({
        include_hidden: z
          .enum(["true", "false"])
          .optional()
          .default("false")
          .transform((v) => v === "true")
          .openapi({ description: "Include chats whose session a human hid from the list" }),
      }),
    },
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
                  workingChildren: z.number().int(),
                  waitingChildren: z.number().int(),
                  agent: z.string().nullable().optional(),
                  runtimeId: z.string().nullable().optional(),
                  sourceId: z.string().nullable().optional(),
                  host: z.string().nullable().optional(),
                  projectId: z.string().nullable().optional(),
                  spawnedFrom: z.string().nullable().optional(),
                }),
              ),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const { include_hidden } = c.req.valid("query");
    const threads = store().list();
    const sourceIds = [
      ...new Set(threads.flatMap((thread) => (thread.sourceId ? [thread.sourceId] : []))),
    ];
    const sources = sourceIds.length
      ? await getDb().query.gateway_sessions.findMany({
          where: inArray(gateway_sessions.id, sourceIds),
          columns: {
            id: true,
            title: true,
            display_title: true,
            cwd: true,
            hidden_at: true,
            backend: true,
            runtime_session_id: true,
            execution_host: true,
          },
        })
      : [];
    const sourceById = new Map(sources.map((row) => [row.id, row]));
    const sourceTitle = (thread: { title: string; sourceId: string | null; resumed: number }) => {
      const source = thread.sourceId ? sourceById.get(thread.sourceId) : undefined;
      const title = source && (source.display_title ?? source.title);
      if (!title) return null;
      return thread.resumed || isClaudeProcessName(thread.title, source.cwd) ? title : null;
    };
    const visible = threads.filter(
      (thread) =>
        include_hidden || !(thread.sourceId && sourceById.get(thread.sourceId)?.hidden_at),
    );
    // One batched rollup for the whole list; summaries carry no strict thread parse,
    // so legacy and corrupt rows keep listing with zero counts.
    const counts = childWorkCountsMany(
      visible.map((thread) => {
        const source = thread.sourceId ? sourceById.get(thread.sourceId) : undefined;
        return {
          id: thread.id,
          nativeId: thread.runtimeId ?? source?.runtime_session_id ?? null,
          backend: thread.backend ?? source?.backend ?? null,
          host: thread.host ?? source?.execution_host ?? null,
        };
      }),
    );
    return c.json({
      threads: visible.map(({ resumed, backend, ...thread }) => {
        const count = counts.get(thread.id);
        return {
          ...thread,
          title: sourceTitle({ ...thread, resumed }) || thread.title,
          running: !!threadRun(thread.id),
          workingChildren: count?.working ?? 0,
          waitingChildren: count?.waiting ?? 0,
        };
      }),
    });
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/chat/threads/{id}",
    tags: ["Chat"],
    request: { params },
    responses: response,
  }),
  async (c) => c.json(await linkNativeSource(requireThread(c.req.valid("param").id))),
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
  async (c) => {
    const messageId = c.req.valid("param").id;
    const thread = store().byMessage(messageId);
    if (!thread) throw new NotFoundError("Chat message", messageId);
    return c.json(await linkNativeSource(thread));
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
              workingChildren: z.number().int(),
              waitingChildren: z.number().int(),
              stopping: z.boolean(),
              live: z
                .object({
                  id: z.string(),
                  agent: z.string(),
                  tokens_used: z.number().nullable(),
                  tokens_estimated: z.boolean(),
                  status: z.enum(["idle", "running", "stopped", "error"]),
                  waiting_for_human: z.boolean(),
                  waiting_for: z
                    .object({
                      reason: z.enum(["permission", "question", "dialog"]),
                      tool: z.string().nullable(),
                    })
                    .nullable(),
                  background_work: z.boolean(),
                  created_at: z.string().datetime(),
                  last_activity_at: z.string().datetime().nullable(),
                })
                .nullable(),
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
    const source = await nativeSource(thread);
    // A stale watcher "running" claim must not pop the working panel on an idle
    // session: verify it against the native store before the chat trusts it.
    const liveStatus = source && !running ? await settleStaleRun(source) : source?.status;
    const childWork = childWorkCounts(thread.id);
    return c.json({
      changed,
      running,
      workingChildren: childWork.working,
      waitingChildren: childWork.waiting,
      stopping: threadRun(thread.id)?.[1]?.stopping === true,
      live: source
        ? {
            id: source.id,
            agent: source.backend,
            tokens_used: source.tokens_used ?? null,
            tokens_estimated: source.backend === "cursor" && source.tokens_used != null,
            status: liveStatus ?? source.status,
            ...liveRunFields(
              source.backend,
              source.execution_host ?? null,
              source.runtime_session_id ?? null,
            ),
            created_at: source.created_at.toISOString(),
            last_activity_at: source.last_activity_at?.toISOString() ?? null,
          }
        : null,
      queued: queued.map((request) => ({
        id: request.id,
        title: request.input.title ?? request.input.prompt.slice(0, 120),
      })),
    });
  },
);
app.openapi(
  createRoute({
    method: "get",
    path: "/chat/threads/{id}/analytics",
    tags: ["Chat"],
    description:
      "Session analytics for this chat: message, turn and tool counts from the stored transcript, plus context and cache usage recorded by the agent.",
    request: { params },
    responses: {
      200: {
        description: "Chat session analytics",
        content: { "application/json": { schema: ChatAnalyticsSchema } },
      },
      404: { description: "Chat not found" },
    },
  }),
  async (c) => {
    const thread = requireThread(c.req.valid("param").id);
    const source = await nativeSource(thread);
    return c.json(
      await chatAnalyticsFor(
        thread,
        source
          ? {
              backend: source.backend,
              model: source.model ?? null,
              transcript_path: source.transcript_path ?? null,
              runtime_session_id: source.runtime_session_id ?? null,
              tokens_used: source.tokens_used ?? null,
            }
          : null,
      ),
    );
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
            schema: z
              .object({
                agentOptions: ChatAgentOptionsMapSchema.optional(),
                sendWhileRunning: z.enum(["steer", "queue"]).optional(),
              })
              .strict()
              .refine(
                (body) => body.agentOptions !== undefined || body.sendWhileRunning !== undefined,
                "Provide agentOptions or sendWhileRunning",
              ),
          },
        },
      },
    },
    responses: response,
  }),
  (c) => {
    const thread = requireThread(c.req.valid("param").id);
    const body = c.req.valid("json");
    // Launch options rebuild the next turn, so they wait for the running one. The
    // send preference only steers the composer and applies immediately.
    if (body.agentOptions !== undefined) {
      const key = thread.runtimeId
        ? `${thread.host ?? "local"}:${thread.backend}:${thread.runtimeId}`
        : thread.id;
      if (active.has(key) || [...runs.values()].some((run) => run.threadId === thread.id))
        throw new ConflictError("Wait for the agent to finish before changing launch options.");
      thread.config.agentOptions = body.agentOptions;
    }
    if (body.sendWhileRunning !== undefined) thread.config.sendWhileRunning = body.sendWhileRunning;
    // A send preference is not conversation activity, so it does not reorder recents.
    if (body.agentOptions !== undefined) thread.updatedAt = Date.now();
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
      messages: chatHistory(page.turns, source.backend, thread.config.model),
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
      // Resuming in chat consumes a ready handoff just like resuming in a terminal.
      if (body.sourceSessionId) await getHandoffService().markResumed(body.sourceSessionId);
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
      messages: [...chatHistory(turns, thread.config.agent, thread.config.model), ...loaded],
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
    // A context fork replays stored messages into a fresh native session; the
    // injected instructions are not part of that replay, so the source's
    // delivery mark must not suppress them. A native fork carries the history.
    if (!nativeEligible) delete forked.systemPromptDelivered;
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
                decision: z.enum(["approved", "session", "denied"]),
                feedback: z.string().max(4000).optional(),
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
    const { requestId, decision, feedback } = c.req.valid("json");
    const grant = run?.permissions.get(requestId);
    if (!run?.session || grant === undefined)
      throw new ConflictError("This permission request is no longer pending.");
    if (decision === "session" && !grant)
      throw new ValidationError("This request cannot be allowed for the session.");
    if (feedback !== undefined && decision !== "denied")
      throw new ValidationError("A reason can only be sent with a denial.");
    run.session.respondPermission(requestId, decision, feedback);
    if (decision === "session")
      sessionGrants.set(run.threadId, (sessionGrants.get(run.threadId) ?? new Set()).add(grant));
    run.permissions.delete(requestId);
    run.pending.delete(requestId);
    run.resolved.add(requestId);
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
    if (!permissionModeSupported(thread.backend, mode))
      throw new ValidationError(unsupportedPermissionMode(mode));
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
        content: {
          "application/json": {
            schema: z.object({ ok: z.boolean(), message: ChatMessageSchema }),
          },
        },
      },
    },
  }),
  async (c) => {
    const run = runs.get(c.req.valid("param").id);
    const { requestId, answers } = c.req.valid("json");
    const question = run?.questions.get(requestId);
    if (!run || run.ended || !run.session?.respondQuestion || !question)
      throw new ConflictError("This question is no longer pending.");
    const ids = question.questions.map((question) => question.id);
    if (
      Object.keys(answers).length !== ids.length ||
      ids.some((id) => !answers[id]?.some((answer) => answer.trim()))
    )
      throw new ValidationError("Answer every question before continuing.");
    run.questions.delete(requestId);
    run.pending.delete(requestId);
    try {
      await run.session.respondQuestion(requestId, answers);
    } catch (error) {
      // A request the agent already withdrew (or a turn that ended mid-delivery)
      // must not resurrect as a phantom pending card.
      if (!run.resolved.has(requestId) && !run.ended) {
        run.questions.set(requestId, question);
        run.pending.set(requestId, { type: "question_request", data: question });
      }
      throw error;
    }
    run.resolved.add(requestId);
    // The answer belongs to the conversation, not just the vanished form. Recording
    // means accepted for delivery: inbox-backed questions resolve on the inbox write,
    // and a later native delivery failure surfaces in the inbox, not here.
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: chatAnswerText(question, answers),
      timestamp: Date.now(),
    };
    await recordInterjection(run, message);
    try {
      store().save(run.thread);
    } catch {
      publish(run, {
        type: "error",
        message: "The answer was delivered, but it could not be saved to the conversation.",
      });
    }
    resolveChatNotification(run.thread.id, `${c.req.valid("param").id}:${requestId}`);
    changes.publish("human-requests");
    return c.json({ ok: true, message });
  },
);

async function workspaceRuleGap(thread: ChatThread): Promise<RuleGap | undefined> {
  if (!loadConfig().rules.enabled) return undefined;
  try {
    const opts = await sessionRules(thread.backend, {
      cwd: thread.cwd,
      executionHost: thread.host,
      acpAgent: thread.config.agent,
      acpxAgent: thread.config.agent,
    });
    return opts.ruleGap;
  } catch (error) {
    // Claude has a verified hook, so a rule-storage failure must stay fatal there.
    throw new OrcError(
      error instanceof Error ? error.message : "This backend cannot enforce the workspace rules",
      "CHAT_RULE_ADAPTER",
      503,
    );
  }
}

/** Show the enforcement gap once per conversation instead of on every turn. */
function hasRuleGapNote(thread: ChatThread, text: string): boolean {
  return thread.messages.some((message) =>
    message.activity?.some((item) => item.type === "status" && item.text === text),
  );
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
    // The composer's send preference, so a change made before the first message sticks.
    sendWhileRunning: z.enum(["steer", "queue"]).optional(),
    // Confirms pushing into a session whose turn is still live (SESSION_BUSY contract).
    confirmBusy: z.boolean().optional(),
    agentOptions: ChatAgentOptionsMapSchema.optional(),
    // Where the user is chatting from. Sent to the agent only; the stored message stays the user's text.
    context: ChatTurnContextSchema.optional(),
    secret_refs: SecretRefsMapSchema.optional(),
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

function drainingError(): OrcError {
  return new OrcError(
    "The daemon is shutting down and stopped accepting new turns. Send this again once it restarts; the conversation stays resumable.",
    "DAEMON_DRAINING",
    503,
  );
}

async function streamChat(
  c: Context,
  body: z.infer<typeof requestSchema>,
  uploads: UploadFile[] = [],
) {
  if (isDraining()) throw drainingError();
  const remote = body.threadId ? null : parseRemoteTarget(body.workspace?.host);
  if (remote) {
    if (uploads.length)
      throw new ValidationError("Attachments are not supported on remote ORC hosts yet");
    const started = await startRemoteChat(remote, body);
    return unbufferedSSE(c, async (s) => {
      await s.writeSSE({ data: JSON.stringify({ type: "remote", ...started }) });
      await s.writeSSE({ data: JSON.stringify({ type: "done" }) });
    });
  }
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
  let thread = body.threadId
    ? requireThread(body.threadId)
    : await newThread(body.agent, body.model, undefined, body.workspace, body.providerId);
  if (!body.threadId && body.projectId) thread.projectId = body.projectId;
  if (body.secret_refs !== undefined) thread.secretRefs = body.secret_refs;
  // Settle a confirmed push into a live turn before anything below reads the
  // transcript: the stopped turn's own save lands first, and this request starts
  // from the reloaded thread instead of a snapshot taken before the wait.
  if (body.threadId) {
    // A provider switch cannot ride a live turn whatever the send mode: reject it
    // with the switch reason the client shows, not the generic busy answer.
    if (body.providerId && body.providerId !== thread.config.providerId && threadRun(thread.id))
      throw new ConflictError("Wait for the current response before switching providers.");
    thread = await settleBusyTurn(thread, body.confirmBusy);
  }
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
  if (body.threadId && body.agent && canonicalAgentId(body.agent) !== thread.config.agent)
    throw new ValidationError("Start a new chat to change agents.");
  const input = [...body.messages]
    .reverse()
    .find((message) => message.role === "user")
    ?.content.trim();
  if (!input) throw new ValidationError("A user message is required.");
  if (input === "/compact" && uploads.length)
    throw new ValidationError("Send attachments separately from context compaction.");
  if (body.permissionMode !== undefined) {
    if (!createBackend(thread.backend).capabilities?.permissionModes)
      throw new ValidationError("This backend does not support ORC permission modes.");
    if (!permissionModeSupported(thread.backend, body.permissionMode))
      throw new ValidationError(unsupportedPermissionMode(body.permissionMode));
    thread.config.permissionMode = body.permissionMode;
  }
  // Only a new conversation adopts the composer preference; an existing one owns
  // its setting, so another device cannot silently replace it.
  if (!body.threadId && body.sendWhileRunning !== undefined)
    thread.config.sendWhileRunning = body.sendWhileRunning;
  // The switch mutates the shared thread, so every check that can reject the request
  // runs first — including the live-turn settlement above. From here to beginTurn's
  // reservation there must be no await, or concurrent sends could move the
  // conversation under each other.
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
      // The new account's session starts without the instructions in history.
      delete thread.systemPromptDelivered;
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
  // The handoff briefing rides the first real turn; /compact must not consume it.
  if (body.threadId) continuation = consumeHandoffBriefing(thread, input, continuation);
  // A turn that ended without establishing a native session — a Pi
  // extension-command turn, an interrupted daemon, a provider that never
  // reported an id — leaves no native context to lose, but the conversation is
  // still worth continuing. Replay the stored transcript into a fresh session
  // instead of refusing the send. A turn that failed holding no session takes
  // the same path: there is nothing to corrupt, and the alternative is a chat
  // that can never be used again. Only a clean stop or completion that left no
  // session (a slash-command turn) skips the replay.
  const lastAssistant = [...thread.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const cleanSessionlessTurn =
    lastAssistant?.turn?.outcome === "completed" || lastAssistant?.turn?.outcome === "stopped";
  let transcriptHandoffNow = false;
  if (
    body.threadId &&
    thread.messages.length &&
    !thread.runtimeId &&
    !thread.providerSwitch &&
    !cleanSessionlessTurn &&
    !thread.forkedFrom &&
    !thread.forkPending
  ) {
    continuation ??= continuationPrompt(thread.messages, "recovery");
    transcriptHandoffNow = true;
    thread.recovery = {
      at: Date.now(),
      mode: "transcript_handoff",
      reason: "The previous turn ended without a provider session.",
    };
  }
  if (body.model !== undefined) thread.config.model = body.model;
  if (body.agentOptions !== undefined) thread.config.agentOptions = body.agentOptions;
  const { run } = await beginTurn(thread, input, {
    context: body.context,
    messageId: body.clientMessageId,
    continuation,
    recoveryNotice: transcriptHandoffNow,
    prepare: async () => {
      if (!body.threadId && body.workspace?.worktree) {
        const host = selectedTerminalHost(loadConfig(), thread.host);
        const cwd = await prepareSessionDirectory(
          { cwd: thread.cwd, worktree: true, base: body.workspace.base },
          {
            ...sessionDirDeps(await launchDeps(loadConfig(), host), host),
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
  /** The turn continues on a fresh session and must say so in the transcript. */
  recoveryNotice?: boolean | undefined;
  deliveries?: SessionDelivery[] | undefined;
  prepare?: () => Promise<SessionFile[]>;
};

async function beginTurn(
  thread: ChatThread,
  input: string,
  setup: TurnSetup = {},
): Promise<{ run: ChatRun; done: Promise<void> }> {
  // A draining daemon finishes the turns it has and refuses new ones; the
  // thread's resumable identity survives, so the retry after a restart lands.
  if (isDraining()) throw drainingError();
  if (input.trim() === "/compact") {
    if (!thread.runtimeId)
      throw new ValidationError("Start a conversation before compacting context.");
    if (!["claude", "codex-cli", "opencode", "pi"].includes(thread.backend))
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
  if (!setup.reserved) {
    // A confirmed push was settled before this thread was loaded; anything still
    // live here is a race with another request, and the claim below is the last
    // word — it refuses a lease that moved since this request observed it.
    const busy = busyTurnFor(thread, key);
    if (busy)
      throw new ConflictError("This session is already responding.", CHAT_SESSION_BUSY_CODE, {
        canTakeOver: busy.kind === "local",
        reason: busy.kind,
      });
  }
  if (thread.spawnedBy?.prompt)
    throw new ConflictError("This session is queued to start; wait for it or stop it first.");
  if (runs.size >= 4)
    throw new ConflictError("All chat workers are busy. Try again when a response finishes.");
  const mock = chatMockEnabled();
  const backend = createBackend(thread.backend);
  active.add(key);
  let nativeKey: string | undefined;
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
  let markFinalized = () => {};
  const finalized = new Promise<void>((resolve) => {
    markFinalized = resolve;
  });
  const run: ChatRun = {
    session: null,
    permissions: new Map(),
    questions: new Map(),
    steering: new Map(),
    threadId: thread.id,
    thread,
    key,
    runId,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    lastActivity: null,
    activityCount: 0,
    finalized,
    markFinalized: () => markFinalized(),
    events: [],
    pending: new Map(),
    listeners: new Set(),
    ended: false,
    lateMessages: [],
    resolved: new Set(),
    stop: () => {
      stopped = true;
      run.stopping = true;
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
  let ruleGap: RuleGap | undefined;
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
    // Report an unenforceable protected workspace instead of refusing the turn.
    ruleGap = await workspaceRuleGap(thread);
  } catch (error) {
    active.delete(key);
    runs.delete(runId);
    quietStops.delete(thread.id);
    run.markFinalized();
    throw error;
  }
  thread.messages.push({
    id: setup.messageId ?? crypto.randomUUID(),
    role: "user",
    content: input,
    ...(attachments.length ? { attachments } : {}),
    ...(setup.deliveries?.length ? { deliveries: setup.deliveries } : {}),
    timestamp: Date.now(),
  });
  if (thread.title === "New chat") {
    const firstDelivery = setup.deliveries?.[0];
    thread.title = (firstDelivery ? firstDelivery.title : input).slice(0, 100);
  }
  const startedAt = Date.now();
  run.startedAt = startedAt;
  run.lastActivityAt = startedAt;
  const newSegment = (): ChatMessage => ({
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    agent: thread.config.agent,
    ...(thread.config.model ? { model: thread.config.model } : {}),
    activity: [],
    turn: { startedAt },
  });
  let assistant: ChatMessage = newSegment();
  // A human interjection splits the turn: the prose so far becomes its own
  // message before the human's, and later events stream into a fresh segment.
  // Only the final segment carries the turn's outcome and timing.
  const sealedSegments: ChatMessage[] = [];
  run.sealAssistant = (beforeId) => {
    if (!assistant.content && !assistant.activity?.length) return undefined;
    const sealed: ChatMessage = { ...assistant, timestamp: Date.now() };
    delete sealed.turn;
    const index = beforeId ? thread.messages.findIndex((entry) => entry.id === beforeId) : -1;
    if (index >= 0) thread.messages.splice(index, 0, sealed);
    else thread.messages.push(sealed);
    sealedSegments.push(sealed);
    assistant = newSegment();
    return sealed;
  };
  run.unsealAssistant = (sealed, beforeId) => {
    const at = thread.messages.findIndex((entry) => entry.id === sealed.id);
    if (at < 0) return;
    // A later human interjection owns the prose after this seal; only undo a split
    // that is still the turn's last boundary, merging its prose back into the live
    // segment so a refused steer leaves no trace.
    if (
      thread.messages.slice(at + 1).some((entry) => entry.role === "user" && entry.id !== beforeId)
    )
      return;
    thread.messages.splice(at, 1);
    const sealedAt = sealedSegments.indexOf(sealed);
    if (sealedAt >= 0) sealedSegments.splice(sealedAt, 1);
    assistant.content = sealed.content + (assistant.content ? `\n\n${assistant.content}` : "");
    assistant.activity = [...(sealed.activity ?? []), ...(assistant.activity ?? [])].slice(-200);
  };
  // The lease claims the turn durably before any provider work starts: a crash
  // from here on is reconciled to `interrupted` at the next boot, never lost.
  // `epoch` is the fence: every later write of this turn carries it, so a
  // resurrected process or a second daemon on the same database cannot
  // overwrite a newer turn's lease.
  const runtimeIdAtStart = thread.runtimeId;
  run.runtimeIdAtStart = runtimeIdAtStart;
  thread.updatedAt = Date.now();
  // The epoch this request observed on the thread it loaded. The claim is a
  // compare-and-set against exactly this value, so a competing request that
  // lands first wins and this one starts no turn. A lease still recorded as
  // `running` here is a leftover the busy check found no live owner for.
  const observedEpoch = thread.turn?.epoch ?? 0;
  let leaseEpoch: number;
  try {
    leaseEpoch = store().claimTurn(
      thread,
      {
        runId,
        startedAt,
        status: "running",
        pid: process.pid,
        host: hostname(),
        lastHeartbeatAt: startedAt,
      },
      observedEpoch,
    );
    retireChatNotifications(thread);
    changes.publish("sessions");
  } catch (error) {
    active.delete(key);
    runs.delete(runId);
    quietStops.delete(thread.id);
    run.markFinalized();
    throw error;
  }
  let failure: string | null = null;
  let completed = false;
  let responded = false;
  let noResumableSession = false;
  let agentDurationMs: number | undefined;
  let agentOutcome: "completed" | "stopped" | "failed" | undefined;
  /** This turn continued on a fresh session because the old one was gone. */
  let handedOff = false;
  let agentContextWindow: number | undefined;
  const execute = async () => {
    // Activity watchdog: a quiet turn is stopped, but a turn waiting for a
    // human answer or a running tool call is re-checked instead of killed.
    let timedOut = false;
    let receivedResult = false;
    let commandTurn = false;
    let toolsPending = 0;
    const subagents = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      const waiting =
        run.questions.size > 0 ||
        run.permissions.size > 0 ||
        toolsPending > 0 ||
        [...subagents.values()].some((status) => !CHAT_SUBAGENT_DONE.has(status));
      if (waiting && Date.now() - startedAt < turnLimits.hardMs) {
        timer = setTimeout(expire, turnLimits.recheckMs);
        return;
      }
      timedOut = true;
      run.stop();
    };
    let lastLeaseBeat = startedAt;
    const touch = (activityLabel?: string) => {
      clearTimeout(timer);
      timer = setTimeout(expire, turnLimits.idleMs);
      const now = Date.now();
      run.lastActivityAt = now;
      thread.updatedAt = Math.max(thread.updatedAt, now);
      if (activityLabel) {
        run.lastActivity = activityLabel.slice(0, 200);
        run.activityCount++;
      }
      if (now - lastLeaseBeat >= turnLimits.leaseHeartbeatMs) {
        lastLeaseBeat = now;
        if (thread.turn?.runId === runId && thread.turn.status === "running") {
          thread.turn.lastHeartbeatAt = now;
          try {
            store().heartbeatTurnLease(thread.id, runId, thread.turn.epoch ?? 0, now);
          } catch {
            // A missed beat is harmless; the next activity retries.
          }
        }
      }
    };
    touch();
    // Tracks whether a tool call interrupted the prose, so the next text starts a
    // new paragraph instead of running into the previous remark.
    let proseInterrupted = false;
    const emit = async (event: ChatEvent) => {
      if (
        event.type !== "thread" &&
        event.type !== "turn" &&
        event.type !== "error" &&
        event.type !== "capabilities"
      )
        responded = true;
      // Prose stays in the message content even when tool calls follow it, so the
      // assistant's words render as a regular message instead of being folded into
      // the collapsed activity block as narration.
      if (event.type === "text") {
        const text = proseInterrupted && assistant.content ? `\n\n${event.text}` : event.text;
        proseInterrupted = false;
        assistant.content += text;
        // The break travels with the text event so the live stream and the stored
        // message stay identical.
        event = { ...event, text };
      }
      if (event.type === "tool_use") proseInterrupted = true;
      if (event.type === "error") failure ??= event.message;
      // Stateful updates belong to the segment that owns the entry: a seal must not
      // orphan a running tool call, plan or subagent in the prose above the interjection.
      if (!ownsChatActivity(assistant.activity, event)) {
        const owner = [...sealedSegments]
          .reverse()
          .find((segment) => ownsChatActivity(segment.activity, event));
        if (owner) {
          owner.activity = appendChatActivity(owner.activity ?? [], event);
          publish(run, event);
          return;
        }
      }
      assistant.activity = appendChatActivity(assistant.activity ?? [], event);
      publish(run, event);
    };
    const spoken = new Set<string>();
    let held = "";
    const settleHeld = async () => {
      const [first = "", ...rest] = held.trim().split(/\n\s*\n/);
      const text = spoken.has(spokenWords(first)) ? rest.join("\n\n").trim() : held.trim();
      held = "";
      if (!spokenWords(text) || (!/[\n`]/.test(text) && text.length <= 200)) return;
      await emit({ type: "text", text });
    };
    run.say = async (text) => {
      if (spokenWords(text)) spoken.add(spokenWords(text));
      proseInterrupted = true;
      await emit({ type: "text", text });
      proseInterrupted = true;
    };
    run.settleHeld = settleHeld;
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
      // Say in the transcript that this turn continues on a fresh session, not
      // only in the prompt: the user must be able to see why the agent has the
      // history but not the session.
      if (setup.recoveryNotice) await emit({ type: "system_status", text: CHAT_RECOVERY_NOTICE });
      if (ruleGap && !hasRuleGapNote(thread, ruleGap.message))
        await emit({ type: "system_status", text: ruleGap.message });
      if (mock) {
        await Promise.race([
          Bun.sleep(Math.min(Number(input.match(/after (\d+)ms/i)?.[1] ?? 75), 10000)),
          halted,
        ]);
        if (!stopped) {
          touch("text");
          await emit({
            type: "text",
            text: input.match(/Reply with exactly:\s*([^.?!\n]+)[.?!]?/i)?.[1]?.trim() || input,
          });
        }
        await Bun.sleep(75);
        thread.runtimeId ??= `mock-${thread.id}`;
        completed = !stopped;
      } else {
        const projectWorkspace = thread.projectId
          ? await workspaceLaunch(execHostFor(thread.host), thread.cwd, thread.projectId)
          : null;
        if (projectWorkspace?.warning)
          await emit({ type: "system_status", text: projectWorkspace.warning });
        const injectedSecrets = resolveExplicitSecretRefs(
          getSqlite(),
          thread.projectId ?? projectWorkspace?.projectId,
          thread.secretRefs,
        );
        const launchEnv = {
          ...(projectWorkspace?.env ?? {}),
          ...injectedSecrets.env,
        };
        const opts: SessionOpts = {
          ...(Object.keys(launchEnv).length ? { env: launchEnv } : {}),
          providerId: thread.config.providerId,
          toolAllowlist: thread.toolAllowlist,
          chatAgentOptions: thread.config.agentOptions[thread.config.agent],
          interactive: true,
          attentionContext: { chatThreadId: thread.id, sessionTitle: thread.title },
          cwd: thread.cwd,
          executionHost: thread.host,
          autoApprove: thread.config.autoApprove,
          permissionMode: createBackend(thread.backend).capabilities?.permissionModes
            ? thread.config.permissionMode
            : undefined,
          model: thread.config.model,
          // Always offered: system-slot sessions re-apply the append every turn;
          // prompt-riding sessions skip it once the delivery mark is set.
          systemPromptAppend: chatSystemPrompt(thread.config.system, { webchat: true }),
          systemPromptDelivered: thread.systemPromptDelivered,
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
            // The native fork failed and a fresh session takes the replay, which
            // carries stored messages only — offer the instructions again.
            delete thread.systemPromptDelivered;
            opts.systemPromptDelivered = false;
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
        if (!run.session) {
          const resumeId = thread.runtimeId;
          if (resumeId) {
            try {
              run.session = await backend.resumeSession(resumeId, opts);
            } catch (error) {
              if (stopped) return;
              // The provider no longer has that session (deleted state, a
              // different account, a worktree that moved). Keeping the id would
              // fail every future send, so continue on a fresh session with the
              // stored transcript as context — visibly, and only once per send.
              const reason = error instanceof Error ? error.message : String(error);
              thread.runtimeId = null;
              delete thread.systemPromptDelivered;
              setup.continuation ??= continuationPrompt(thread.messages.slice(0, -1), "recovery");
              thread.recovery = {
                at: Date.now(),
                mode: "transcript_handoff",
                reason: reason.slice(0, 500),
              };
              handedOff = true;
              run.handedOff = true;
              logger.warn("Chat session could not resume; continuing from the transcript", {
                error,
                threadId: thread.id,
                runtimeId: resumeId,
              });
              await emit({ type: "system_status", text: CHAT_RECOVERY_NOTICE });
              run.session = await backend.startSession(opts);
            }
          } else run.session = await backend.startSession(opts);
        }
        if (stopped) return;
        // Write the resumable identity through before the prompt is even sent:
        // a crash from here on must find the native session on disk.
        writeThroughRuntimeId(
          thread,
          runId,
          run.session,
          providerRefSource(runtimeIdAtStart, handedOff),
        );
        // The transcript keeps the typed "/name" commands; the agent receives the expanded text.
        const turn = expandChatInput(input, thread.projectId ?? null) + uploadPrompt(attachments);
        const message =
          setup.context && !AGENT_COMMAND_PATTERN.test(turn)
            ? withOrcContext(turn, {
                ...setup.context,
                voice: setup.context.voice ? VOICE_TURN_INSTRUCTION : undefined,
              })
            : turn;
        const sent =
          setup.continuation && input.trim() !== "/compact"
            ? `${setup.continuation}\n\n${message}`
            : message;
        commandTurn = AGENT_COMMAND_PATTERN.test(sent.trim());
        thread.capabilities = run.session.capabilities ??
          backend.capabilities ?? { ...UNKNOWN_CAPABILITIES };
        await emit({ type: "capabilities", capabilities: thread.capabilities });
        await run.session.send(sent);
        let outputBytes = 0;
        for await (const event of run.session.events()) {
          if (held && event.type !== "text") await settleHeld();
          // Always consume the terminal result — even after a Stop — so the turn's
          // outcome, native identity and resumability are recorded, not discarded.
          if (event.type === "result") {
            const duration = event.data.durationMs;
            if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0)
              agentDurationMs = duration;
            agentOutcome = event.data.outcome;
            agentContextWindow = event.data.contextWindow;
            noResumableSession = event.data.resumable === false;
            if (agentOutcome === "stopped") stopped = true;
            if (agentOutcome === "failed") failure ??= "The agent could not complete the response.";
            if (
              event.data.runtimeSessionId &&
              !NATIVE_SESSION_ID_PATTERN.test(event.data.runtimeSessionId)
            )
              throw new Error("The agent returned an invalid session identity.");
            // Compare against the identity this turn actually resumed: a fresh
            // id pinned by the mid-turn write-through is this same session, and
            // only a silent replacement of the RESUMED identity is a swap. A
            // deliberate transcript handoff already cleared the old identity.
            if (
              runtimeIdAtStart &&
              !handedOff &&
              event.data.runtimeSessionId &&
              runtimeIdAtStart !== event.data.runtimeSessionId
            )
              throw new Error(
                "The agent returned a different session instead of resuming this conversation. The original session identity was kept.",
              );
            thread.runtimeId = event.data.runtimeSessionId ?? thread.runtimeId;
            if (event.data.runtimeSessionId) {
              // The result's identity is authoritative: write any correction
              // (e.g. a compacted session roll) through at once, so a crash
              // during finalization cannot lose it.
              attachProviderRef(
                thread,
                event.data.runtimeSessionId,
                providerRefSource(runtimeIdAtStart, handedOff),
              );
              persistProviderRef(thread, runId);
            }
            if (!thread.sourceId && event.data.runtimeSessionId) await linkNativeSource(thread);
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
          const activityLabel =
            event.type === "tool_use"
              ? `tool:${event.data.name}`
              : event.type === "permission_request"
                ? "waiting:approval"
                : event.type === "question_request"
                  ? "waiting:question"
                  : event.type === "system_status"
                    ? "status"
                    : event.type === "capabilities"
                      ? undefined
                      : event.type;
          touch(activityLabel);
          if (!nativeKey) {
            const nativeId = run.session?.getRuntimeSessionId?.();
            if (nativeId) {
              nativeKey = turnKey(thread.host, thread.backend, nativeId);
              if (nativeKey === key || active.has(nativeKey)) nativeKey = key;
              else active.add(nativeKey);
              // Backends that expose their native id only once events flow get
              // their write-through here, still before this event is emitted.
              writeThroughRuntimeId(
                thread,
                runId,
                run.session,
                providerRefSource(runtimeIdAtStart, handedOff),
              );
            }
          }
          if (event.type === "tool_use") toolsPending++;
          else if (event.type === "tool_result") toolsPending = Math.max(0, toolsPending - 1);
          outputBytes += event.type === "text" ? event.data.length : JSON.stringify(event).length;
          if (outputBytes > 2000000) throw new Error("Response exceeded the chat output limit.");
          if (event.type === "text" && spoken.size) {
            held += event.data;
            continue;
          }
          if (event.type === "capabilities") {
            thread.capabilities = event.data;
            await emit({ type: "capabilities", capabilities: event.data });
            continue;
          }
          if (event.type === "text" || event.type === "thinking" || event.type === "system_status")
            await emit({ type: event.type, text: event.data });
          else if (event.type === "plan") await emit({ type: "plan", data: event.data });
          else if (event.type === "subagent") {
            subagents.set(event.data.id, event.data.status);
            await emit({ type: "subagent", data: event.data });
          } else if (event.type === "tool_use" || event.type === "tool_result") await emit(event);
          else if (event.type === "permission_request") {
            const grant = `${event.data.tool}\0${event.data.grant ?? event.data.command}`;
            if (event.data.allowSession !== false && sessionGrants.get(thread.id)?.has(grant)) {
              run.session?.respondPermission(event.data.requestId, "session");
              continue;
            }
            recordChatNotification(thread, `${runId}:${event.data.requestId}`, "approval");
            notifySpawner(thread, `${runId}:${event.data.requestId}`, "approval");
            run.permissions.set(
              event.data.requestId,
              event.data.allowSession === false ? "" : grant,
            );
            changes.publish("human-requests");
            await emit(event);
            run.pending.set(event.data.requestId, event);
            voiceNotice(thread.id);
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
            run.pending.set(event.data.requestId, event);
            voiceNotice(thread.id);
            notify("chat", chatPush(thread, "Question", "The agent is waiting for your answer."));
          } else if (event.type === "request_resolved") {
            resolveChatNotification(thread.id, `${runId}:${event.data.requestId}`);
            run.permissions.delete(event.data.requestId);
            run.questions.delete(event.data.requestId);
            run.pending.delete(event.data.requestId);
            run.resolved.add(event.data.requestId);
            changes.publish("human-requests");
            await emit({ type: "request_resolved", requestId: event.data.requestId });
          } else if (event.type === "error") await emit({ type: "error", message: event.data });
        }
        await settleHeld();
        if (!receivedResult && !stopped && failure === null)
          await emit({
            type: "error",
            message:
              "The agent ended before completing the turn. Your next message resumes the same session, or continues on a fresh one if the agent no longer has it.",
          });
        const sessionId = noResumableSession ? undefined : run.session?.getRuntimeSessionId?.();
        if (!thread.runtimeId && sessionId && NATIVE_SESSION_ID_PATTERN.test(sessionId)) {
          thread.runtimeId = sessionId;
          attachProviderRef(thread, sessionId, providerRefSource(runtimeIdAtStart, handedOff));
        }
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
      logger.error("Chat turn failed", {
        error,
        runId,
        threadId: thread.id,
        agent: thread.config.agent,
        backend: thread.backend,
        providerId: thread.config.providerId,
        spawnedBy: thread.spawnedBy?.sessionId,
      });
      const message =
        error instanceof Error ? error.message : "The agent could not complete the response.";
      failure ??= message;
      if (!stopped) await emit({ type: "error", message }).catch(() => {});
    } finally {
      // The turn's ordering boundary closes as soon as the event stream is over:
      // a steer or answer arriving during usage capture or transport close must
      // not seal the finished reply. Late records append below the final segment.
      run.ended = true;
      delete run.sealAssistant;
      delete run.unsealAssistant;
      delete run.settleHeld;
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
      const frozenUsage = await Promise.race([
        captureTurnUsage(thread, startedAt, agentContextWindow),
        Bun.sleep(5000).then(() => undefined),
      ]);
      const turnOutcome = timedOut
        ? "failed"
        : stopped || agentOutcome === "stopped"
          ? "stopped"
          : failure || agentOutcome === "failed"
            ? "failed"
            : "completed";
      const turnError =
        turnOutcome === "failed"
          ? (failure ?? "The agent could not complete the response.").slice(0, 2000)
          : undefined;
      assistant.turn = {
        startedAt,
        finishedAt,
        durationMs: agentDurationMs ?? Math.max(0, finishedAt - startedAt),
        outcome: turnOutcome,
        ...(turnError ? { error: turnError } : {}),
        ...(frozenUsage ? { usage: frozenUsage } : {}),
      };
      if (thread.spawnedBy) {
        if (turnError) thread.spawnedBy.startError = turnError;
        else if (turnOutcome === "completed") delete thread.spawnedBy.startError;
      }
      assistant.timestamp = finishedAt;
      // The lease mirrors the turn's outcome. A lease this process no longer
      // owns (a shutdown flush already wrote through) is left alone; the save
      // below persists the terminal state with the transcript.
      if (thread.turn?.runId === runId && thread.turn.status === "running")
        thread.turn = {
          ...thread.turn,
          status: assistant.turn.outcome ?? "failed",
          lastHeartbeatAt: finishedAt,
        };
      // Do not pin a native id the backend explicitly reported as non-resumable;
      // there is no persisted session behind it, so the next send starts fresh.
      const nativeId = noResumableSession ? undefined : run.session?.getRuntimeSessionId?.();
      if (noResumableSession && !runtimeIdAtStart && thread.runtimeId)
        // The optimistic mid-turn write-through pinned an id the backend then
        // disowned; drop the pin so the next send starts a fresh session. The
        // providerRefs entry stays as honest attachment history.
        thread.runtimeId = null;
      if (!thread.runtimeId && nativeId && NATIVE_SESSION_ID_PATTERN.test(nativeId)) {
        thread.runtimeId = nativeId;
        attachProviderRef(thread, nativeId, providerRefSource(runtimeIdAtStart, handedOff));
      }
      // A confirmed non-command turn owns the instructions in the history of a
      // prompt-riding session, so later turns stop delivering them. A turn that
      // never reached the agent (no result), ran only a slash command, or left
      // no resumable identity keeps the offer alive. System-slot sessions
      // re-apply the append every turn.
      if (
        receivedResult &&
        !noResumableSession &&
        !commandTurn &&
        run.session?.systemPromptOnce &&
        thread.runtimeId
      )
        thread.systemPromptDelivered = true;
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
        // The retry replays stored messages into a fresh native session; the
        // inherited delivery mark must not suppress the instructions there.
        delete thread.systemPromptDelivered;
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
      // Messages recorded after the boundary belong below the completed reply,
      // even if the final segment has not been pushed yet.
      const lateAt = thread.messages.findIndex((entry) => run.lateMessages.includes(entry.id));
      if (lateAt >= 0) thread.messages.splice(lateAt, 0, assistant);
      else thread.messages.push(assistant);
      if (synced) {
        const mark = await transcriptMark(thread).catch(() => null);
        if (mark) thread.transcriptMark = mark;
      }
      thread.updatedAt = Date.now();
      for (const requestId of [...run.permissions.keys(), ...run.questions.keys()])
        resolveChatNotification(thread.id, `${runId}:${requestId}`);
      if (!stopped && (completed || failure))
        recordChatNotification(thread, runId, failure ? "failed" : "finished");
      if (!quietStops.delete(thread.id))
        notifySpawner(
          thread,
          runId,
          timedOut || failure ? "failed" : stopped ? "stopped" : "finished",
        );
      // A watchdog stop is not a user stop: report it so an away user learns
      // the turn died instead of finding a silently frozen conversation.
      if (timedOut) recordChatNotification(thread, runId, "failed");
      try {
        // Fenced by the lease epoch: a newer turn that claimed this thread while
        // this one was finalizing keeps its state instead of being overwritten.
        store().saveTurn(thread, leaseEpoch);
        if (!stopped) publish(run, { type: "session", runtimeId: thread.runtimeId });
        if (!stopped && assistant.content)
          notify("chat", chatPush(thread, "Reply ready", truncate(assistant.content, 180)));
      } catch (error) {
        logger.error("Chat history could not be saved", { error, runId });
        if (!stopped)
          publish(run, {
            type: "error",
            message:
              "This response could not be saved. The conversation up to its last saved turn is intact; send again to continue.",
          });
      } finally {
        active.delete(key);
        if (nativeKey && nativeKey !== key) active.delete(nativeKey);
        runs.delete(runId);
        changes.publish("human-requests", "session-messages");
        queueMicrotask(startPendingChildren);
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
        // Last step: a confirmed push waits on this, so the stopped turn's
        // transcript and terminal lease are on disk before the next one claims
        // the thread. `run.ended` is set much earlier and is not enough.
        run.markFinalized();
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
  if (treeStops.has(parentId) && !threadRun(parentId))
    throw new ConflictError("This session is stopped; only a running session can start others");
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
  const at = Date.now();
  try {
    const child = await startChild(parent, parentId, children, input);
    if ((treeStops.get(parentId) ?? 0) >= at) stopChat(child.id, true, parentId);
    return child;
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
  const config = loadConfig();
  const projectId = input.project_id ?? parent.projectId;
  const crossProject = input.project_id !== undefined && input.project_id !== parent.projectId;
  const projectFolder = input.project_id !== undefined ? projectRoot(input.project_id) : null;
  const requestedHost =
    input.host !== undefined ? hostAlias(selectedTerminalHost(config, input.host)) : undefined;
  // An omitted host inherits the caller's host; a project checkout instead
  // lives on the Settings default host, like a new chat in that project.
  const host = input.host !== undefined ? requestedHost : crossProject ? undefined : parent.host;
  const hostChanged = input.host !== undefined && requestedHost !== parent.host;
  const cwd = input.cwd ?? projectFolder ?? (hostChanged ? undefined : (parent.cwd ?? undefined));
  const source = store().get(parentId);
  const rawAgent = input.agent ?? parent.agent ?? undefined;
  const agent = rawAgent ? canonicalAgentId(rawAgent) : undefined;
  const sameAgent = !!source && agent === source.config.agent;
  if (source?.toolAllowlist && agent !== "claude")
    throw new ValidationError(
      "This session has a tool allowlist that only Claude can enforce; start a Claude child",
    );
  const backend = agent ? chatBackendFor(agent) : null;
  const permissionMode = source?.config.permissionMode ?? "default";
  const body: z.infer<typeof requestSchema> = {
    messages: [{ role: "user", content: input.prompt }],
    ...(agent ? { agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(projectId ? { projectId } : {}),
    ...(backend && permissionModeSupported(backend, permissionMode) ? { permissionMode } : {}),
    ...(sameAgent && source
      ? {
          agentOptions: source.config.agentOptions,
          ...(source.config.providerId ? { providerId: source.config.providerId } : {}),
        }
      : {}),
    workspace: {
      host,
      cwd,
      worktree: input.worktree,
      ...(input.worktree && input.base ? { base: input.base } : {}),
    },
  };
  const spawnedBy: ChatSpawn = {
    sessionId: parentId,
    at: Date.now(),
    notify: input.notify,
    ...(input.request_id ? { requestId: input.request_id } : {}),
  };
  if (runs.size >= 4) return queueChild(body, input, spawnedBy, source?.toolAllowlist);
  const run = await openChat(body, [], spawnedBy, source?.toolAllowlist).catch((error) => {
    if (error instanceof ConflictError && runs.size >= 4) return null;
    logger.error("Failed to spawn child session", {
      parentId,
      agent: body.agent,
      providerId: body.providerId,
      cwd: body.workspace?.cwd,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
  if (!run) return queueChild(body, input, spawnedBy, source?.toolAllowlist);
  if (input.title) {
    run.thread.title = input.title;
    store().save(run.thread);
  }
  return run.thread;
}

async function queueChild(
  body: z.infer<typeof requestSchema>,
  input: SessionSpawn,
  spawnedBy: ChatSpawn,
  toolAllowlist: string[] | undefined,
): Promise<ChatThread> {
  const thread = await newThread(
    body.agent,
    body.model,
    undefined,
    { host: body.workspace?.host, cwd: body.workspace?.cwd },
    body.providerId,
  );
  if (body.projectId) thread.projectId = body.projectId;
  if (toolAllowlist) thread.toolAllowlist = toolAllowlist;
  if (body.permissionMode !== undefined) thread.config.permissionMode = body.permissionMode;
  if (body.agentOptions !== undefined) thread.config.agentOptions = body.agentOptions;
  if (input.title) thread.title = input.title;
  if (body.workspace?.worktree) {
    const host = selectedTerminalHost(loadConfig(), thread.host);
    const cwd = await prepareSessionDirectory(
      { cwd: thread.cwd, worktree: true, base: body.workspace.base },
      {
        ...sessionDirDeps(await launchDeps(loadConfig(), host), host),
      },
    );
    if (cwd === thread.cwd)
      throw new ValidationError("Choose a Git repository folder to create a worktree.");
    thread.cwd = cwd;
  }
  thread.spawnedBy = { ...spawnedBy, prompt: input.prompt };
  thread.updatedAt = Date.now();
  store().save(thread);
  spawnsPending = true;
  return thread;
}

let spawnsPending = true;

function startPendingChildren(): void {
  // A draining daemon leaves queued children queued: their prompt stays on the
  // thread, so the next boot starts them instead of recording a start error.
  if (isDraining()) return;
  if (runs.size >= 4 || !spawnsPending) return;
  let pending: ChatThread[];
  try {
    pending = store().pendingSpawns();
  } catch {
    return;
  }
  spawnsPending = pending.length > 0;
  for (const thread of pending) {
    if (runs.size >= 4) return;
    const prompt = thread.spawnedBy?.prompt;
    if (!prompt || !thread.spawnedBy || threadRun(thread.id)) continue;
    delete thread.spawnedBy.prompt;
    beginTurn(thread, prompt).catch((error) => {
      logger.warn("A queued child session could not start", { error, threadId: thread.id });
      const saved = store().get(thread.id);
      if (!saved?.spawnedBy) return;
      delete saved.spawnedBy.prompt;
      if (!saved.spawnedBy.cancelled)
        saved.spawnedBy.startError = (error instanceof Error ? error.message : String(error)).slice(
          0,
          2000,
        );
      store().save(saved);
      if (!saved.spawnedBy.cancelled) notifySpawner(saved, "start", "failed");
    });
  }
}

/**
 * Daemon-shutdown drain: active turns get a short window to finish on their
 * own, then a cooperative Stop so the normal turn-end path records their
 * transcript and terminal lease. A turn that will not end in time gets its
 * resumable identity flushed as-is; its lease stays `running` on purpose so
 * the next boot's reconcile records the interruption exactly once.
 */
export async function drainChatTurns(): Promise<void> {
  if (runs.size === 0) return;
  const quietUntil = Date.now() + turnLimits.shutdownWaitMs;
  while (runs.size > 0 && Date.now() < quietUntil) await Bun.sleep(100);
  if (runs.size === 0) return;
  logger.info("Daemon shutdown stopping active chat turns", { count: runs.size });
  for (const run of runs.values()) run.stop();
  const stoppedUntil = Date.now() + turnLimits.shutdownStopMs;
  while (runs.size > 0 && Date.now() < stoppedUntil) await Bun.sleep(100);
  for (const run of runs.values()) flushTurnForShutdown(run);
}

function flushTurnForShutdown(run: ChatRun): void {
  const thread = run.thread;
  if (thread.turn?.runId !== run.runId || thread.turn.status !== "running") return;
  try {
    const nativeId = run.session?.getRuntimeSessionId?.();
    // A handed-off turn abandoned its old identity on purpose: the new session is
    // the one the next send must resume, so it is not a pin to protect.
    const pinned = run.handedOff ? null : (run.runtimeIdAtStart ?? null);
    // A shutdown must never swap the identity this turn resumed: the next send
    // would continue a different native conversation than the transcript shows.
    // Only a fresh turn (nothing pinned) adopts what the session reports, and a
    // session that reports the pinned id is the same conversation.
    if (nativeId && NATIVE_SESSION_ID_PATTERN.test(nativeId) && (!pinned || pinned === nativeId)) {
      if (thread.runtimeId !== nativeId) thread.runtimeId = nativeId;
      // A known ref stays exactly as it was: attachProviderRef would re-stamp
      // attachedAt and move it to the end, claiming a re-attach that never happened.
      const known = (thread.providerRefs ?? []).some(
        (ref) =>
          ref.backend === thread.backend &&
          (ref.host ?? null) === (thread.host ?? null) &&
          ref.runtimeId === nativeId,
      );
      if (!known) attachProviderRef(thread, nativeId, pinned ? "resumed" : "started");
    } else if (nativeId && pinned && pinned !== nativeId) {
      logger.warn("Shutdown kept the pinned session identity over a different reported id", {
        runId: run.runId,
        pinned,
        reported: nativeId,
      });
      thread.runtimeId = pinned;
    }
    thread.turn = { ...thread.turn, lastHeartbeatAt: Date.now() };
    store().persistTurnForShutdown(
      thread.id,
      run.runId,
      thread.turn.epoch ?? 0,
      thread.runtimeId,
      thread.providerRefs ?? [],
      thread.turn,
      thread.messages,
    );
  } catch (error) {
    // Durability does not depend on this flush: the mid-turn write-through
    // already pinned the identity, and the next boot reconciles the lease.
    logger.error("Shutdown could not persist the chat turn state", { error, runId: run.runId });
  }
}

function descendants(id: string): string[] {
  const found: string[] = [];
  let level = [id];
  while (level.length && found.length < 200) {
    level = store()
      .children(level)
      .map((child) => child.id)
      .filter((child) => !found.includes(child) && child !== id);
    found.push(...level);
  }
  return found;
}

const quietStops = new Set<string>();
const treeStops = new Map<string, number>();

export function stopChat(id: string, cascade: boolean, by: string | null): string[] {
  const stopped: string[] = [];
  const messages = new SessionMessageStore(getSqlite());
  for (const [session, at] of treeStops)
    if (Date.now() - at > 60 * 60 * 1000) treeStops.delete(session);
  for (const target of cascade ? [id, ...descendants(id)] : [id]) {
    if (cascade) treeStops.set(target, Date.now());
    const thread = store().get(target);
    if (!thread) continue;
    const run = threadRun(target)?.[1];
    const quiet = target !== id || by === thread.spawnedBy?.sessionId;
    const queued = thread.spawnedBy?.prompt;
    if (thread.spawnedBy && queued) {
      delete thread.spawnedBy.prompt;
      thread.spawnedBy.cancelled = true;
      store().save(thread);
      if (!quiet) notifySpawner(thread, "cancel", "stopped");
    }
    for (const message of messages.queued(target)) messages.cancel(message.id);
    if (run) {
      if (quiet || queued) quietStops.add(target);
      run.stop();
    }
    if (run || queued) stopped.push(target);
  }
  if (stopped.length) changes.publish("sessions");
  return stopped;
}

export async function sayInChat(threadId: string, text: string): Promise<boolean> {
  requireThread(threadId);
  const say = threadRun(threadId)?.[1].say;
  if (say) await say(text);
  return say !== undefined;
}

const spokenWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export async function voiceTurn(threadId: string, text: string): Promise<"sent" | "waiting"> {
  requireThread(threadId);
  const run = threadRun(threadId)?.[1];
  if (run) {
    if (run.permissions.size || run.questions.size) return "waiting";
    const ended = new Promise<void>((resolve) =>
      run.listeners.add((data) => data === null && resolve()),
    );
    run.stop();
    await ended;
  }
  await openChat({
    threadId,
    messages: [{ role: "user", content: text }],
    context: { source: "webchat", voice: true },
  });
  return "sent";
}

export function chatStatus(id: string): SessionStatus {
  const resolved = resolveSessionRef(id);
  if (!resolved) throw new NotFoundError("Session", id);

  if (resolved.thread) {
    const thread = resolved.thread;
    const run = threadRun(thread.id)?.[1];
    const last = [...thread.messages].reverse().find((message) => message.role === "assistant");
    const waitingFor = run?.permissions.size ? "approval" : run?.questions.size ? "question" : null;
    const outcome = last?.turn?.outcome;
    const queue = new SessionMessageStore(getSqlite())
      .queued(thread.id)
      .map(({ id: msgId, state, position }) => ({ id: msgId, state, position }));
    const childWork = childWorkCounts(thread.id);
    const startError = run
      ? null
      : outcome === "failed"
        ? (last?.turn?.error ?? thread.spawnedBy?.startError ?? null)
        : !last
          ? (thread.spawnedBy?.startError ?? null)
          : null;
    const lastActivityAt =
      run?.lastActivityAt ??
      thread.turn?.lastHeartbeatAt ??
      last?.turn?.finishedAt ??
      resolved.gateway?.last_activity_at?.getTime() ??
      thread.updatedAt;
    const updatedAt = Math.max(thread.updatedAt, lastActivityAt);
    return {
      session_id: thread.id,
      title: thread.title,
      agent: thread.config.agent,
      status: run
        ? waitingFor
          ? "waiting"
          : "running"
        : thread.spawnedBy?.prompt
          ? "queued"
          : queue.length
            ? "running"
            : outcome === "failed" || (thread.spawnedBy?.startError && !last)
              ? "failed"
              : outcome === "stopped" || (thread.spawnedBy?.cancelled && !last)
                ? "stopped"
                : "idle",
      waiting_for: waitingFor,
      last_message: last?.content || startError || null,
      queue,
      parent_session_id: thread.spawnedBy?.sessionId ?? null,
      children: store()
        .children([thread.id])
        .map((child) => child.id),
      working_children: childWork.working,
      waiting_children: childWork.waiting,
      stopping: run?.stopping === true,
      project_id: thread.projectId ?? null,
      cwd: thread.cwd,
      started_at: thread.spawnedBy?.at ?? null,
      updated_at: updatedAt,
      last_activity_at: lastActivityAt,
      last_activity: run ? (waitingFor ? `waiting:${waitingFor}` : run.lastActivity) : null,
      activity_count: run?.activityCount ?? 0,
      start_error: startError,
      native_session_id: resolved.nativeId,
      live_session_id: resolved.liveId,
    };
  }

  const row = resolved.gateway;
  if (!row) throw new NotFoundError("Session", id);
  const live = liveRunFields(
    row.backend,
    row.execution_host ?? null,
    row.runtime_session_id ?? null,
  );
  const waitingFor: "question" | "approval" | null = live.waiting_for_human
    ? live.waiting_for?.reason === "question"
      ? "question"
      : "approval"
    : null;
  const queue = new SessionMessageStore(getSqlite())
    .queued(row.id)
    .map(({ id: msgId, state, position }) => ({ id: msgId, state, position }));
  const childWork = childWorkCounts(row.id);
  const lastActivityAt = (row.last_activity_at ?? row.updated_at).getTime();
  const updatedAt = Math.max(row.updated_at.getTime(), lastActivityAt);
  const startError = row.last_error ?? null;
  const derivedStatus: SessionStatus["status"] =
    row.status === "running"
      ? waitingFor
        ? "waiting"
        : "running"
      : row.status === "error"
        ? "failed"
        : row.status === "stopped"
          ? "stopped"
          : "idle";
  const childIds = [...new Set([row.id, row.runtime_session_id].filter((v): v is string => !!v))];
  return {
    session_id: row.id,
    title: row.display_title ?? row.title ?? row.id,
    agent: row.backend,
    status: derivedStatus,
    waiting_for: waitingFor,
    last_message: startError ?? row.summary ?? null,
    queue,
    parent_session_id: row.parent_session_id ?? row.spawned_from_session_id ?? null,
    children: store()
      .children(childIds)
      .map((child) => child.id),
    working_children: childWork.working,
    waiting_children: childWork.waiting,
    stopping: false,
    project_id: row.project_id ?? null,
    cwd: row.cwd ?? "",
    started_at: row.created_at.getTime(),
    updated_at: updatedAt,
    last_activity_at: lastActivityAt,
    last_activity: waitingFor ? `waiting:${waitingFor}` : null,
    activity_count: 0,
    start_error: startError,
    native_session_id: row.runtime_session_id ?? null,
    live_session_id: row.id,
  };
}

function inspectLocalProcessCommand(pid: number): string | null {
  try {
    const command =
      process.platform === "win32"
        ? [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.Name) $($p.CommandLine)" }`,
          ]
        : ["ps", "-o", "comm=,args=", "-p", String(pid)];
    const out = Bun.spawnSync(command, {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 1500,
      windowsHide: true,
    });
    if (out.exitCode !== 0) return null;
    const text = out.stdout.toString().trim();
    return text || null;
  } catch {
    return null;
  }
}

function backendProcessTokens(backend: string): string[] {
  const canonical = canonicalAgentId(backend);
  const agent = codingAgent(canonical);
  return [
    ...new Set(
      [canonical, backend.toLowerCase(), ...(agent?.binaries ?? [])].filter((token) =>
        Boolean(token),
      ),
    ),
  ];
}

function commandMatchesBackend(commandLine: string, backend: string): boolean {
  const lower = commandLine.toLowerCase();
  return backendProcessTokens(backend).some((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[/\\\\\\s"'=])${escaped}(\\.exe)?($|[\\s"'\\/:])`, "i").test(lower);
  });
}

export type SignalLiveProcessDeps = {
  alive?: (pid: number) => boolean;
  inspectCommand?: (pid: number) => string | null;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
};

export function signalLiveSessionProcess(
  row: {
    status: string;
    chat_id: string | null;
    pid: number | null;
    execution_host: string | null;
    backend: string;
  },
  deps: SignalLiveProcessDeps = {},
): boolean {
  if (row.status !== "running" || row.chat_id !== LIVE_CHAT_ID) return false;
  if (!row.pid || row.pid <= 0 || row.pid === process.pid) return false;
  if (row.execution_host && row.execution_host !== "local") return false;
  const alive = deps.alive ?? isAlive;
  if (!alive(row.pid)) return false;
  const inspect = deps.inspectCommand ?? inspectLocalProcessCommand;
  const command = inspect(row.pid);
  if (!command || !commandMatchesBackend(command, row.backend)) return false;
  try {
    (deps.kill ?? ((pid, sig) => process.kill(pid, sig)))(row.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

export function stopSession(
  id: string,
  cascade: boolean,
  sender: SessionMessageSender,
  signalDeps?: SignalLiveProcessDeps,
): SessionStatus {
  const resolved = resolveSessionRef(id);
  if (!resolved) throw new NotFoundError("Session", id);

  if (resolved.thread) {
    requireAncestor(sender, resolved.thread.id);
    stopChat(resolved.thread.id, cascade, sender.session_id ?? null);
    if (
      resolved.gateway &&
      resolved.gateway.status === "running" &&
      !threadRun(resolved.thread.id)
    ) {
      getSqlite()
        .query(
          "UPDATE gateway_sessions SET status = 'stopped', updated_at = unixepoch() WHERE id = ?",
        )
        .run(resolved.gateway.id);
      changes.publish("sessions");
    }
    return chatStatus(resolved.thread.id);
  }

  const row = resolved.gateway;
  if (!row) throw new NotFoundError("Session", id);
  if (sender.kind === "session") {
    const senderIds = [sender.session_id, sender.native_id].filter((v): v is string => !!v);
    const parentIds = [row.parent_session_id, row.spawned_from_session_id].filter(
      (v): v is string => !!v,
    );
    if (!parentIds.some((parentId) => senderIds.includes(parentId))) {
      throw new ForbiddenError(
        "Only the session that started this session (or one of its ancestors) can steer, interrupt or stop it; queue a message instead",
      );
    }
  }
  const messages = new SessionMessageStore(getSqlite());
  for (const message of messages.queued(row.id)) messages.cancel(message.id);
  signalLiveSessionProcess(row, signalDeps);
  getSqlite()
    .query("UPDATE gateway_sessions SET status = 'stopped', updated_at = unixepoch() WHERE id = ?")
    .run(row.id);
  changes.publish("sessions");
  return chatStatus(row.id);
}

function nativeRun(target: ChatTarget): [string, ChatRun] | undefined {
  if ("threadId" in target) return threadRun(target.threadId);
  const key = turnKey(target.host, target.backend, target.runtimeId);
  return [...runs].find(([, run]) => run.key === key);
}

registerChatControl({
  turn: (target, prompt, options) => {
    const thread =
      "threadId" in target
        ? store().get(target.threadId)
        : store()
            .byRuntime(target.backend, target.host, target.runtimeId)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!thread || thread.spawnedBy?.prompt || threadRun(thread.id) || runs.size >= 4) return null;
    return beginTurn(thread, prompt, { reserved: true, deliveries: options?.deliveries }).then(
      ({ done }) => done,
    );
  },
  canSteer: (target) => {
    const run = nativeRun(target)?.[1];
    return steerable(run) && run.steering.size < STEER_LIMIT;
  },
  steer: async (target, text, options) => {
    const run = nativeRun(target)?.[1];
    if (!steerable(run) || run.steering.size >= STEER_LIMIT) return false;
    await steerRun(run, text, crypto.randomUUID(), options?.deliveries);
    return true;
  },
  stop: (threadId) => {
    const run = threadRun(threadId)?.[1];
    run?.stop();
    return !!run;
  },
  running: (threadId) => !!threadRun(threadId),
  waiting: (threadId) => {
    const run = threadRun(threadId)?.[1];
    return run?.permissions.size ? "approval" : run?.questions.size ? "question" : null;
  },
  full: () => runs.size >= 4,
  startPending: startPendingChildren,
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
