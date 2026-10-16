import { spawn } from "node:child_process";
import {
  HOOK_EVENTS,
  type Options,
  query,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
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
import { resolveClaudeSdkLaunch } from "./claude-executable.js";
import { sessionExecHost } from "./execution-host.js";
import { buildOrcMcpServers, isImplicitOrcTool, withOrcAllowedTools } from "./orc-mcp.js";
import { registerBackend } from "./registry.js";
import { createRulesHook, sessionStartRuleContext } from "./rules-hook.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  BackendDescription,
  PermissionResult,
  SessionOpts,
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
  private done = false;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private readonly permissionResolvers = new Map<string, (result: PermissionResult) => void>();
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
      const permissionMode =
        this.opts.toolAllowlist !== undefined
          ? "default"
          : (this.opts.permissionMode ?? (this.opts.autoApprove ? "bypassPermissions" : "default"));
      logger.info("Starting Claude SDK query", {
        permissionMode,
        cwd: this.opts.cwd,
        resume: this.runtimeSessionId,
      });

      const rulesHook = this.opts.ruleGuard
        ? createRulesHook(this.opts.ruleGuard, this.opts.cwd, (event) => this.push(event))
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
          ...launch,
          cwd: this.opts.cwd,
          ...(rulesHook
            ? {
                hooks: Object.fromEntries(
                  HOOK_EVENTS.filter(
                    (event) =>
                      event !== "SessionStart" &&
                      RULE_EVENT_ADAPTERS.claude.some((entry) => entry.native === event),
                  ).map((event) => [event, [{ hooks: [rulesHook], timeout: 10 }]]),
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
                allowedTools: withOrcAllowedTools(this.opts.toolAllowlist),
              }
            : this.opts.ruleGuard
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
          canUseTool: async (toolName, input) => {
            if (this.opts.toolAllowlist !== undefined && isImplicitOrcTool(toolName)) {
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
            if (this.opts.toolAllowlist !== undefined && this.opts.autoApprove)
              return { behavior: "allow", updatedInput: input };
            const requestId = ulid();
            const command = JSON.stringify(input);
            logger.info("canUseTool called", { toolName, requestId });
            this.push({
              type: "permission_request",
              data: { requestId, tool: toolName, command },
            });
            const result = await new Promise<PermissionResult>((resolve) => {
              this.permissionResolvers.set(requestId, resolve);
            });
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
    const resolver = this.permissionResolvers.get(requestId);
    if (resolver) {
      this.permissionResolvers.delete(requestId);
      resolver(result);
    }
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

  async close(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
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

    async preflight() {
      const host = resolveExecHost();
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
