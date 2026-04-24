import { query } from "@anthropic-ai/claude-agent-sdk";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { registerBackend } from "./registry.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
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
- **Memories / KB**: search and store facts, decisions, and discoveries so they persist across sessions. \
  Call \`memory_search\` before starting work on anything non-trivial.
- **Jobs**: list and trigger scheduled or one-shot jobs via \`job_list\` / \`job_run\`.
- **Projects**: scope your work with \`project_list\`.
- **Skills**: call \`skill_list\` to discover available workflows, then \`skill_read <name>\` to load \
  the full instructions before starting complex tasks (task management, PR review, debugging, etc.).
- **Session**: record significant events with \`session_event\`; call \`session_log\` when you finish.

Call \`context({})\` at the start of every session for a compact overview of active tasks and key memories.

If ORC MCP tools are not available, fall back to the \`orc\` CLI: \
\`orc task list\`, \`orc task create\`, \`orc mem search\`, \`orc job run\`, etc. \
Run \`orc --help\` to discover available commands.`;

class ClaudeSDKSession implements AgentSession {
  readonly id = ulid();

  private runtimeSessionId: string | undefined;
  private done = false;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private readonly permissionResolvers = new Map<string, (result: PermissionResult) => void>();
  private abortController: AbortController | null = null;
  private readonly opts: SessionOpts;

  constructor(opts: SessionOpts) {
    this.opts = opts;
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
        this.opts.permissionMode ?? (this.opts.autoApprove ? "bypassPermissions" : "default");
      logger.info("Starting Claude SDK query", {
        permissionMode,
        cwd: this.opts.cwd,
        resume: this.runtimeSessionId,
      });

      const q = query({
        prompt,
        options: {
          cwd: this.opts.cwd,
          permissionMode,
          settingSources: ["user", "project"],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: [ORC_SYSTEM_CONTEXT, this.opts.systemPromptAppend].filter(Boolean).join("\n\n"),
          },
          ...(this.abortController ? { abortController: this.abortController } : {}),
          canUseTool: async (toolName, input) => {
            const requestId = ulid();
            const command = JSON.stringify(input);
            logger.info("canUseTool called", { toolName, requestId });
            this.push({ type: "permission_request", data: { requestId, tool: toolName, command } });
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
                data: { id: block.id, name: block.name, input: JSON.stringify(block.input) },
              });
            }
          }
          continue;
        }

        if (msg.type === "result") {
          this.runtimeSessionId = msg.session_id;
          if (msg.is_error) {
            const errors = "errors" in msg ? (msg.errors as string[]) : [];
            this.push({ type: "error", data: errors.join("\n") || `Claude error: ${msg.subtype}` });
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
        this.push({ type: "error", data: String(err) });
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

function createClaudeSDKBackend(): AgentBackend {
  return {
    name: "claude",

    async preflight() {
      try {
        await import("@anthropic-ai/claude-agent-sdk");
        // SDK uses the claude CLI's stored credentials — no ANTHROPIC_API_KEY needed
        const claudePath = Bun.which("claude");
        if (!claudePath) return { ok: false, error: "claude CLI not found on PATH" };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `Claude SDK not available: ${String(err)}` };
      }
    },

    async startSession(opts) {
      return new ClaudeSDKSession(opts);
    },

    async resumeSession(runtimeSessionId, opts) {
      return new ClaudeSDKSession({ ...opts, runtimeSessionId });
    },

    async stop() {},
  };
}

registerBackend("claude", createClaudeSDKBackend);
