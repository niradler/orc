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
  content?:
    | { type?: string; text?: string }
    | Array<{ type?: string; content?: { type?: string; text?: string } }>;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: string;
  _meta?: {
    claudeCode?: { toolName?: string; toolResponse?: { stdout?: string; stderr?: string } };
  };
};

export function parseAcpxLine(line: string): AgentEvent | null {
  let msg: AcpxJsonRpc;
  try {
    msg = JSON.parse(line) as AcpxJsonRpc;
  } catch {
    return null;
  }

  if (msg.error) {
    return { type: "error", data: msg.error.message ?? "ACPX error" };
  }

  if (msg.result && msg.id !== undefined) {
    if (msg.result.stopReason || msg.result.usage) {
      return { type: "result", data: { usage: msg.result.usage } };
    }
    return null;
  }

  if (msg.method !== "session/update" || !msg.params?.update) return null;

  const update = msg.params.update;
  const sessionUpdate = update.sessionUpdate;

  if (sessionUpdate === "agent_message_chunk") {
    const content = update.content;
    if (content && !Array.isArray(content)) {
      if (content.type === "text" && content.text) {
        return { type: "text", data: content.text };
      }
      if (content.type === "thinking" && content.text) {
        return { type: "thinking", data: content.text };
      }
    }
    return null;
  }

  if (sessionUpdate === "tool_call") {
    const toolName = update._meta?.claudeCode?.toolName ?? update.title ?? "";
    return {
      type: "tool_use",
      data: {
        id: update.toolCallId ?? ulid(),
        name: toolName,
        input:
          typeof update.rawInput === "string"
            ? update.rawInput
            : JSON.stringify(update.rawInput ?? {}),
      },
    };
  }

  if (sessionUpdate === "tool_call_update" && update.status === "completed") {
    const toolResponse = update._meta?.claudeCode?.toolResponse;
    const output = update.rawOutput ?? toolResponse?.stdout ?? "";
    const isError = toolResponse?.stderr ? toolResponse.stderr.length > 0 : false;
    return {
      type: "tool_result",
      data: {
        toolUseId: update.toolCallId ?? "",
        content: output,
        isError,
      },
    };
  }

  return null;
}

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
  private stderrBuf = "";
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
    const event = parseAcpxLine(line);
    if (!event) return;

    if (event.type === "result") {
      this.gotResult = true;
      this.push({
        type: "result",
        data: { runtimeSessionId: this.sessionName, ...event.data },
      });
      this.done = true;
      this.resolveNext?.();
      return;
    }

    this.push(event);
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
      const detail = this.stderrBuf.trim();
      const msg = `acpx exited with code ${code}${detail ? `: ${detail}` : ""}`;
      logger.error(msg, { agent: this.agent });
      this.push({ type: "error", data: msg });
    }
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }

  async send(prompt: string): Promise<void> {
    if (this.proc) {
      await this.close().catch((err) =>
        logger.warn("Failed to close previous ACPX process", { err }),
      );
    }

    this.done = false;
    this.gotResult = false;
    this.stderrBuf = "";
    this.eventQueue.length = 0;

    const args = [
      this.acpxPath,
      "--format",
      "json",
      ...(this.autoApprove ? ["--approve-all"] : []),
      this.agent,
      ...(this.model ? ["--model", this.model] : []),
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
      void readLines(this.proc.stdout, (line) => this.handleLine(line))
        .then(() => this.handleEof())
        .catch((err) => {
          logger.error("Error reading ACPX stdout", { err, agent: this.agent });
          this.push({ type: "error", data: `ACPX stream error: ${String(err)}` });
          this.handleEof();
        });
    }

    if (this.proc.stderr) {
      void readLines(this.proc.stderr, (line) => {
        this.stderrBuf += `${line}\n`;
      }).catch(() => {});
    }

    void this.watchExit();
  }

  respondPermission(_requestId: string, _result: PermissionResult): void {
    // Permissions handled at CLI level (--approve-all when autoApprove is enabled)
  }

  async *events(): AsyncIterable<AgentEvent> {
    while (true) {
      while (this.eventQueue.length > 0) yield this.eventQueue.shift() as AgentEvent;
      if (this.done) break;
      await new Promise<void>((resolve) => {
        this.resolveNext = resolve;
      });
    }
    while (this.eventQueue.length > 0) yield this.eventQueue.shift() as AgentEvent;
  }

  alive(): boolean {
    if (!this.proc) return false;
    return this.proc.exitCode === null;
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    this.proc.kill();
    await this.proc.exited;
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
