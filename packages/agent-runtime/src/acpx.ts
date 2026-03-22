import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { readLines } from "./io.js";
import { registerBackend } from "./registry.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  PermissionResult,
  SessionOpts,
} from "./types.js";

const logger = createLogger("agent-runtime:acpx");

const GRACE_TIMEOUT_MS = 8_000;

type AcpxJsonRpc = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  result?: {
    stopReason?: string;
    sessionId?: string;
    usage?: unknown;
  };
  error?: { message?: string };
  params?: {
    sessionId?: string;
    update?: AcpxUpdate;
  };
};

type AcpxUpdate = {
  sessionUpdate?: string;
  content?: { type?: string; text?: string } | Array<{ type?: string; content?: { type?: string; text?: string } }>;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: string;
  _meta?: { claudeCode?: { toolName?: string; toolResponse?: { stdout?: string; stderr?: string } } };
};

function findAcpxCli(): string | null {
  const found = Bun.which("acpx");
  if (!found) return null;
  return found.replaceAll("\\", "/");
}

class AcpxSession implements AgentSession {
  readonly id: string;

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private done = false;
  private gotResult = false;
  private readonly agent: string;
  private readonly sessionName: string;
  private readonly cwd: string;
  private readonly model: string | undefined;
  private readonly autoApprove: boolean;
  private readonly acpxPath: string;

  constructor(opts: SessionOpts, acpxPath: string) {
    this.id = ulid();
    this.agent = opts.acpxAgent ?? "claude";
    this.sessionName = opts.runtimeSessionId ?? `orc-${this.id}`;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.autoApprove = opts.autoApprove ?? true;
    this.acpxPath = acpxPath;
  }

  async ensureSession(): Promise<void> {
    // No pre-creation needed — we use `exec` mode which handles session
    // lifecycle internally per invocation.
  }

  private push(event: AgentEvent): void {
    this.eventQueue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private handleLine(line: string): void {
    let msg: AcpxJsonRpc;
    try {
      msg = JSON.parse(line) as AcpxJsonRpc;
    } catch {
      return;
    }

    if (msg.error) {
      this.push({ type: "error", data: msg.error.message ?? "ACPX error" });
      return;
    }

    if (msg.result && msg.id !== undefined) {
      if (msg.result.stopReason || msg.result.usage) {
        this.gotResult = true;
        this.push({
          type: "result",
          data: { runtimeSessionId: this.sessionName, usage: msg.result.usage },
        });
        this.done = true;
        this.resolveNext?.();
      }
      return;
    }

    if (msg.method !== "session/update" || !msg.params?.update) return;

    const update = msg.params.update;
    const sessionUpdate = update.sessionUpdate;

    if (sessionUpdate === "agent_message_chunk") {
      const content = update.content;
      if (content && !Array.isArray(content)) {
        if (content.type === "text" && content.text) {
          this.push({ type: "text", data: content.text });
        } else if (content.type === "thinking" && content.text) {
          this.push({ type: "thinking", data: content.text });
        }
      }
      return;
    }

    if (sessionUpdate === "tool_call") {
      const toolName = update._meta?.claudeCode?.toolName ?? update.title ?? "";
      this.push({
        type: "tool_use",
        data: {
          id: update.toolCallId ?? ulid(),
          name: toolName,
          input: typeof update.rawInput === "string" ? update.rawInput : JSON.stringify(update.rawInput ?? {}),
        },
      });
      return;
    }

    if (sessionUpdate === "tool_call_update" && update.status === "completed") {
      const toolResponse = update._meta?.claudeCode?.toolResponse;
      const output = update.rawOutput ?? toolResponse?.stdout ?? "";
      const isError = toolResponse?.stderr ? toolResponse.stderr.length > 0 : false;
      this.push({
        type: "tool_result",
        data: {
          toolUseId: update.toolCallId ?? "",
          content: output,
          isError,
        },
      });
      return;
    }
  }

  private handleEof(): void {
    if (!this.gotResult && !this.done) {
      this.push({
        type: "result",
        data: { runtimeSessionId: this.sessionName },
      });
    }
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private async watchExit(): Promise<void> {
    if (!this.proc) return;
    const code = await this.proc.exited;
    if (this.done) return;
    if (code !== 0) {
      this.push({ type: "error", data: `acpx exited with code ${code}` });
    }
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }

  async send(prompt: string): Promise<void> {
    if (this.proc) {
      await this.close().catch(() => {});
    }

    this.done = false;
    this.gotResult = false;
    this.eventQueue.length = 0;

    const args = [
      this.acpxPath,
      "--format",
      "json",
      ...(this.autoApprove ? ["--approve-all"] : []),
      this.agent,
      "exec",
      prompt,
    ];

    this.proc = Bun.spawn({
      cmd: args,
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    if (this.proc.stdout) {
      void readLines(this.proc.stdout, (line) => this.handleLine(line)).then(() =>
        this.handleEof(),
      );
    }

    void this.watchExit();
  }

  respondPermission(_requestId: string, _result: PermissionResult): void {
    // ACPX handles permissions internally via --approve-all
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
    const timer = setTimeout(() => this.proc?.kill(), GRACE_TIMEOUT_MS);
    try {
      this.proc.kill();
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

function createAcpxBackend(): AgentBackend {
  return {
    name: "acpx",

    async preflight() {
      const path = findAcpxCli();
      if (!path) return { ok: false, error: "acpx CLI not found on PATH" };
      try {
        const proc = Bun.spawn({ cmd: [path, "--version"], stdout: "pipe", stderr: "pipe" });
        await proc.exited;
        if (proc.exitCode !== 0) return { ok: false, error: "acpx --version failed" };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },

    async startSession(opts) {
      const path = findAcpxCli();
      if (!path) throw new Error("acpx CLI not found on PATH");
      const session = new AcpxSession(opts, path);
      await session.ensureSession();
      return session;
    },

    async resumeSession(runtimeSessionId, opts) {
      const path = findAcpxCli();
      if (!path) throw new Error("acpx CLI not found on PATH");
      const session = new AcpxSession({ ...opts, runtimeSessionId }, path);
      return session;
    },

    async stop() {},
  };
}

registerBackend("acpx", createAcpxBackend);
