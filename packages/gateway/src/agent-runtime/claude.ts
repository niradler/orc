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

const logger = createLogger("agent-runtime:claude");

const GRACE_TIMEOUT_MS = 8_000;
const STDERR_RING = 200;

type ClaudeStdinMsg =
  | { type: "user"; message: { role: "user"; content: string } }
  | { type: "control_response"; id: string; result: "approve" | "deny" };

type ContentBlock = { type: string; text?: string | undefined; thinking?: string | undefined };

type ClaudeStdoutMsg = {
  type: string;
  subtype?: string | undefined;
  message?: { content?: ContentBlock[] | undefined } | undefined;
  content?: string | ContentBlock[] | undefined;
  result?: string | undefined;
  session_id?: string | undefined;
  tool_use_id?: string | undefined;
  tool_id?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  input?: unknown;
  is_error?: boolean | undefined;
  usage?: unknown;
};

type StreamState = {
  hasReceivedResult: boolean;
  hasStreamedText: boolean;
  lastAssistantText: string;
};

function buildClaudeEnv(): Record<string, string> {
  const allowed = new Set([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "HOME",
    "USER",
    "PATH",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (allowed.has(k) || k.startsWith("ANTHROPIC_"))) {
      env[k] = v;
    }
  }
  return env;
}

function findClaudeCli(): string | null {
  return Bun.which("claude") ?? null;
}

function isAuthError(text: string): boolean {
  return /auth|api.key|invalid.key|401|unauthorized/i.test(text);
}

function contentToText(content: ClaudeStdoutMsg["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((c) => c.text ?? c.thinking ?? "").join("");
}

class ClaudeSession implements AgentSession {
  readonly id = ulid();

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private done = false;
  private readonly state: StreamState = {
    hasReceivedResult: false,
    hasStreamedText: false,
    lastAssistantText: "",
  };
  private readonly permissionResolvers = new Map<string, (result: PermissionResult) => void>();
  private stderrRing: string[] = [];
  private cwd: string;
  private runtimeSessionId: string | undefined;
  private readonly claudePath: string;

  constructor(opts: SessionOpts, claudePath: string) {
    this.cwd = opts.cwd;
    this.runtimeSessionId = opts.runtimeSessionId;
    this.claudePath = claudePath;
  }

  private spawn(extraArgs: string[] = []): void {
    const args = [
      this.claudePath,
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio",
      "--no-color",
      ...extraArgs,
    ];

    this.proc = Bun.spawn({
      cmd: args,
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: buildClaudeEnv(),
    });

    if (this.proc.stdout) {
      void readLines(this.proc.stdout, (line) => {
        try {
          this.handleStdoutLine(JSON.parse(line) as ClaudeStdoutMsg);
        } catch {}
      }).then(() => this.handleEof());
    }

    if (this.proc.stderr) {
      void readLines(this.proc.stderr, (line) => {
        this.stderrRing.push(line);
        if (this.stderrRing.length > STDERR_RING) this.stderrRing.shift();
      });
    }

    void this.watchExit();
  }

  private push(event: AgentEvent): void {
    this.eventQueue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private handleEof(): void {
    if (!this.state.hasReceivedResult) {
      this.done = true;
      this.resolveNext?.();
      this.resolveNext = null;
    }
  }

  async start(opts: SessionOpts): Promise<void> {
    const extraArgs = opts.runtimeSessionId ? ["--resume", opts.runtimeSessionId] : [];
    this.spawn(extraArgs);
  }

  private handleStdoutLine(msg: ClaudeStdoutMsg): void {
    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          this.state.hasStreamedText = true;
          this.state.lastAssistantText = block.text;
          this.push({ type: "text", data: block.text });
        }
        if (block.type === "thinking" && block.thinking) {
          this.push({ type: "thinking", data: block.thinking });
        }
      }
      return;
    }

    if (msg.type === "tool_use") {
      const id = msg.id ?? ulid();
      this.push({
        type: "tool_use",
        data: { id, name: msg.name ?? "", input: JSON.stringify(msg.input ?? {}) },
      });
      return;
    }

    if (msg.type === "tool_result") {
      this.push({
        type: "tool_result",
        data: {
          toolUseId: msg.tool_use_id ?? msg.tool_id ?? "",
          content: contentToText(msg.content),
          isError: msg.is_error ?? false,
        },
      });
      return;
    }

    if (msg.type === "control_request" || msg.type === "permission_request") {
      const requestId = msg.id ?? ulid();
      const tool = msg.name ?? contentToText(msg.content);
      const command =
        typeof msg.input === "object" && msg.input !== null
          ? JSON.stringify(msg.input)
          : String(msg.input ?? "");
      const permPromise = new Promise<PermissionResult>((resolve) => {
        this.permissionResolvers.set(requestId, resolve);
      });
      this.push({ type: "permission_request", data: { requestId, tool, command } });
      void permPromise.then((result) => this.sendControlResponse(requestId, result));
      return;
    }

    if (msg.type === "result" || msg.subtype === "end_turn") {
      this.state.hasReceivedResult = true;
      if (msg.session_id) this.runtimeSessionId = msg.session_id;
      this.push({
        type: "result",
        data: { runtimeSessionId: this.runtimeSessionId, usage: msg.usage },
      });
      this.done = true;
      this.resolveNext?.();
      this.resolveNext = null;
      return;
    }
  }

  private async watchExit(): Promise<void> {
    if (!this.proc) return;
    const code = await this.proc.exited;
    if (this.state.hasReceivedResult || this.done) return;
    const stderr = this.stderrRing.join("\n");
    if (isAuthError(stderr)) {
      this.push({ type: "error", data: "Authentication failed — check ANTHROPIC_API_KEY" });
    } else if (code !== 0) {
      const msg = stderr.trim() || `claude exited with code ${code}`;
      this.push({ type: "error", data: msg });
    }
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private sendControlResponse(id: string, result: PermissionResult): void {
    const approve = result === "approved" || result === "session";
    const msg: ClaudeStdinMsg = {
      type: "control_response",
      id,
      result: approve ? "approve" : "deny",
    };
    writeToStdin(this.proc?.stdin, new TextEncoder().encode(`${JSON.stringify(msg)}\n`));
  }

  async send(prompt: string): Promise<void> {
    const msg: ClaudeStdinMsg = {
      type: "user",
      message: { role: "user", content: prompt },
    };
    writeToStdin(this.proc?.stdin, new TextEncoder().encode(`${JSON.stringify(msg)}\n`));
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
      while (this.eventQueue.length > 0) yield this.eventQueue.shift()!;
      if (this.done) break;
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
    while (this.eventQueue.length > 0) yield this.eventQueue.shift()!;
  }

  alive(): boolean {
    if (!this.proc) return false;
    return this.proc.exitCode === null;
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

function createClaudeBackend(): AgentBackend {
  return {
    name: "claude",

    async preflight() {
      const path = findClaudeCli();
      if (!path) return { ok: false, error: "claude CLI not found on PATH" };
      try {
        const proc = Bun.spawn({ cmd: [path, "--version"], stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        if (proc.exitCode !== 0) return { ok: false, error: "claude --version failed" };
        const match = /(\d+)\./.exec(out);
        const major = match ? Number(match[1]) : 0;
        if (major < 2)
          return { ok: false, error: `claude CLI too old (${out.trim()}), need >= 2.x` };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    async startSession(opts) {
      const path = findClaudeCli();
      if (!path) throw new Error("claude CLI not found on PATH");
      const session = new ClaudeSession(opts, path);
      await session.start(opts);
      return session;
    },

    async resumeSession(runtimeSessionId, opts) {
      const path = findClaudeCli();
      if (!path) throw new Error("claude CLI not found on PATH");
      const session = new ClaudeSession({ ...opts, runtimeSessionId }, path);
      await session.start({ ...opts, runtimeSessionId });
      return session;
    },

    async stop() {},
  };
}

registerBackend("claude", createClaudeBackend);
