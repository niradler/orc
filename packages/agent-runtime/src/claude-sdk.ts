import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  HOOK_EVENTS,
  type Options,
  type PermissionUpdate,
  type Query,
  query,
  type SDKControlInterruptResponse,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CHAT_SUBAGENT_DONE,
  ChatAnswersSchema,
  type ChatBackgroundTask,
  type ChatBackgroundTaskKind,
  type ChatLostBackgroundWorkItem,
  type ChatQuestion,
  ChatQuestionSchema,
  type ChatSubagentPayload,
  type ChatSubagentStatus,
  ORC_TASK_GUIDANCE,
} from "@orc/core/chat";
import { ChatAgentOptionsSchema, type ClaudeChatOptions } from "@orc/core/chat-options";
import { loadConfig, localAgentBinary } from "@orc/core/config";
import {
  type ExecHost,
  hostBinary,
  hostExec,
  prepareSshSpawn,
  resolveExecHost,
  type SshExecHost,
} from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { providerProcessEnvironment } from "@orc/core/provider-service";
import { RULE_EVENT_ADAPTERS } from "@orc/core/rule-events";
import { claudeConfigDirectory } from "@orc/db/agent-memory";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { CLAUDE_CAPABILITIES } from "./capabilities.js";
import { resolveClaudeSdkLaunch } from "./claude-executable.js";
import { elicitationForm } from "./elicitation.js";
import { sessionExecHost } from "./execution-host.js";
import { buildOrcMcpServers, ORC_TOOL_PREFIX, ORC_TOOLS_RULE } from "./orc-mcp.js";
import { planFromToolInput } from "./plan.js";
import { claudeLimitEvent } from "./provider-limits.js";
import { registerBackend } from "./registry.js";
import {
  createRulesHook,
  createSessionMessagesHook,
  sessionStartRuleContext,
} from "./rules-hook.js";
import {
  type AgentBackend,
  type AgentEvent,
  type AgentSession,
  type AgentUnexpectedExit,
  type BackendDescription,
  type LivePermissionMode,
  type PermissionResult,
  permissionModeAllows,
  type SessionOpts,
} from "./types.js";

const logger = createLogger("agent-runtime:claude-sdk");

const ORC_SYSTEM_CONTEXT = `You are an agent orchestrated by ORC. ${ORC_TASK_GUIDANCE}`;

const SDK_ENV_PASSTHROUGH = /^CLAUDE_(CODE_ENTRYPOINT|AGENT_SDK_VERSION)$/;
const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, { at: number; loggedIn: boolean | null }>();
const sessionGrants = new Map<string, PermissionUpdate[]>();

let steerContinuationGraceMs = 120_000;
/** Test hook: shorten the wait for a steer continuation that never arrives. */
export function setClaudeSteerContinuationGraceMs(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("Grace must be a positive number of ms");
  steerContinuationGraceMs = ms;
}

export function sdkChatOverrides(
  source: ClaudeChatOptions,
): Pick<
  Options,
  "maxTurns" | "maxBudgetUsd" | "effort" | "thinking" | "fallbackModel" | "extraArgs"
> {
  return {
    ...(source.maxTurns !== undefined ? { maxTurns: source.maxTurns } : {}),
    ...(source.maxBudgetUsd !== undefined ? { maxBudgetUsd: source.maxBudgetUsd } : {}),
    ...(source.effort !== undefined ? { effort: source.effort } : {}),
    ...(source.thinking !== undefined ? { thinking: source.thinking } : {}),
    ...(source.fallbackModel !== undefined ? { fallbackModel: source.fallbackModel } : {}),
    ...(source.extraArgs !== undefined ? { extraArgs: source.extraArgs } : {}),
  };
}

export async function hostClaudeLoggedIn(
  host: SshExecHost,
  claudePath: string,
  fresh = false,
  environment: Record<string, string> = {},
): Promise<boolean | null> {
  const key = `${host.alias}\0${claudePath}`;
  const cached = authCache.get(key);
  const customEnvironment = Object.keys(environment).length > 0;
  if (!fresh && !customEnvironment && cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS)
    return cached.loggedIn;
  const result = await hostExec(host, [claudePath, "auth", "status"], {
    timeoutMs: 30_000,
    ...(customEnvironment
      ? { env: providerProcessEnvironment(environment), passEnv: Object.keys(environment) }
      : {}),
  });
  let loggedIn: boolean | null = null;
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === "boolean") loggedIn = parsed.loggedIn;
  } catch {}
  if (!customEnvironment) authCache.set(key, { at: Date.now(), loggedIn });
  return loggedIn;
}

async function sshSdkLaunch(
  host: SshExecHost,
  env: Record<string, string> = {},
): Promise<Partial<Options>> {
  const claudePath = await hostBinary(host, "claude");
  if (!claudePath) throw new Error(`claude CLI not found on ${host.alias}`);
  const prepared = await prepareSshSpawn(host, {
    env: { ...process.env, ...env },
    passEnv: Object.keys(env),
  });
  return {
    pathToClaudeCodeExecutable: claudePath,
    spawnClaudeCodeProcess: (options: SpawnOptions): SpawnedProcess => {
      const inline = Object.entries(options.env)
        .filter(
          ([key, value]) =>
            value !== undefined && SDK_ENV_PASSTHROUGH.test(key) && !Object.hasOwn(env, key),
        )
        .map(([key, value]) => `${key}=${value}`);
      const command = [options.command, ...options.args];
      const [bin = "ssh", ...args] = prepared.argv(
        inline.length > 0 ? ["env", ...inline, ...command] : command,
        options.cwd,
      );
      const child = spawn(bin, args, {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logger.debug("claude stderr (ssh)", {
          host: host.alias,
          bytes: chunk.length,
        });
      });
      prepared.track(new Promise((resolve) => child.once("exit", resolve)));
      const killLocal = child.kill.bind(child);
      const stop = (signal?: NodeJS.Signals): boolean => {
        void prepared.stop().finally(() => killLocal(signal));
        return true;
      };
      options.signal.addEventListener("abort", () => stop(), { once: true });
      return Object.assign(child, { kill: stop });
    },
  };
}

export function claudeContextWindow(modelUsage: unknown, model: string | undefined) {
  const entries = Object.entries(
    modelUsage && typeof modelUsage === "object" ? (modelUsage as Record<string, unknown>) : {},
  );
  const match =
    entries.find(([key]) => key === model) ?? (entries.length === 1 ? entries[0] : undefined);
  const window = (match?.[1] as { contextWindow?: unknown } | undefined)?.contextWindow;
  return typeof window === "number" && Number.isSafeInteger(window) && window > 0
    ? window
    : undefined;
}

function userMessage(content: string, uuid: NonNullable<SDKUserMessage["uuid"]>): SDKUserMessage {
  return { type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null };
}

function messageUuid(): NonNullable<SDKUserMessage["uuid"]> {
  return crypto.randomUUID() as NonNullable<SDKUserMessage["uuid"]>;
}

function stoppedResult(runtimeSessionId: string | undefined): AgentEvent {
  return {
    type: "result",
    data: { ...(runtimeSessionId ? { runtimeSessionId } : {}), outcome: "stopped" },
  };
}

/**
 * Streaming-input channel for one turn. The SDK pulls each message and writes
 * it to the CLI's stdin before asking for the next one, so a push resolves
 * exactly when delivery is confirmed — that is the ack steer() reports.
 */
class TurnInput implements AsyncIterable<SDKUserMessage> {
  private readonly pending: { message: SDKUserMessage; deliver: (error?: Error) => void }[] = [];
  private inflight: ((error?: Error) => void) | null = null;
  private ended = false;
  private wake: (() => void) | null = null;

  push(message: SDKUserMessage): Promise<void> {
    if (this.ended) return Promise.reject(new Error("The turn is no longer accepting input."));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ message, deliver: (error) => (error ? reject(error) : resolve()) });
      this.wake?.();
      this.wake = null;
    });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.failPending();
    this.wake?.();
    this.wake = null;
  }

  private failPending(): void {
    const error = new Error("The turn ended before this message was delivered.");
    for (const entry of this.pending.splice(0)) entry.deliver(error);
    this.inflight?.(error);
    this.inflight = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    try {
      while (true) {
        while (this.pending.length > 0) {
          // biome-ignore lint/style/noNonNullAssertion: shift() safe inside while(length>0)
          const entry = this.pending.shift()!;
          this.inflight = entry.deliver;
          yield entry.message;
          this.inflight = null;
          entry.deliver();
        }
        if (this.ended) return;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
    } finally {
      // query.return()/abort tears the iterator down mid-message; anything
      // not confirmed by then is an unconfirmed delivery, not a silent drop.
      this.ended = true;
      this.failPending();
    }
  }
}

const STDERR_TAIL_MAX = 4096;

function resolveObservedModel(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed === "<synthetic>") return undefined;
  return trimmed;
}

function singleModelUsageKey(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const keys = Object.keys(modelUsage as Record<string, unknown>).filter(
    (key) => key.trim().length > 0 && key !== "<synthetic>",
  );
  return keys.length === 1 ? keys[0] : undefined;
}

function extractToolInputSummary(
  name: string,
  input: unknown,
): { name: string; command?: string; description?: string } {
  if (!input || typeof input !== "object") return { name };
  const record = input as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.slice(0, 1000) : undefined;
  const description =
    typeof record.description === "string" ? record.description.slice(0, 500) : undefined;
  return {
    name,
    ...(command ? { command } : {}),
    ...(description ? { description } : {}),
  };
}

function backgroundTaskKind(
  taskType: string | undefined,
  toolName: string | undefined,
): ChatBackgroundTaskKind {
  if (toolName === "Monitor" || taskType === "monitor") return "monitor";
  if (taskType === "local_bash") return "shell";
  return "task";
}

type ClaudeTurn = {
  stopping: boolean;
  /** Final result emitted or interrupt decided; no further input is accepted. */
  closing: boolean;
  wroteText: boolean;
  streamedText: boolean;
  lastResult: SDKResultMessage | undefined;
  /**
   * Steers written to the CLI but not yet answered by a result. The CLI queues
   * mid-turn input and runs it as a continuation of the same query, so the
   * turn stays open until every delivered steer has had its run.
   */
  readonly pendingSteers: Set<string>;
};

type ClaudeStream = {
  readonly controller: AbortController;
  readonly input: TurnInput;
  query: Query | undefined;
  turn: ClaudeTurn | null;
  closed: boolean;
  intentionalClose: boolean;
  stderrTail: string;
  initModel: string | undefined;
  observedModel: string | undefined;
  readonly subagents: Map<string, ChatSubagentPayload>;
  readonly backgroundTasks: Map<string, ChatBackgroundTask>;
  readonly awaitingTaskNotifications: Set<string>;
  readonly toolInputs: Map<string, { name: string; command?: string; description?: string }>;
  finished: Promise<void>;
};

class ClaudeSDKSession implements AgentSession {
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly id = ulid();
  readonly systemPromptSlot = true;
  readonly reusable: boolean;

  private runtimeSessionId: string | undefined;
  /** The first query resumes the source with `forkSession`; later queries resume the new id. */
  private forkPending: boolean;
  private humanWaitCount = 0;
  private readonly humanReceipts = new Map<string, { id: string; version: number }[]>();
  private done = false;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private readonly permissionResolvers = new Map<
    string,
    { tool: string; resolve: (result: PermissionResult, feedback?: string) => void }
  >();
  private liveMode: LivePermissionMode | undefined;
  private readonly questionResolvers = new Map<
    string,
    { question: ChatQuestion; resolve: (answers: Record<string, string[]> | null) => void }
  >();
  private readonly unexpectedExitListeners = new Set<(info: AgentUnexpectedExit) => void>();
  private stream: ClaudeStream | null = null;
  private turn: ClaudeTurn | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private opts: SessionOpts;
  private readonly host: ExecHost;

  constructor(opts: SessionOpts, host: ExecHost) {
    this.opts = opts;
    this.host = host;
    this.reusable = Boolean(opts.resident);
    this.runtimeSessionId = opts.runtimeSessionId;
    this.forkPending = !!opts.forkSourceRuntimeId;
  }

  private push(event: AgentEvent): void {
    this.eventQueue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private async waitForQuestion(
    stream: ClaudeStream,
    question: ChatQuestion,
    signal: AbortSignal,
  ): Promise<Record<string, string[]> | null> {
    const push = (event: AgentEvent) => this.pushStream(stream, event);
    let cancel = () => {};
    try {
      return await new Promise<Record<string, string[]> | null>((resolve) => {
        const requestId = question.requestId;
        cancel = () => {
          if (this.questionResolvers.delete(requestId))
            push({ type: "request_resolved", data: { requestId } });
          resolve(null);
        };
        this.questionResolvers.set(requestId, { question, resolve });
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        else push({ type: "question_request", data: question });
      });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  send(prompt: string): Promise<void> {
    // Serialize sends: two concurrent sends used to orphan the first new
    // driveStream, whose unwind then ended the second turn's events (R-15).
    const started = this.sendChain.then(() => this.startTurn(prompt));
    this.sendChain = started.catch(() => {});
    return started;
  }

  private async startTurn(prompt: string): Promise<void> {
    if (this.reusable && this.stream && !this.stream.closed && !this.turn) {
      const turn: ClaudeTurn = {
        stopping: false,
        closing: false,
        wroteText: false,
        streamedText: false,
        lastResult: undefined,
        pendingSteers: new Set(),
      };
      this.done = false;
      this.eventQueue.length = 0;
      this.turn = turn;
      this.stream.turn = turn;
      if (this.stream.observedModel) this.push({ type: "model", data: this.stream.observedModel });
      this.stream.input.push(userMessage(prompt, messageUuid())).catch(() => {});
      return;
    }

    const previous = this.stream;
    if (previous) {
      // Detach before draining: the replaced stream's unwind must not end an
      // events() consumer that is about to read the replacement turn.
      this.stream = null;
      this.turn = null;
      previous.intentionalClose = true;
      previous.turn = null;
      previous.controller.abort();
      previous.input.end();
      await previous.finished;
    }
    this.done = false;
    this.eventQueue.length = 0;
    const turn: ClaudeTurn = {
      stopping: false,
      closing: false,
      wroteText: false,
      streamedText: false,
      lastResult: undefined,
      pendingSteers: new Set(),
    };
    const stream: ClaudeStream = {
      controller: new AbortController(),
      input: new TurnInput(),
      query: undefined,
      turn,
      closed: false,
      intentionalClose: false,
      stderrTail: "",
      initModel: undefined,
      observedModel: undefined,
      subagents: new Map(),
      backgroundTasks: new Map(),
      awaitingTaskNotifications: new Set(),
      toolInputs: new Map(),
      finished: Promise.resolve(),
    };
    this.stream = stream;
    this.turn = turn;
    // The initial prompt rides the same streaming input as steers; nobody
    // awaits its delivery ack, but a teardown rejection must not be unhandled.
    stream.input.push(userMessage(prompt, messageUuid())).catch(() => {});
    stream.finished = this.driveStream(stream);
  }

  async steer(prompt: string): Promise<void> {
    const stream = this.stream;
    const turn = this.turn;
    if (!stream || !turn || this.done || turn.stopping || turn.closing)
      throw new Error("No active Claude turn to steer.");
    if (!prompt.trim() || prompt.length > 100000)
      throw new Error("Enter a steering message up to 100000 characters.");
    const uuid = messageUuid();
    turn.pendingSteers.add(uuid);
    try {
      await stream.input.push(userMessage(prompt, uuid));
    } catch (error) {
      turn.pendingSteers.delete(uuid);
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    const stream = this.stream;
    const turn = this.turn;
    if (!stream || !turn || this.done || turn.stopping) return;
    turn.stopping = true;
    stream.intentionalClose = true;
    // Release anything the CLI is blocked on so the turn can actually end.
    for (const [requestId, pending] of [...this.questionResolvers]) {
      this.questionResolvers.delete(requestId);
      pending.resolve(null);
      this.pushStream(stream, { type: "request_resolved", data: { requestId } });
    }
    for (const [requestId, pending] of [...this.permissionResolvers]) {
      this.permissionResolvers.delete(requestId);
      pending.resolve("denied");
      this.pushStream(stream, { type: "request_resolved", data: { requestId } });
    }
    if (stream.query) {
      // cancelQueued stops delivered-but-unrun steers from executing after the
      // interrupt; without it the CLI runs them after the stopped turn. The
      // installed SDK implements the option ahead of its .d.ts signature, and
      // older CLIs ignore it (interrupt_cancel_queued_v1) — the receipt's
      // still_queued then lists survivors that may yet run.
      const interrupt = stream.query.interrupt as (options?: {
        cancelQueued?: boolean;
      }) => Promise<SDKControlInterruptResponse | undefined>;
      const receipt = await interrupt({ cancelQueued: true });
      if (receipt && receipt.still_queued.length > 0) {
        logger.debug("Claude interrupt left queued commands", {
          count: receipt.still_queued.length,
        });
      }
    } else stream.controller.abort();
  }

  /** Events from an unwinding stream must never reach the next stream's queue. */
  private pushStream(stream: ClaudeStream, event: AgentEvent): void {
    if (this.stream === stream) this.push(event);
  }

  private async driveStream(stream: ClaudeStream): Promise<void> {
    const abortController = stream.controller;
    const push = (event: AgentEvent) => this.pushStream(stream, event);
    const { subagents, backgroundTasks, awaitingTaskNotifications, toolInputs } = stream;
    const updateSubagent = (id: string | undefined, patch: Partial<ChatSubagentPayload>) => {
      const current = id ? subagents.get(id) : undefined;
      if (!current) return;
      const next = { ...current, ...patch };
      subagents.set(current.id, next);
      push({ type: "subagent", data: next });
    };
    const updateBackgroundTask = (id: string | undefined, patch: Partial<ChatBackgroundTask>) => {
      const current = id ? backgroundTasks.get(id) : undefined;
      if (!current) return;
      const next = { ...current, ...patch };
      backgroundTasks.set(current.id, next);
      push({ type: "background_task", data: next });
    };
    const subagentsRunning = () =>
      [...subagents.values()].some((item) => !CHAT_SUBAGENT_DONE.has(item.status));
    const backgroundTasksRunning = () =>
      [...backgroundTasks.values()].some((item) => item.status === "running");
    const hasPendingBackgroundWork = () =>
      subagentsRunning() || backgroundTasksRunning() || awaitingTaskNotifications.size > 0;
    const collectActiveBackgroundWork = (): ChatLostBackgroundWorkItem[] => {
      const items: ChatLostBackgroundWorkItem[] = [];
      for (const task of backgroundTasks.values()) {
        if (task.status === "running") {
          items.push({
            kind: task.kind,
            id: task.id,
            label: (task.description || task.command || task.id).slice(0, 500),
          });
        }
      }
      for (const sub of subagents.values()) {
        if (!CHAT_SUBAGENT_DONE.has(sub.status)) {
          items.push({
            kind: "subagent",
            id: sub.id,
            label: (sub.title ?? sub.id).slice(0, 500),
          });
        }
      }
      return items.slice(0, 20);
    };
    const stopSubagents = (finalStatus: "stopped" | "interrupted" = "stopped") => {
      for (const item of subagents.values())
        if (!CHAT_SUBAGENT_DONE.has(item.status)) updateSubagent(item.id, { status: "stopped" });
      for (const task of backgroundTasks.values())
        if (task.status === "running")
          updateBackgroundTask(task.id, { status: finalStatus, finishedAt: Date.now() });
      awaitingTaskNotifications.clear();
    };
    let nativeQuery: Query | undefined;
    let continuationGrace: ReturnType<typeof setTimeout> | undefined;
    const clearContinuationGrace = () => {
      clearTimeout(continuationGrace);
      continuationGrace = undefined;
    };
    try {
      const supplied = this.opts.chatAgentOptions
        ? ChatAgentOptionsSchema.parse(this.opts.chatAgentOptions)
        : undefined;
      if (supplied && supplied.runtime !== "claude-sdk")
        throw new Error("Claude requires SDK launch options");
      const options: ClaudeChatOptions = supplied?.runtime === "claude-sdk" ? supplied.options : {};
      const permissionMode =
        this.opts.toolAllowlist !== undefined
          ? "default"
          : (this.liveMode ??
            options.permissionMode ??
            this.opts.permissionMode ??
            (this.opts.autoApprove ? "bypassPermissions" : "default"));
      logger.info("Starting Claude SDK query", {
        permissionMode,
        cwd: this.opts.cwd,
        resume: this.runtimeSessionId,
      });

      const rulesHook = this.opts.ruleGuard
        ? createRulesHook(
            this.opts.ruleGuard,
            this.opts.cwd,
            (event) => push(event),
            (waiting) => {
              this.humanWaitCount = Math.max(0, this.humanWaitCount + (waiting ? 1 : -1));
            },
            (id, receipts) => {
              this.humanReceipts.set(id, receipts);
            },
          )
        : createSessionMessagesHook(this.runtimeSessionId ?? this.id);
      const dbPath = resolve(loadConfig().db.path);
      const settingsRuleHooks = new Set(
        (this.host.kind === "ssh"
          ? []
          : [
              join(this.opts.env?.CLAUDE_CONFIG_DIR ?? claudeConfigDirectory(), "settings.json"),
              join(this.opts.cwd, ".claude", "settings.json"),
              join(this.opts.cwd, ".claude", "settings.local.json"),
            ]
        ).flatMap((file) => {
          try {
            const settings = JSON.parse(readFileSync(file, "utf8")) as {
              hooks?: Record<string, { hooks?: { command?: unknown }[] }[]>;
            };
            return Object.values(settings.hooks ?? {}).flatMap((entries) =>
              entries.flatMap((entry) =>
                (entry.hooks ?? []).flatMap((handler) => {
                  const match =
                    typeof handler.command === "string"
                      ? /--db "(.+)" rules hook claude (\w+)$/.exec(handler.command)
                      : null;
                  return match?.[1] && match[2] && resolve(match[1]) === dbPath ? [match[2]] : [];
                }),
              ),
            );
          } catch {
            return [];
          }
        }),
      );
      const startupContext =
        this.opts.ruleGuard && !settingsRuleHooks.has("SessionStart")
          ? await sessionStartRuleContext(
              this.opts.ruleGuard,
              this.opts.cwd,
              this.runtimeSessionId ?? this.id,
              ulid(),
              this.runtimeSessionId ? "resume" : "startup",
            )
          : "";

      const launch =
        this.host.kind === "ssh"
          ? await sshSdkLaunch(this.host, this.opts.env)
          : this.opts.providerExecutable
            ? resolveClaudeSdkLaunch(true, (name) =>
                name === "claude"
                  ? Bun.which(this.opts.providerExecutable ?? "claude")
                  : Bun.which(name),
              )
            : resolveClaudeSdkLaunch();
      const q = query({
        prompt: stream.input,
        options: {
          ...sdkChatOverrides(options),
          ...launch,
          stderr: (chunk: string) => {
            if (!chunk) return;
            stream.stderrTail = (stream.stderrTail + chunk).slice(-STDERR_TAIL_MAX);
          },
          env: { ...process.env, ...this.opts.env },
          cwd: this.opts.cwd,
          ...(rulesHook
            ? {
                hooks: Object.fromEntries(
                  HOOK_EVENTS.filter(
                    (event) =>
                      event !== "SessionStart" &&
                      !settingsRuleHooks.has(event) &&
                      RULE_EVENT_ADAPTERS.claude.some((entry) => entry.native === event),
                  ).map((event) => [
                    event,
                    [
                      {
                        hooks: [rulesHook],
                        timeout: Math.max(10, (this.opts.ruleGuard?.humanWaitSeconds ?? 0) + 15),
                      },
                    ],
                  ]),
                ),
              }
            : {}),
          permissionMode,
          settingSources: ["user", "project", "local"],
          ...(this.opts.toolAllowlist !== undefined
            ? {
                strictMcpConfig: true,
                tools: this.opts.toolAllowlist.filter((name) => !name.startsWith("mcp__")),
                ...(this.opts.orcMcp === false
                  ? { mcpServers: {}, allowedTools: [...this.opts.toolAllowlist] }
                  : {
                      mcpServers: buildOrcMcpServers(
                        this.host,
                        this.opts.mcpAlwaysLoad,
                        this.opts.orcMcpMode,
                        this.opts.orcMcpProject,
                        this.opts.orcPreviewSessionId ?? this.opts.attentionContext?.chatThreadId,
                      ),
                      allowedTools: [...this.opts.toolAllowlist, ORC_TOOLS_RULE],
                    }),
              }
            : this.opts.ruleGuard || this.opts.orcMcp
              ? {
                  mcpServers: buildOrcMcpServers(
                    this.host,
                    this.opts.mcpAlwaysLoad,
                    this.opts.orcMcpMode,
                    this.opts.orcMcpProject,
                    this.opts.orcPreviewSessionId ?? this.opts.attentionContext?.chatThreadId,
                  ),
                }
              : {}),
          ...(this.opts.toolAllowlist === undefined
            ? {
                allowedTools: (sessionGrants.get(this.runtimeSessionId ?? "") ?? []).flatMap(
                  (update) =>
                    update.type === "addRules" && update.behavior === "allow"
                      ? update.rules.map((rule) =>
                          rule.ruleContent
                            ? `${rule.toolName}(${rule.ruleContent})`
                            : rule.toolName,
                        )
                      : [],
                ),
                additionalDirectories: (
                  sessionGrants.get(this.runtimeSessionId ?? "") ?? []
                ).flatMap((update) => (update.type === "addDirectories" ? update.directories : [])),
              }
            : {}),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: [
              this.opts.systemPromptAppend || ORC_SYSTEM_CONTEXT,
              this.opts.ruleGuard?.context,
              startupContext,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          abortController,
          onElicitation: async (request, { signal }) => {
            const requestId = ulid();
            try {
              const form = elicitationForm(requestId, request);
              const result = await this.waitForQuestion(stream, form.question, signal);
              if (!result) return { action: "cancel" };
              const content = form.content(result);
              return content ? { action: "accept", content } : { action: "decline" };
            } catch {
              push({
                type: "system_status",
                data: "MCP form declined: secret, URL authentication, or unsupported input requires the native client",
              });
              return { action: "cancel" };
            }
          },
          canUseTool: async (toolName, input, options) => {
            const signal = options?.signal ?? abortController.signal;
            if (
              this.opts.toolAllowlist !== undefined &&
              this.opts.orcMcp !== false &&
              toolName.startsWith(ORC_TOOL_PREFIX)
            ) {
              return { behavior: "allow", updatedInput: input };
            }
            if (
              this.opts.toolAllowlist !== undefined &&
              !this.opts.toolAllowlist.includes(toolName)
            ) {
              return {
                behavior: "deny",
                message: "Tool is outside the agent profile whitelist",
              };
            }
            const requestId = ulid();
            if (signal.aborted) return { behavior: "deny", message: "Request cancelled" };
            if (stream.turn?.stopping)
              return { behavior: "deny", message: "The turn was interrupted." };
            if (toolName === "AskUserQuestion") {
              const source = input.questions;
              if (!Array.isArray(source))
                return { behavior: "deny", message: "Unsupported question format" };
              const question = ChatQuestionSchema.parse({
                requestId,
                questions: source.map((value, index) => {
                  const entry = value as Record<string, unknown>;
                  return {
                    id: `q-${index}`,
                    header: entry.header ?? "Question",
                    question: entry.question,
                    multiSelect: entry.multiSelect,
                    options: entry.options ?? null,
                  };
                }),
              });
              if (
                new Set(question.questions.map((entry) => entry.question)).size !==
                question.questions.length
              )
                return {
                  behavior: "deny",
                  message: "Duplicate question text cannot be answered unambiguously",
                };
              const result = await this.waitForQuestion(stream, question, signal);
              if (!result) return { behavior: "deny", message: "Question cancelled" };
              return {
                behavior: "allow",
                updatedInput: {
                  ...input,
                  answers: Object.fromEntries(
                    question.questions.map((entry) => [
                      entry.question,
                      result[entry.id]?.join(", ") ?? "",
                    ]),
                  ),
                },
              };
            }
            if (this.opts.toolAllowlist !== undefined && this.opts.autoApprove)
              return { behavior: "allow", updatedInput: input };
            if (permissionModeAllows(this.liveMode, toolName))
              return { behavior: "allow", updatedInput: input };
            const command = JSON.stringify(input);
            logger.info("canUseTool called", { toolName, requestId });
            push({
              type: "permission_request",
              data: {
                requestId,
                tool: toolName,
                command,
                input,
                cwd: this.opts.cwd,
                allowSession: toolName !== "ExitPlanMode" && !options?.suppressAlwaysAllowRule,
              },
            });
            let cancel = () => {};
            let result: PermissionResult;
            let feedback: string | undefined;
            updateSubagent(options?.agentID, { status: "waiting" });
            try {
              result = await new Promise<PermissionResult>((resolve) => {
                cancel = () => {
                  if (this.permissionResolvers.delete(requestId))
                    push({ type: "request_resolved", data: { requestId } });
                  resolve("denied");
                };
                this.permissionResolvers.set(requestId, {
                  tool: toolName,
                  resolve: (value, text) => {
                    feedback = text;
                    resolve(value);
                  },
                });
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) cancel();
              });
            } finally {
              signal.removeEventListener("abort", cancel);
              if (subagents.get(options?.agentID ?? "")?.status === "waiting")
                updateSubagent(options?.agentID, { status: "running" });
            }
            const granted = (options?.suggestions ?? [])
              .filter((update) => update.type !== "setMode")
              .map((update) => ({ ...update, destination: "session" as const }));
            if (
              result === "session" &&
              granted.length &&
              this.runtimeSessionId &&
              toolName !== "ExitPlanMode" &&
              !options?.suppressAlwaysAllowRule
            ) {
              const saved = sessionGrants.get(this.runtimeSessionId) ?? [];
              sessionGrants.set(this.runtimeSessionId, [
                ...saved,
                ...granted.filter(
                  (update) =>
                    !saved.some((entry) => JSON.stringify(entry) === JSON.stringify(update)),
                ),
              ]);
              return { behavior: "allow", updatedInput: input, updatedPermissions: granted };
            }
            if (
              toolName === "ExitPlanMode" &&
              result !== "denied" &&
              this.liveMode &&
              this.liveMode !== "plan"
            )
              return {
                behavior: "allow",
                updatedInput: input,
                updatedPermissions: [
                  {
                    type: "setMode",
                    mode: this.liveMode === "bypassPermissions" ? "acceptEdits" : this.liveMode,
                    destination: "session",
                  },
                ],
              };
            if (result === "approved" || result === "session") {
              return { behavior: "allow", updatedInput: input };
            }
            return {
              behavior: "deny",
              message: feedback
                ? `The user denied this and said: ${feedback}`
                : "Permission denied",
            };
          },
          ...(this.forkPending && !this.runtimeSessionId && this.opts.forkSourceRuntimeId
            ? { resume: this.opts.forkSourceRuntimeId, forkSession: true }
            : this.runtimeSessionId
              ? { resume: this.runtimeSessionId }
              : {}),
          ...(this.opts.model ? { model: this.opts.model } : {}),
          includePartialMessages: true,
        },
      });
      nativeQuery = q;
      stream.query = q;

      const emitResult = (turn: ClaudeTurn, msg: SDKResultMessage, closeAfter: boolean) => {
        if (turn.closing) return;
        const effectiveModel =
          stream.observedModel ?? stream.initModel ?? singleModelUsageKey(msg.modelUsage);
        if (effectiveModel && effectiveModel !== stream.observedModel) {
          stream.observedModel = effectiveModel;
          push({ type: "model", data: effectiveModel });
        }
        if (closeAfter || turn.stopping || msg.is_error) stopSubagents("stopped");
        turn.closing = true;
        clearContinuationGrace();
        if (msg.is_error && !turn.stopping) {
          const reason = msg.terminal_reason ?? msg.subtype;
          push({
            type: "error",
            data:
              ("errors" in msg ? msg.errors.join("\n") : msg.result).trim() ||
              (
                {
                  prompt_too_long:
                    "The conversation no longer fits the context window. Run /compact or start a new chat.",
                  blocking_limit: "Usage limit reached. Wait for it to reset.",
                  rapid_refill_breaker: "Usage limit reached. Wait for it to reset.",
                  max_turns: "Claude reached the turn limit.",
                  error_max_turns: "Claude reached the turn limit.",
                  budget_exhausted: "Claude reached its spending budget.",
                  error_max_budget_usd: "Claude reached its spending budget.",
                  image_error: "Claude could not process an attached image.",
                  model_error: "The model returned an error. Try again or pick another model.",
                  api_error: "The Claude API returned an error. Try again or pick another model.",
                } as Record<string, string>
              )[reason] ||
              `Claude stopped with an error (${reason === "success" ? "no details" : reason}).`,
          });
        } else {
          if (
            !turn.stopping &&
            !turn.wroteText &&
            "result" in msg &&
            typeof msg.result === "string" &&
            msg.result.trim().length > 0 &&
            msg.usage?.output_tokens === 0
          ) {
            push({ type: "text", data: msg.result });
            turn.wroteText = true;
          }
          push({
            type: "result",
            data: {
              runtimeSessionId: msg.session_id,
              ...(effectiveModel ? { model: effectiveModel } : {}),
              usage: msg.usage,
              contextWindow: claudeContextWindow(msg.modelUsage, effectiveModel),
              durationMs: msg.duration_ms,
              ...(turn.stopping ? { outcome: "stopped" as const } : {}),
            },
          });
        }
        if (closeAfter || !this.reusable || turn.stopping || msg.is_error) {
          stream.intentionalClose = true;
          stream.input.end();
        } else if (this.stream === stream && this.turn === turn) {
          stream.turn = null;
          this.turn = null;
          this.done = true;
          this.resolveNext?.();
          this.resolveNext = null;
        }
      };

      const armContinuationGrace = (turn: ClaudeTurn) => {
        clearContinuationGrace();
        continuationGrace = setTimeout(() => {
          if (
            stream.turn === turn &&
            !turn.closing &&
            turn.lastResult &&
            !hasPendingBackgroundWork()
          ) {
            if (!turn.stopping && turn.pendingSteers.size > 0) {
              push({
                type: "system_status",
                data: "A steering message was not answered before the response ended.",
              });
            }
            emitResult(turn, turn.lastResult, false);
          }
        }, steerContinuationGraceMs);
      };

      for await (const msg of q) {
        const turn = stream.turn;
        if (turn?.closing && stream.intentionalClose) continue;
        if (
          msg.type === "stream_event" ||
          msg.type === "assistant" ||
          msg.type === "result" ||
          (msg.type === "system" && msg.subtype === "task_started")
        ) {
          clearContinuationGrace();
        }
        if (msg.type === "stream_event") {
          if (!turn || turn.closing) continue;
          const event = msg.event;
          if (event.type === "content_block_start" && event.content_block.type === "text") {
            if (turn.wroteText) push({ type: "text", data: "\n\n" });
            turn.wroteText = true;
            turn.streamedText = true;
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            push({ type: "text", data: event.delta.text });
          continue;
        }
        if (msg.type === "rate_limit_event") {
          const event = claudeLimitEvent(msg.rate_limit_info);
          if (event) push(event);
          continue;
        }
        if (msg.type === "system" && msg.subtype === "task_started") {
          if (msg.ambient) continue;
          const isSubagent = msg.task_type
            ? msg.task_type === "local_agent"
            : Boolean(msg.subagent_type);
          if (isSubagent) {
            const parentId =
              msg.parent_task_id && subagents.has(msg.parent_task_id)
                ? msg.parent_task_id
                : undefined;
            const started: ChatSubagentPayload = {
              id: msg.task_id,
              ...(parentId ? { parentId } : {}),
              title: (msg.description || msg.subagent_type || "Subagent").slice(0, 200),
              status: "running",
              startedAt: Date.now(),
              activity: [],
            };
            subagents.set(msg.task_id, started);
            push({ type: "subagent", data: started });
            continue;
          }
          if (!msg.task_type) continue;
          const toolInfo = msg.tool_use_id ? toolInputs.get(msg.tool_use_id) : undefined;
          const kind = backgroundTaskKind(msg.task_type, toolInfo?.name);
          const task: ChatBackgroundTask = {
            id: msg.task_id,
            kind,
            description: (
              msg.description ||
              toolInfo?.description ||
              toolInfo?.command ||
              msg.task_type
            ).slice(0, 500),
            ...(toolInfo?.command ? { command: toolInfo.command } : {}),
            startedAt: Date.now(),
            status: "running",
          };
          backgroundTasks.set(msg.task_id, task);
          push({ type: "background_task", data: task });
          continue;
        }
        if (
          msg.type === "system" &&
          (msg as { subtype?: string }).subtype === "background_tasks_changed"
        ) {
          const record = msg as unknown as {
            tasks?: Array<{
              task_id?: string;
              id?: string;
              task_type?: string;
              description?: string;
              command?: string;
              status?: string;
            }>;
            awaiting_notifications?: string[];
          };
          if (Array.isArray(record.awaiting_notifications)) {
            awaitingTaskNotifications.clear();
            for (const id of record.awaiting_notifications) {
              if (typeof id === "string" && id) awaitingTaskNotifications.add(id);
            }
          }
          if (Array.isArray(record.tasks)) {
            const seen = new Set<string>();
            for (const entry of record.tasks) {
              const id = entry.task_id ?? entry.id;
              if (!id || subagents.has(id) || entry.task_type === "local_agent") continue;
              seen.add(id);
              const existing = backgroundTasks.get(id);
              const nextStatus =
                entry.status === "completed" ||
                entry.status === "failed" ||
                entry.status === "stopped"
                  ? entry.status
                  : entry.status === "killed"
                    ? "stopped"
                    : "running";
              const next: ChatBackgroundTask = existing
                ? {
                    ...existing,
                    status: nextStatus,
                    ...(nextStatus !== "running" && !existing.finishedAt
                      ? { finishedAt: Date.now() }
                      : {}),
                  }
                : {
                    id,
                    kind: backgroundTaskKind(entry.task_type, undefined),
                    description: (entry.description || entry.command || id).slice(0, 500),
                    ...(entry.command ? { command: entry.command.slice(0, 1000) } : {}),
                    startedAt: Date.now(),
                    status: nextStatus,
                  };
              backgroundTasks.set(id, next);
              push({ type: "background_task", data: next });
            }
            for (const [id, existing] of backgroundTasks) {
              if (!seen.has(id) && existing.status === "running") {
                updateBackgroundTask(id, { status: "completed", finishedAt: Date.now() });
              }
            }
          }
          if (turn && !turn.closing && turn.lastResult && !hasPendingBackgroundWork()) {
            armContinuationGrace(turn);
          }
          continue;
        }
        if (msg.type === "system" && msg.subtype === "task_progress") {
          const line = (msg.summary || msg.description).slice(0, 2000);
          if (subagents.has(msg.task_id)) {
            updateSubagent(msg.task_id, {
              tokens: msg.usage.total_tokens,
              durationMs: msg.usage.duration_ms,
              activity: line ? [{ type: "status", id: `${msg.task_id}:progress`, text: line }] : [],
            });
          } else if (backgroundTasks.has(msg.task_id)) {
            updateBackgroundTask(msg.task_id, {
              ...(line ? { summary: line } : {}),
            });
          }
          continue;
        }
        if (msg.type === "system" && msg.subtype === "task_updated") {
          const status = msg.patch.status;
          if (status === "completed" || status === "failed" || status === "killed") {
            const mapped = status === "killed" ? "stopped" : status;
            if (subagents.has(msg.task_id)) {
              updateSubagent(msg.task_id, { status: mapped });
            } else if (backgroundTasks.has(msg.task_id)) {
              updateBackgroundTask(msg.task_id, { status: mapped, finishedAt: Date.now() });
            }
            if (turn && !turn.closing && turn.lastResult && !hasPendingBackgroundWork()) {
              armContinuationGrace(turn);
            }
          }
          continue;
        }
        if (msg.type === "system" && msg.subtype === "task_notification") {
          awaitingTaskNotifications.delete(msg.task_id);
          const status: ChatSubagentStatus = msg.status;
          if (subagents.has(msg.task_id)) {
            updateSubagent(msg.task_id, {
              status,
              ...(msg.usage
                ? { tokens: msg.usage.total_tokens, durationMs: msg.usage.duration_ms }
                : {}),
            });
          } else if (backgroundTasks.has(msg.task_id)) {
            updateBackgroundTask(msg.task_id, {
              status,
              finishedAt: Date.now(),
              ...(msg.summary ? { summary: msg.summary.slice(0, 2000) } : {}),
              ...(msg.output_file ? { outputFile: msg.output_file.slice(0, 1000) } : {}),
            });
          }
          if (turn && !turn.closing && turn.lastResult && !hasPendingBackgroundWork()) {
            armContinuationGrace(turn);
          }
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          this.runtimeSessionId = msg.session_id;
          this.forkPending = false;
          const initModel = resolveObservedModel(msg.model);
          if (initModel) {
            stream.initModel = initModel;
            if (!stream.observedModel) {
              stream.observedModel = initModel;
              push({ type: "model", data: initModel });
            }
          }
          continue;
        }

        if (msg.type === "system" && msg.subtype === "api_retry") {
          push({
            type: "system_status",
            data: `Claude API ${msg.error_status ?? "connection"} error; retrying in ${Math.ceil(msg.retry_delay_ms / 1000)}s (attempt ${msg.attempt} of ${msg.max_retries}).`,
          });
          continue;
        }

        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          push({ type: "system_status", data: "Context compacted." });
          continue;
        }

        if (msg.type === "assistant") {
          if (msg.error && msg.message.model === "<synthetic>") continue;
          const assistantModel = resolveObservedModel(msg.message.model);
          if (assistantModel && assistantModel !== stream.observedModel) {
            stream.observedModel = assistantModel;
            push({ type: "model", data: assistantModel });
          }
          if (!turn || turn.closing) continue;
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              if (!turn.streamedText)
                push({ type: "text", data: turn.wroteText ? `\n\n${block.text}` : block.text });
              turn.wroteText = true;
            } else if (block.type === "thinking" && "thinking" in block && block.thinking) {
              push({ type: "thinking", data: block.thinking as string });
            } else if (block.type === "tool_use") {
              if (toolInputs.size >= 500) {
                const oldest = toolInputs.keys().next().value;
                if (oldest !== undefined) toolInputs.delete(oldest);
              }
              toolInputs.set(block.id, extractToolInputSummary(block.name, block.input));
              const input = JSON.stringify(block.input);
              push({
                type: "tool_use",
                data: {
                  id: block.id,
                  name: block.name,
                  input,
                },
              });
              // TodoWrite carries the agent's checklist; the tool row stays, the plan is structured.
              const plan = planFromToolInput(block.name, input);
              if (plan) push(plan);
            }
          }
          if (!msg.parent_tool_use_id) turn.streamedText = false;
          continue;
        }

        if (msg.type === "user" && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === "tool_result") {
              toolInputs.delete(block.tool_use_id);
              const receipts = this.humanReceipts.get(block.tool_use_id);
              if (receipts) {
                const store = new HumanRequestStore(getSqlite());
                for (const receipt of receipts) {
                  const request = store.get(receipt.id);
                  if (request.status === "answered" && request.version === receipt.version)
                    store.acknowledge(receipt.id, receipt.version);
                }
                this.humanReceipts.delete(block.tool_use_id);
              }
            }
            if (block.type === "tool_result")
              push({
                type: "tool_result",
                data: {
                  toolUseId: block.tool_use_id,
                  content:
                    typeof block.content === "string"
                      ? block.content
                      : JSON.stringify(block.content ?? ""),
                  isError: block.is_error ?? false,
                },
              });
          }
        }

        if (msg.type === "result") {
          this.runtimeSessionId = msg.session_id;
          if (!turn || turn.closing) continue;
          turn.lastResult = msg;
          const answered =
            "user_message_uuids" in msg && Array.isArray(msg.user_message_uuids)
              ? msg.user_message_uuids
              : [];
          for (const id of answered) turn.pendingSteers.delete(id);
          const trigger = "user_message_uuid" in msg ? msg.user_message_uuid : undefined;
          if (typeof trigger === "string") turn.pendingSteers.delete(trigger);
          const queued = "queued_turn_count" in msg ? msg.queued_turn_count : undefined;
          const trackable = typeof trigger === "string" || answered.length > 0;
          const moreRuns =
            (typeof queued === "number" && queued > 0) ||
            (trackable && turn.pendingSteers.size > 0);
          if (!turn.stopping && hasPendingBackgroundWork()) continue;
          if (!turn.stopping && moreRuns) {
            armContinuationGrace(turn);
            continue;
          }
          emitResult(turn, msg, false);
        }
      }

      const activeTurn = stream.turn;
      if (activeTurn && !activeTurn.closing) {
        if (activeTurn.stopping) {
          stopSubagents("stopped");
          activeTurn.closing = true;
          push(stoppedResult(this.runtimeSessionId));
        } else if (activeTurn.lastResult) {
          emitResult(activeTurn, activeTurn.lastResult, true);
        }
      }
    } catch (err) {
      const activeTurn = stream.turn;
      if (activeTurn?.stopping && !activeTurn.closing) {
        stopSubagents("stopped");
        activeTurn.closing = true;
        push(stoppedResult(this.runtimeSessionId));
      } else if (
        stream.intentionalClose ||
        activeTurn?.closing ||
        stream.controller.signal.aborted ||
        (err as Error).name === "AbortError"
      ) {
        logger.debug("Claude SDK stream closed", {
          message:
            this.opts.redactOutput?.(err instanceof Error ? err.message : String(err)) ??
            (err instanceof Error ? err.message : String(err)),
        });
      } else {
        logger.error("Claude SDK query error", {
          message:
            this.opts.redactOutput?.(err instanceof Error ? err.message : String(err)) ??
            (err instanceof Error ? err.message : String(err)),
        });
        const detail = err instanceof Error ? err.message : String(err);
        const stderrNote = stream.stderrTail.trim()
          ? `\n${stream.stderrTail.trim().slice(-600)}`
          : "";
        stopSubagents("interrupted");
        push({
          type: "error",
          data: `${detail}${stderrNote}`,
        });
      }
    } finally {
      clearContinuationGrace();
      const lostBackgroundWork = stream.intentionalClose ? [] : collectActiveBackgroundWork();
      if (lostBackgroundWork.length > 0) stopSubagents("interrupted");
      stream.closed = true;
      stream.input.end();
      try {
        await nativeQuery?.return();
      } catch (error) {
        logger.warn("Claude SDK cleanup failed", {
          message: this.opts.redactOutput?.(String(error)) ?? String(error),
        });
        push({ type: "error", data: "Claude connection could not be closed cleanly." });
      }
      if (!stream.intentionalClose && this.unexpectedExitListeners.size > 0) {
        const info: AgentUnexpectedExit = {
          code: null,
          signal: null,
          stderr: stream.stderrTail.trim(),
          lostBackgroundWork,
        };
        for (const listener of [...this.unexpectedExitListeners]) {
          try {
            listener(info);
          } catch (error) {
            logger.warn("Unexpected exit listener threw", { error });
          }
        }
      }
      if (this.stream === stream) {
        stream.turn = null;
        this.turn = null;
        this.done = true;
        this.resolveNext?.();
        this.resolveNext = null;
      }
    }
  }

  respondPermission(requestId: string, result: PermissionResult, feedback?: string): void {
    const pending = this.permissionResolvers.get(requestId);
    if (!pending) throw new Error("This approval is no longer pending");
    this.permissionResolvers.delete(requestId);
    pending.resolve(result, feedback?.trim() || undefined);
    this.push({ type: "request_resolved", data: { requestId } });
  }

  setPermissionMode(mode: LivePermissionMode): void {
    this.liveMode = mode;
    this.stream?.query
      ?.setPermissionMode(mode === "bypassPermissions" ? "acceptEdits" : mode)
      .catch((error) => logger.warn("Claude permission mode change failed", { mode, error }));
    for (const [requestId, pending] of this.permissionResolvers)
      if (permissionModeAllows(mode, pending.tool)) this.respondPermission(requestId, "approved");
  }

  async setModel(model: string): Promise<void> {
    this.opts = { ...this.opts, model };
    const setter = (
      this.stream?.query as { setModel?: (model?: string) => Promise<void> } | undefined
    )?.setModel;
    if (setter) await setter.call(this.stream?.query, model || undefined);
  }

  canStopRuntime(): boolean {
    if (this.turn && !this.turn.closing) return false;
    if (this.permissionResolvers.size > 0 || this.questionResolvers.size > 0) return false;
    const stream = this.stream;
    if (!stream || stream.closed) return true;
    for (const task of stream.backgroundTasks.values()) {
      if (task.status === "running") return false;
    }
    for (const sub of stream.subagents.values()) {
      if (!CHAT_SUBAGENT_DONE.has(sub.status)) return false;
    }
    if (stream.awaitingTaskNotifications.size > 0) return false;
    return true;
  }

  onUnexpectedExit(listener: (info: AgentUnexpectedExit) => void): () => void {
    this.unexpectedExitListeners.add(listener);
    return () => {
      this.unexpectedExitListeners.delete(listener);
    };
  }

  respondQuestion(requestId: string, answers: Record<string, string[]>): void {
    const pending = this.questionResolvers.get(requestId);
    if (!pending) throw new Error("This question is no longer pending");
    const parsed = ChatAnswersSchema.parse(answers);
    if (
      Object.keys(parsed).length !== pending.question.questions.length ||
      pending.question.questions.some(
        (question) => !parsed[question.id]?.some((answer) => answer.trim()),
      )
    )
      throw new Error("Answer every question before continuing");
    this.questionResolvers.delete(requestId);
    pending.resolve(parsed);
    this.push({ type: "request_resolved", data: { requestId } });
  }

  async *events(): AsyncIterable<AgentEvent> {
    while (true) {
      // biome-ignore lint/style/noNonNullAssertion: shift() safe inside while(length>0)
      while (this.eventQueue.length > 0) yield this.eventQueue.shift()!;
      if (this.done) break;
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
    // biome-ignore lint/style/noNonNullAssertion: shift() safe inside while(length>0)
    while (this.eventQueue.length > 0) yield this.eventQueue.shift()!;
  }

  alive(): boolean {
    if (this.reusable) return Boolean(this.stream && !this.stream.closed);
    return !this.done;
  }

  getRuntimeSessionId(): string | undefined {
    return this.runtimeSessionId;
  }

  async close(): Promise<void> {
    this.humanWaitCount = 0;
    const store = this.humanReceipts.size ? new HumanRequestStore(getSqlite()) : null;
    for (const receipts of this.humanReceipts.values())
      for (const receipt of receipts) {
        const request = store?.get(receipt.id);
        if (request?.status === "answered") store?.unavailable(request.id, request.version);
      }
    this.humanReceipts.clear();
    for (const pending of this.questionResolvers.values()) pending.resolve(null);
    this.questionResolvers.clear();
    for (const pending of this.permissionResolvers.values()) pending.resolve("denied");
    this.permissionResolvers.clear();
    await this.sendChain;
    const stream = this.stream;
    if (stream) {
      stream.intentionalClose = true;
      stream.controller.abort();
      stream.input.end();
      await stream.finished;
    }
    this.turn = null;
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }

  waitingForHuman(): boolean {
    return this.humanWaitCount > 0;
  }
}

async function sshPreflight(
  host: SshExecHost,
  env: Record<string, string> = {},
): Promise<{ ok: boolean; error?: string }> {
  try {
    const claudePath = await hostBinary(host, "claude");
    if (!claudePath) {
      return {
        ok: false,
        error: `claude CLI not found on ${host.alias} — install Claude Code there (npm i -g @anthropic-ai/claude-code)`,
      };
    }
    const environment = { ...process.env, ...env };
    if (
      environment.ANTHROPIC_API_KEY ||
      environment.ANTHROPIC_AUTH_TOKEN ||
      environment.ANTHROPIC_BASE_URL ||
      environment.CLAUDE_CODE_USE_BEDROCK === "1"
    )
      return { ok: true };
    if ((await hostClaudeLoggedIn(host, claudePath, false, env)) === false) {
      return {
        ok: false,
        error:
          `claude on ${host.alias} is not logged in and ANTHROPIC_API_KEY is unset — ` +
          `set ANTHROPIC_API_KEY in orc's environment (it is forwarded to ${host.alias}, never stored), ` +
          `or run "claude login" on ${host.alias}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function createClaudeSDKBackend(): AgentBackend {
  return {
    name: "claude",
    capabilities: CLAUDE_CAPABILITIES,
    profileCapabilities: { model: true, toolAllowlist: true },

    async preflight(opts = {}) {
      const host = sessionExecHost(opts);
      if (host.kind === "ssh") {
        return sshPreflight(host, opts.env);
      }
      try {
        await import("@anthropic-ai/claude-agent-sdk");
        if (opts.providerExecutable)
          resolveClaudeSdkLaunch(true, (name) =>
            name === "claude" ? Bun.which(opts.providerExecutable ?? "claude") : Bun.which(name),
          );
        else resolveClaudeSdkLaunch();
        // The SDK reuses the claude CLI's stored credentials, so the CLI has to
        // be there even though the agent itself runs in-process. An API key is
        // accepted as an alternative.
        const claudePath = opts.providerExecutable
          ? Bun.which(opts.providerExecutable)
          : localAgentBinary("claude");
        const environment = { ...process.env, ...opts.env };
        if (
          !claudePath &&
          !environment.ANTHROPIC_API_KEY &&
          !environment.ANTHROPIC_AUTH_TOKEN &&
          environment.CLAUDE_CODE_USE_BEDROCK !== "1" &&
          !environment.ANTHROPIC_BASE_URL
        ) {
          return {
            ok: false,
            error:
              "claude CLI not found on PATH and ANTHROPIC_API_KEY is unset — " +
              "install Claude Code (npm i -g @anthropic-ai/claude-code) or set the key",
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `Claude SDK not available: ${String(err)}` };
      }
    },

    async describe(): Promise<BackendDescription> {
      const host = resolveExecHost();
      if (host.kind === "ssh") {
        const remote = await hostBinary(host, "claude").catch(() => null);
        return {
          kind: "in-process",
          requires: `Claude Code on ${host.alias}, logged in there or ANTHROPIC_API_KEY set where orc runs`,
          target: remote ? `${host.alias}:${remote}` : null,
          source: remote ? "ssh" : null,
          version: null,
        };
      }
      const claudePath = localAgentBinary("claude");
      return {
        kind: "in-process",
        requires:
          Bun.embeddedFiles.length > 0
            ? "Claude Code installed on PATH + credentials (standalone SDK executable is external)"
            : "@anthropic-ai/claude-agent-sdk (bundled) + claude CLI credentials",
        target: claudePath ?? (process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : null),
        source: claudePath ? "path" : process.env.ANTHROPIC_API_KEY ? "env" : null,
        version: null,
      };
    },

    async startSession(opts) {
      return new ClaudeSDKSession(opts, sessionExecHost(opts));
    },

    async resumeSession(runtimeSessionId, opts) {
      return new ClaudeSDKSession({ ...opts, runtimeSessionId }, sessionExecHost(opts));
    },

    async forkSession(sourceRuntimeId, opts) {
      return new ClaudeSDKSession(
        { ...opts, forkSourceRuntimeId: sourceRuntimeId },
        sessionExecHost(opts),
      );
    },

    async stop() {},
  };
}

registerBackend("claude", createClaudeSDKBackend);
