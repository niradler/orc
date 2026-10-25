import { spawn } from "node:child_process";
import {
  HOOK_EVENTS,
  type Options,
  query,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { ChatAnswersSchema, type ChatQuestion, ChatQuestionSchema } from "@orc/core/chat";
import { ChatAgentOptionsSchema, type ClaudeChatOptions } from "@orc/core/chat-options";
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
import { RULE_EVENT_ADAPTERS } from "@orc/core/rule-events";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { resolveClaudeSdkLaunch } from "./claude-executable.js";
import { elicitationForm } from "./elicitation.js";
import { sessionExecHost } from "./execution-host.js";
import { buildOrcMcpServers, ORC_TOOL_PREFIX, ORC_TOOLS_RULE } from "./orc-mcp.js";
import { registerBackend } from "./registry.js";
import { createRulesHook, sessionStartRuleContext } from "./rules-hook.js";
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

const ORC_SYSTEM_CONTEXT = `\
You are running as an agent orchestrated by ORC — a human+AI orchestration hub.

ORC gives you persistent memory, task management with human-in-the-loop review, a job runner, \
and a knowledge base. You have access to ORC MCP tools to interact with all of these:

- **Tasks**: create, update, and move tasks through the review flow (todo → doing → review → done). \
  Always update task status as you work and when you finish.
- **Memories**: short project facts worth knowing next session (ports, conventions, gotchas, decisions). \
  \`context\` lists the top memories by priority; \`memory_list\` / \`memory_read\` find and read more, \
  and \`memory_create\` / \`memory_update\` record them. Procedures and long guidance belong in skills.
- **Jobs**: list and trigger scheduled or one-shot jobs via \`job_list\` / \`job_run\`.
- **Projects**: scope your work with \`project_list\`.
- **Skills**: call \`skill_list\` to discover available workflows, then \`skill_read <name>\` to load \
  the full instructions before starting complex tasks (task management, PR review, debugging, etc.).
- **Session**: record significant events with \`session_event\`; call \`session_log\` when you finish.

Call \`context({})\` at the start of every session for a compact overview of active tasks and key memories.

If ORC MCP tools are not available, fall back to the \`orc\` CLI: \
\`orc task list\`, \`orc task create\`, \`orc mem list\`,\`orc job run\`, etc. \
Run \`orc --help\` to discover available commands.`;

const SDK_ENV_PASSTHROUGH = /^CLAUDE_(CODE_ENTRYPOINT|AGENT_SDK_VERSION)$/;
const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, { at: number; loggedIn: boolean | null }>();

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
): Promise<boolean | null> {
  const key = `${host.alias}\0${claudePath}`;
  const cached = authCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) return cached.loggedIn;
  const result = await hostExec(host, [claudePath, "auth", "status"], {
    timeoutMs: 30_000,
  });
  let loggedIn: boolean | null = null;
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === "boolean") loggedIn = parsed.loggedIn;
  } catch {}
  authCache.set(key, { at: Date.now(), loggedIn });
  return loggedIn;
}

async function sshSdkLaunch(host: SshExecHost): Promise<Partial<Options>> {
  const claudePath = await hostBinary(host, "claude");
  if (!claudePath) throw new Error(`claude CLI not found on ${host.alias}`);
  const prepared = await prepareSshSpawn(host);
  return {
    pathToClaudeCodeExecutable: claudePath,
    spawnClaudeCodeProcess: (options: SpawnOptions): SpawnedProcess => {
      const inline = Object.entries(options.env)
        .filter(([key, value]) => value !== undefined && SDK_ENV_PASSTHROUGH.test(key))
        .map(([key, value]) => `${key}=${value}`);
      const command = [options.command, ...options.args];
      const [bin = "ssh", ...args] = prepared.argv(
        inline.length > 0 ? ["env", ...inline, ...command] : command,
        options.cwd,
      );
      const child = spawn(bin, args, {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.on("data", (chunk: Buffer) => {
        logger.debug("claude stderr (ssh)", {
          host: host.alias,
          data: chunk.toString(),
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

class ClaudeSDKSession implements AgentSession {
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
  private abortController: AbortController | null = null;
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
    question: ChatQuestion,
    signal: AbortSignal,
  ): Promise<Record<string, string[]> | null> {
    let cancel = () => {};
    try {
      return await new Promise<Record<string, string[]> | null>((resolve) => {
        const requestId = question.requestId;
        cancel = () => {
          this.questionResolvers.delete(requestId);
          this.push({ type: "request_resolved", data: { requestId } });
          resolve(null);
        };
        this.questionResolvers.set(requestId, { question, resolve });
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        else this.push({ type: "question_request", data: question });
      });
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  async send(prompt: string): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.done = false;
    this.eventQueue.length = 0;
    this.abortController = new AbortController();
    void this.driveQuery(prompt);
  }

  private async driveQuery(prompt: string): Promise<void> {
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
            (event) => this.push(event),
            (waiting) => {
              this.humanWaitCount = Math.max(0, this.humanWaitCount + (waiting ? 1 : -1));
            },
            (id, receipts) => {
              this.humanReceipts.set(id, receipts);
            },
          )
        : undefined;
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
        this.host.kind === "ssh" ? await sshSdkLaunch(this.host) : resolveClaudeSdkLaunch();
      const q = query({
        prompt,
        options: {
          ...sdkChatOverrides(options),
          ...launch,
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
                mcpServers: buildOrcMcpServers(this.host, this.opts.mcpAlwaysLoad),
                allowedTools: [...this.opts.toolAllowlist, ORC_TOOLS_RULE],
              }
            : this.opts.ruleGuard || this.opts.orcMcp
              ? { mcpServers: buildOrcMcpServers(this.host, this.opts.mcpAlwaysLoad) }
              : {}),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: [
              ORC_SYSTEM_CONTEXT,
              this.opts.systemPromptAppend,
              this.opts.ruleGuard?.context,
              startupContext,
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          ...(this.abortController ? { abortController: this.abortController } : {}),
          onElicitation: async (request, { signal }) => {
            const requestId = ulid();
            try {
              const form = elicitationForm(requestId, request);
              const result = await this.waitForQuestion(form.question, signal);
              return result
                ? { action: "accept", content: form.content(result) }
                : { action: "cancel" };
            } catch {
              this.push({
                type: "system_status",
                data: "MCP form declined: secret, URL authentication, or unsupported input requires the native client",
              });
              return { action: "cancel" };
            }
          },
          canUseTool: async (toolName, input, options) => {
            const signal =
              options?.signal ?? this.abortController?.signal ?? new AbortController().signal;
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
              const result = await this.waitForQuestion(question, signal);
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
            this.push({
              type: "permission_request",
              data: { requestId, tool: toolName, command, input, cwd: this.opts.cwd },
            });
            let cancel = () => {};
            let result: PermissionResult;
            try {
              result = await new Promise<PermissionResult>((resolve) => {
                cancel = () => {
                  this.permissionResolvers.delete(requestId);
                  this.push({ type: "request_resolved", data: { requestId } });
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
        },
      });

      for await (const msg of q) {
        if (msg.type === "system" && msg.subtype === "init") {
          this.runtimeSessionId = msg.session_id;
          continue;
        }

        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              this.push({ type: "text", data: block.text });
            } else if (block.type === "thinking" && "thinking" in block && block.thinking) {
              this.push({ type: "thinking", data: block.thinking as string });
            } else if (block.type === "tool_use") {
              this.push({
                type: "tool_use",
                data: {
                  id: block.id,
                  name: block.name,
                  input: JSON.stringify(block.input),
                },
              });
            }
          }
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
              this.push({
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
          if (msg.is_error) {
            const errors = "errors" in msg ? (msg.errors as string[]) : [];
            this.push({
              type: "error",
              data: errors.join("\n") || `Claude error: ${msg.subtype}`,
            });
          } else {
            this.push({
              type: "result",
              data: { runtimeSessionId: msg.session_id, usage: msg.usage },
            });
          }
          break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        logger.error("Claude SDK query error", { err });
        this.push({
          type: "error",
          data: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
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
    this.abortController?.abort();
    this.abortController = null;
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }

  waitingForHuman(): boolean {
    return this.humanWaitCount > 0;
  }
}

async function sshPreflight(host: SshExecHost): Promise<{ ok: boolean; error?: string }> {
  try {
    const claudePath = await hostBinary(host, "claude");
    if (!claudePath) {
      return {
        ok: false,
        error: `claude CLI not found on ${host.alias} — install Claude Code there (npm i -g @anthropic-ai/claude-code)`,
      };
    }
    if (process.env.ANTHROPIC_API_KEY) return { ok: true };
    if ((await hostClaudeLoggedIn(host, claudePath)) === false) {
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
    profileCapabilities: { model: true, toolAllowlist: true },

    async preflight(opts = {}) {
      const host = sessionExecHost(opts);
      if (host.kind === "ssh") return sshPreflight(host);
      try {
        await import("@anthropic-ai/claude-agent-sdk");
        resolveClaudeSdkLaunch();
        // The SDK reuses the claude CLI's stored credentials, so the CLI has to
        // be there even though the agent itself runs in-process. An API key is
        // accepted as an alternative.
        const claudePath = Bun.which("claude");
        if (!claudePath && !process.env.ANTHROPIC_API_KEY) {
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
      const claudePath = Bun.which("claude");
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
