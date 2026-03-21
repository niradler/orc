import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { endStdin, readLines, writeToStdin } from "./io.js";
import { registerBackend } from "./registry.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  PermissionResult,
  SessionOpts,
} from "./types.js";

const _logger = createLogger("agent-runtime:codex");

const GRACE_TIMEOUT_MS = 8_000;

function buildCodexEnv(): Record<string, string> {
  const allowed = new Set([
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "HOME",
    "USER",
    "PATH",
    "SHELL",
    "TERM",
    "LANG",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (allowed.has(k) || k.startsWith("OPENAI_"))) {
      env[k] = v;
    }
  }
  return env;
}

type StreamState = { hasReceivedResult: boolean; lastAssistantText: string };

export class CodexSession implements AgentSession {
  readonly id = ulid();

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private done = false;
  private readonly state: StreamState = { hasReceivedResult: false, lastAssistantText: "" };
  private runtimeSessionId: string | undefined;
  private readonly permissionResolvers = new Map<string, (result: PermissionResult) => void>();
  private stderrLines: string[] = [];
  private readonly cwd: string;

  constructor(opts: SessionOpts) {
    this.cwd = opts.cwd;
    this.runtimeSessionId = opts.runtimeSessionId;
  }

  async start(opts: SessionOpts, prompt: string): Promise<void> {
    const args = ["codex", "exec", "--output-format", "stream-json"];
    if (opts.runtimeSessionId) args.push("--session", opts.runtimeSessionId);
    if (opts.model) args.push("--model", opts.model);
    args.push(prompt);

    this.proc = Bun.spawn({
      cmd: args,
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: buildCodexEnv(),
    });

    if (this.proc.stdout) {
      void readLines(this.proc.stdout, (line) => {
        try {
          this.handleLine(JSON.parse(line) as Record<string, unknown>);
        } catch {}
      }).then(() => {
        if (!this.state.hasReceivedResult) {
          this.done = true;
          this.resolveNext?.();
          this.resolveNext = null;
        }
      });
    }

    if (this.proc.stderr) {
      void readLines(this.proc.stderr, (line) => {
        this.stderrLines.push(line);
        if (this.stderrLines.length > 100) this.stderrLines.shift();
      });
    }

    void this.watchExit();
  }

  private handleLine(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");

    if (type === "assistant_message" || type === "message") {
      const content = msg.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? (content as Array<Record<string, unknown>>).map((c) => String(c.text ?? "")).join("")
            : "";
      if (text) {
        this.state.lastAssistantText = text;
        this.push({ type: "text", data: text });
      }
      return;
    }

    if (type === "tool_call" || type === "function_call") {
      const id = String(msg.id ?? ulid());
      this.push({
        type: "tool_use",
        data: {
          id,
          name: String(msg.name ?? ""),
          input: JSON.stringify(msg.arguments ?? msg.input ?? {}),
        },
      });
      return;
    }

    if (type === "tool_result" || type === "function_result") {
      this.push({
        type: "tool_result",
        data: {
          toolUseId: String(msg.tool_call_id ?? msg.id ?? ""),
          content: String(msg.output ?? msg.content ?? ""),
          isError: Boolean(msg.is_error ?? false),
        },
      });
      return;
    }

    if (type === "approval_request" || type === "permission_request") {
      const requestId = String(msg.id ?? ulid());
      const tool = String(msg.tool ?? msg.name ?? "");
      const command = JSON.stringify(msg.input ?? msg.command ?? {});
      const permPromise = new Promise<PermissionResult>((resolve) => {
        this.permissionResolvers.set(requestId, resolve);
      });
      this.push({ type: "permission_request", data: { requestId, tool, command } });
      void permPromise.then((result) => {
        if (result !== "denied") {
          const response = JSON.stringify({
            type: "approval_response",
            id: requestId,
            approved: true,
          });
          writeToStdin(this.proc?.stdin, new TextEncoder().encode(`${response}\n`));
        }
      });
      return;
    }

    if (type === "done" || type === "completed" || type === "session_end") {
      this.state.hasReceivedResult = true;
      if (msg.session_id) this.runtimeSessionId = String(msg.session_id);
      this.push({
        type: "result",
        data: { runtimeSessionId: this.runtimeSessionId, usage: msg.usage },
      });
      this.done = true;
      this.resolveNext?.();
      this.resolveNext = null;
    }
  }

  private async watchExit(): Promise<void> {
    if (!this.proc) return;
    const code = await this.proc.exited;
    if (this.state.hasReceivedResult || this.done) return;
    if (code !== 0) {
      const stderr = this.stderrLines.join("\n").trim();
      this.push({ type: "error", data: stderr || `codex exited with code ${code}` });
    }
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private push(event: AgentEvent): void {
    this.eventQueue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  async send(prompt: string): Promise<void> {
    if (!this.proc) {
      await this.start({ cwd: this.cwd, runtimeSessionId: this.runtimeSessionId }, prompt);
      return;
    }
    const msg = JSON.stringify({ type: "user_message", content: prompt });
    writeToStdin(this.proc?.stdin, new TextEncoder().encode(`${msg}\n`));
  }

  respondPermission(requestId: string, result: PermissionResult): void {
    const resolver = this.permissionResolvers.get(requestId);
    if (resolver) {
      this.permissionResolvers.delete(requestId);
      resolver(result);
    }
  }

  getRuntimeSessionId(): string | undefined {
    return this.runtimeSessionId;
  }

  async *events(): AsyncIterable<AgentEvent> {
    while (true) {
      // biome-ignore lint/style/noNonNullAssertion: array.shift() is safe inside while(length>0)
      while (this.eventQueue.length > 0) yield this.eventQueue.shift()!;
      if (this.done) break;
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
    // biome-ignore lint/style/noNonNullAssertion: array.shift() is safe inside while(length>0)
    while (this.eventQueue.length > 0) yield this.eventQueue.shift()!;
  }

  alive(): boolean {
    return this.proc?.exitCode === null;
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    endStdin(this.proc.stdin);
    const timer = setTimeout(() => this.proc?.kill(), GRACE_TIMEOUT_MS);
    try {
      await this.proc.exited;
    } finally {
      clearTimeout(timer);
    }
    this.proc = null;
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }
}

function createCodexBackend(): AgentBackend {
  return {
    name: "codex",

    async preflight() {
      const path = Bun.which("codex");
      if (!path) return { ok: false, error: "codex CLI not found on PATH" };
      return { ok: true };
    },

    async startSession(opts) {
      const session = new CodexSession(opts);
      return session;
    },

    async resumeSession(runtimeSessionId, opts) {
      const session = new CodexSession({ ...opts, runtimeSessionId });
      return session;
    },

    async stop() {},
  };
}

registerBackend("codex", createCodexBackend);

export async function startCodexSession(
  opts: SessionOpts,
  initialPrompt: string,
): Promise<CodexSession> {
  const session = new CodexSession(opts);
  await session.start(opts, initialPrompt);
  return session;
}
