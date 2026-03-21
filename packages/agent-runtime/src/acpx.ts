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

type AcpxEvent = {
  eventVersion?: number;
  sessionId?: string;
  requestId?: string;
  seq?: number;
  stream?: string;
  type?: string;
  status?: string;
  title?: string;
  text?: string;
  data?: string;
  content?: string;
  id?: string;
  name?: string;
  input?: unknown;
  runtimeSessionId?: string;
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
    const args = [this.acpxPath, this.agent, "sessions", "ensure", "--name", this.sessionName];
    const proc = Bun.spawn({
      cmd: args,
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`acpx sessions ensure failed: ${stderr.trim()}`);
    }
  }

  private push(event: AgentEvent): void {
    this.eventQueue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private handleLine(line: string): void {
    let msg: AcpxEvent;
    try {
      msg = JSON.parse(line) as AcpxEvent;
    } catch {
      return;
    }

    const type = msg.type;

    if (type === "text") {
      const text = msg.text ?? msg.data ?? msg.content ?? "";
      if (text) this.push({ type: "text", data: text });
      return;
    }

    if (type === "thinking") {
      const text = msg.text ?? msg.data ?? msg.content ?? "";
      if (text) this.push({ type: "thinking", data: text });
      return;
    }

    if (type === "tool_call") {
      this.push({
        type: "tool_use",
        data: {
          id: msg.id ?? ulid(),
          name: msg.name ?? msg.title ?? "",
          input: typeof msg.input === "string" ? msg.input : JSON.stringify(msg.input ?? {}),
        },
      });
      return;
    }

    if (type === "error") {
      this.push({ type: "error", data: msg.data ?? msg.text ?? "unknown error" });
      return;
    }
  }

  private handleEof(): void {
    if (!this.done) {
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
    this.eventQueue.length = 0;

    const args = [
      this.acpxPath,
      "--format",
      "json",
      ...(this.autoApprove ? ["--approve-all"] : []),
      this.agent,
      "-s",
      this.sessionName,
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
