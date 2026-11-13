import { spawn } from "node:child_process";
import {
  HOOK_EVENTS,
  type Options,
  type Query,
  query,
  type SDKControlInterruptResponse,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ChatAnswersSchema,
  type ChatQuestion,
  ChatQuestionSchema,
  ORC_TASK_GUIDANCE,
} from "@orc/core/chat";
import { ChatAgentOptionsSchema, type ClaudeChatOptions } from "@orc/core/chat-options";
import { localAgentBinary } from "@orc/core/config";
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
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { CLAUDE_CAPABILITIES } from "./capabilities.js";
import { resolveClaudeSdkLaunch } from "./claude-executable.js";
import { elicitationForm } from "./elicitation.js";
import { sessionExecHost } from "./execution-host.js";
import { buildOrcMcpServers, ORC_TOOL_PREFIX, ORC_TOOLS_RULE } from "./orc-mcp.js";
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

type ClaudeTurn = {
  readonly controller: AbortController;
  readonly input: TurnInput;
  query: Query | undefined;
  stopping: boolean;
  /** Final result emitted or interrupt decided; no further input is accepted. */
  closing: boolean;
  /**
   * Steers written to the CLI but not yet answered by a result. The CLI queues
   * mid-turn input and runs it as a continuation of the same query, so the
   * turn stays open until every delivered steer has had its run.
   */
  readonly pendingSteers: Set<string>;
  finished: Promise<void>;
};

class ClaudeSDKSession implements AgentSession {
  readonly capabilities = CLAUDE_CAPABILITIES;
  readonly id = ulid();

  private runtimeSessionId: string | undefined;
  private humanWaitCount = 0;
  private readonly humanReceipts = new Map<string, { id: string; version: number }[]>();
  private done = false;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private readonly permissionResolvers = new Map<
    string,
    { tool: string; resolve: (result: PermissionResult) => void }
  >();
  private liveMode: LivePermissionMode | undefined;
  private readonly questionResolvers = new Map<
    string,
    { question: ChatQuestion; resolve: (answers: Record<string, string[]> | null) => void }
  >();
  private turn: ClaudeTurn | null = null;
  private sendChain: Promise<void> = Promise.resolve();
  private readonly opts: SessionOpts;
  private readonly host: ExecHost;

  constructor(opts: SessionOpts, host: ExecHost) {
    this.opts = opts;
    this.host = host;
    this.runtimeSessionId = opts.runtimeSessionId;
  }

  private push(event: AgentEvent): void {
    this.eventQueue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private async waitForQuestion(
    turn: ClaudeTurn,
    question: ChatQuestion,
    signal: AbortSignal,
  ): Promise<Record<string, string[]> | null> {
    const push = (event: AgentEvent) => this.pushTurn(turn, event);
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
    // driveQuery, whose unwind then ended the second turn's events (R-15).
    const started = this.sendChain.then(() => this.startTurn(prompt));
    this.sendChain = started.catch(() => {});
    return started;
  }

  private async startTurn(prompt: string): Promise<void> {
    const previous = this.turn;
    if (previous) {
      // Detach before draining: the replaced turn's unwind must not end an
      // events() consumer that is about to read the replacement turn.
      this.turn = null;
      previous.controller.abort();
      previous.input.end();
      await previous.finished;
    }
    this.done = false;
    this.eventQueue.length = 0;
    const turn: ClaudeTurn = {
      controller: new AbortController(),
      input: new TurnInput(),
      query: undefined,
      stopping: false,
      closing: false,
      pendingSteers: new Set(),
      finished: Promise.resolve(),
    };
    this.turn = turn;
    // The initial prompt rides the same streaming input as steers; nobody
    // awaits its delivery ack, but a teardown rejection must not be unhandled.
    turn.input.push(userMessage(prompt, messageUuid())).catch(() => {});
    turn.finished = this.driveQuery(turn);
  }

  async steer(prompt: string): Promise<void> {
    const turn = this.turn;
    if (!turn || this.done || turn.stopping || turn.closing)
      throw new Error("No active Claude turn to steer.");
    if (!prompt.trim() || prompt.length > 100000)
      throw new Error("Enter a steering message up to 100000 characters.");
    const uuid = messageUuid();
    turn.pendingSteers.add(uuid);
    try {
      await turn.input.push(userMessage(prompt, uuid));
    } catch (error) {
      turn.pendingSteers.delete(uuid);
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn || this.done || turn.stopping) return;
    turn.stopping = true;
    // Release anything the CLI is blocked on so the turn can actually end.
    for (const [requestId, pending] of [...this.questionResolvers]) {
      this.questionResolvers.delete(requestId);
      pending.resolve(null);
      this.pushTurn(turn, { type: "request_resolved", data: { requestId } });
    }
    for (const [requestId, pending] of [...this.permissionResolvers]) {
      this.permissionResolvers.delete(requestId);
      pending.resolve("denied");
      this.pushTurn(turn, { type: "request_resolved", data: { requestId } });
    }
    if (turn.query) {
      // cancelQueued stops delivered-but-unrun steers from executing after the
      // interrupt; without it the CLI runs them after the stopped turn. The
      // installed SDK implements the option ahead of its .d.ts signature, and
      // older CLIs ignore it (interrupt_cancel_queued_v1) — the receipt's
      // still_queued then lists survivors that may yet run.
      const interrupt = turn.query.interrupt as (options?: {
        cancelQueued?: boolean;
      }) => Promise<SDKControlInterruptResponse | undefined>;
      const receipt = await interrupt({ cancelQueued: true });
      if (receipt?.still_queued.length) {
        logger.debug("Claude interrupt left queued commands", {
          count: receipt.still_queued.length,
        });
      }
    } else turn.controller.abort();
  }

  /** Events from an unwinding turn must never reach the next turn's queue. */
  private pushTurn(turn: ClaudeTurn, event: AgentEvent): void {
    if (this.turn === turn) this.push(event);
  }

  private async driveQuery(turn: ClaudeTurn): Promise<void> {
    const abortController = turn.controller;
    const push = (event: AgentEvent) => this.pushTurn(turn, event);
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
          : (options.permissionMode ??
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
      const startupContext = this.opts.ruleGuard
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
        prompt: turn.input,
        options: {
          ...sdkChatOverrides(options),
          ...launch,
          env: { ...process.env, ...this.opts.env },
          cwd: this.opts.cwd,
          ...(rulesHook
            ? {
                hooks: Object.fromEntries(
                  HOOK_EVENTS.filter(
                    (event) =>
                      event !== "SessionStart" &&
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
          settingSources:
            this.opts.toolAllowlist !== undefined || this.opts.ruleGuard ? [] : ["user", "project"],
          ...(this.opts.toolAllowlist !== undefined
            ? {
                tools: this.opts.toolAllowlist.filter((name) => !name.startsWith("mcp__")),
                mcpServers: buildOrcMcpServers(
                  this.host,
                  this.opts.mcpAlwaysLoad,
                  this.opts.orcMcpMode,
                  this.opts.orcMcpProject,
                  this.opts.orcPreviewSessionId ?? this.opts.attentionContext?.chatThreadId,
                ),
                allowedTools: [...this.opts.toolAllowlist, ORC_TOOLS_RULE],
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
              const result = await this.waitForQuestion(turn, form.question, signal);
              return result
                ? { action: "accept", content: form.content(result) }
                : { action: "cancel" };
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
            if (this.opts.toolAllowlist !== undefined && toolName.startsWith(ORC_TOOL_PREFIX)) {
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
            if (turn.stopping) return { behavior: "deny", message: "The turn was interrupted." };
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
              const result = await this.waitForQuestion(turn, question, signal);
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
              data: { requestId, tool: toolName, command, input, cwd: this.opts.cwd },
            });
            let cancel = () => {};
            let result: PermissionResult;
            try {
              result = await new Promise<PermissionResult>((resolve) => {
                cancel = () => {
                  if (this.permissionResolvers.delete(requestId))
                    push({ type: "request_resolved", data: { requestId } });
                  resolve("denied");
                };
                this.permissionResolvers.set(requestId, { tool: toolName, resolve });
                signal.addEventListener("abort", cancel, { once: true });
                if (signal.aborted) cancel();
              });
            } finally {
              signal.removeEventListener("abort", cancel);
            }
            if (result === "approved" || result === "session") {
              return { behavior: "allow", updatedInput: input };
            }
            return { behavior: "deny", message: "Permission denied" };
          },
          ...(this.runtimeSessionId ? { resume: this.runtimeSessionId } : {}),
          ...(this.opts.model ? { model: this.opts.model } : {}),
          includePartialMessages: true,
        },
      });
      nativeQuery = q;
      turn.query = q;

      // Each text block is its own paragraph; joined bare, text before and after a tool
      // call runs together and breaks markdown such as a code fence opening mid-line.
      let wroteText = false;
      let streamedText = false;
      let lastResult: SDKResultMessage | undefined;
      const emitResult = (msg: SDKResultMessage) => {
        if (turn.closing) return;
        turn.closing = true;
        clearContinuationGrace();
        if (msg.is_error && !turn.stopping) {
          const errors = "errors" in msg ? (msg.errors as string[]) : [];
          push({
            type: "error",
            data: errors.join("\n") || `Claude error: ${msg.subtype}`,
          });
        } else {
          push({
            type: "result",
            data: {
              runtimeSessionId: msg.session_id,
              usage: msg.usage,
              durationMs: msg.duration_ms,
              ...(turn.stopping ? { outcome: "stopped" as const } : {}),
            },
          });
        }
        // Streaming input keeps the subprocess alive waiting for more
        // messages; closing the channel lets the SDK end stdin and exit.
        turn.input.end();
      };
      // A steer the CLI never answers (lost/refused uuid) must not hold the
      // turn open forever: end with the last result after a quiet period.
      const armContinuationGrace = () => {
        clearContinuationGrace();
        continuationGrace = setTimeout(() => {
          if (!turn.closing && lastResult) {
            push({
              type: "system_status",
              data: "A steering message was not answered before the response ended.",
            });
            emitResult(lastResult);
          }
        }, steerContinuationGraceMs);
      };
      for await (const msg of q) {
        // After the final result, keep draining so the subprocess exits, but
        // ignore anything a surviving queued command may still emit.
        if (turn.closing) continue;
        clearContinuationGrace();
        if (msg.type === "stream_event") {
          const event = msg.event;
          if (event.type === "content_block_start" && event.content_block.type === "text") {
            if (wroteText) push({ type: "text", data: "\n\n" });
            wroteText = true;
            streamedText = true;
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            push({ type: "text", data: event.delta.text });
          continue;
        }
        if (msg.type === "rate_limit_event") {
          const event = claudeLimitEvent(msg.rate_limit_info);
          if (event) push(event);
          continue;
        }
        if (msg.type === "system" && msg.subtype === "init") {
          this.runtimeSessionId = msg.session_id;
          continue;
        }

        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          push({ type: "system_status", data: "Context compacted." });
          continue;
        }

        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              if (!streamedText)
                push({ type: "text", data: wroteText ? `\n\n${block.text}` : block.text });
              wroteText = true;
            } else if (block.type === "thinking" && "thinking" in block && block.thinking) {
              push({ type: "thinking", data: block.thinking as string });
            } else if (block.type === "tool_use") {
              push({
                type: "tool_use",
                data: {
                  id: block.id,
                  name: block.name,
                  input: JSON.stringify(block.input),
                },
              });
            }
          }
          if (!msg.parent_tool_use_id) streamedText = false;
          continue;
        }

        if (msg.type === "user" && Array.isArray(msg.message.content)) {
          for (const block of msg.message.content) {
            if (block.type === "tool_result") {
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

        // Keep reading after the result so the subprocess releases its working folder.
        if (msg.type === "result") {
          this.runtimeSessionId = msg.session_id;
          lastResult = msg;
          // A turn can answer several steers at once: coalesced sends share one
          // result whose user_message_uuid is only the last member's, so consume
          // every echoed uuid, not just the trigger.
          const answered =
            "user_message_uuids" in msg && Array.isArray(msg.user_message_uuids)
              ? msg.user_message_uuids
              : [];
          for (const id of answered) turn.pendingSteers.delete(id);
          const trigger = "user_message_uuid" in msg ? msg.user_message_uuid : undefined;
          if (typeof trigger === "string") turn.pendingSteers.delete(trigger);
          // A delivered steer may still be in flight to the CLI: results can
          // report queued_turn_count 0 and yet run the steer as a continuation
          // (verified live), so pending steers remain the primary wait signal.
          // queued_turn_count > 0 is an extra keep-waiting hint. Older CLIs
          // echo no uuids at all; without an echo, runs cannot be attributed,
          // so end the turn instead of paying the grace on every steer. The
          // grace timer backstops a uuid the CLI never answers.
          const queued = "queued_turn_count" in msg ? msg.queued_turn_count : undefined;
          const trackable = typeof trigger === "string" || answered.length > 0;
          const moreRuns =
            (typeof queued === "number" && queued > 0) ||
            (trackable && turn.pendingSteers.size > 0);
          if (!turn.stopping && moreRuns) {
            armContinuationGrace();
            continue;
          }
          emitResult(msg);
        }
      }
      // The stream can end without a final result: an interrupt may produce
      // none, or the CLI may exit while steers were still queued.
      if (!turn.closing) {
        if (turn.stopping) {
          turn.closing = true;
          push(stoppedResult(this.runtimeSessionId));
        } else if (lastResult) {
          emitResult(lastResult);
        }
      }
    } catch (err) {
      if (turn.stopping && !turn.closing) {
        turn.closing = true;
        push(stoppedResult(this.runtimeSessionId));
      } else if (
        turn.closing ||
        turn.controller.signal.aborted ||
        (err as Error).name === "AbortError"
      ) {
        // The SDK raises a plain Error ("Operation aborted") while the
        // subprocess releases stdin after the final result or an abort;
        // neither is a turn failure.
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
        push({
          type: "error",
          data: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      clearContinuationGrace();
      turn.input.end();
      try {
        await nativeQuery?.return();
      } catch (error) {
        logger.warn("Claude SDK cleanup failed", {
          message: this.opts.redactOutput?.(String(error)) ?? String(error),
        });
        push({ type: "error", data: "Claude connection could not be closed cleanly." });
      }
      // A stale turn unwinding after a replacement must not end the new
      // turn's events (R-15); only the current turn owns the done flag. The
      // finished turn stays attached: SDK callbacks still in flight (a pending
      // question or approval) push their resolution through the same guard.
      if (this.turn === turn) {
        this.done = true;
        this.resolveNext?.();
        this.resolveNext = null;
      }
    }
  }

  respondPermission(requestId: string, result: PermissionResult): void {
    const pending = this.permissionResolvers.get(requestId);
    if (!pending) throw new Error("This approval is no longer pending");
    this.permissionResolvers.delete(requestId);
    pending.resolve(result);
    this.push({ type: "request_resolved", data: { requestId } });
  }

  setPermissionMode(mode: LivePermissionMode): void {
    this.liveMode = mode;
    for (const [requestId, pending] of this.permissionResolvers)
      if (permissionModeAllows(mode, pending.tool)) this.respondPermission(requestId, "approved");
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
    const turn = this.turn;
    if (turn) {
      turn.controller.abort();
      turn.input.end();
      await turn.finished;
    }
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

    async stop() {},
  };
}

registerBackend("claude", createClaudeSDKBackend);
