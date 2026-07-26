import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { readLines } from "./io.js";
import { registerBackend } from "./registry.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  BackendDescription,
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

/**
 * How to invoke acpx, and where it came from.
 *
 * `cmd` is spawn-ready: acpx ships as a Node CLI (`bin: dist/cli.js`), so
 * depending on how it was installed the invocation is either the binary itself
 * or an interpreter plus that script.
 */
export type AcpxResolution = {
  cmd: string[];
  path: string;
  source: "config" | "path" | "bundled";
};

/**
 * Find acpx without requiring it on PATH.
 *
 * PATH alone was the old rule, which meant a global `orc` install could not use
 * the acpx it depends on: npm links a dependency's bin into the *package's*
 * node_modules/.bin, not the user's PATH. So: an explicit path wins, then PATH,
 * then the copy installed alongside orc.
 */
export function resolveAcpxCli(): AcpxResolution | null {
  // Only honour a configured path that is actually there: a stale ORC_ACPX_PATH
  // would otherwise shadow a perfectly good install and fail at spawn time,
  // where the error is a raw ENOENT rather than "acpx not found".
  const configured = process.env.ORC_ACPX_PATH?.trim();
  if (configured && existsSync(configured)) {
    const path = normalizePath(configured);
    return { cmd: interpreterFor(path), path, source: "config" };
  }

  const onPath = Bun.which("acpx");
  if (onPath) {
    const path = normalizePath(onPath);
    return { cmd: interpreterFor(path), path, source: "path" };
  }

  const bundled = resolveBundledAcpx();
  if (bundled) return { cmd: interpreterFor(bundled), path: bundled, source: "bundled" };

  return null;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * acpx installed as a dependency of orc. `import.meta.resolve` throws in a
 * compiled standalone binary (the module is not there) and when acpx is simply
 * not installed - both are ordinary "not found", not errors worth surfacing.
 */
function resolveBundledAcpx(): string | null {
  try {
    const manifestUrl = import.meta.resolve("acpx/package.json");
    const manifestPath = fileURLToPath(manifestUrl);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.acpx;
    if (!rel) return null;
    const cli = join(dirname(manifestPath), rel);
    return existsSync(cli) ? normalizePath(cli) : null;
  } catch {
    return null;
  }
}

/**
 * A `.js` entry point (or a Windows `.cmd` shim) cannot be spawned directly and
 * driven over stdio reliably, so run it through an interpreter. acpx asks for
 * Node >= 22.13, so prefer node and fall back to the bun we are already in.
 */
function interpreterFor(path: string): string[] {
  const lower = path.toLowerCase();

  if (lower.endsWith(".cmd") || lower.endsWith(".ps1")) {
    // npm's Windows shim wraps `node cli.js`; drive the script directly.
    const cliJs = join(dirname(path), "node_modules", "acpx", "dist", "cli.js");
    const runtime = Bun.which("node") ?? process.execPath;
    if (existsSync(cliJs)) return [runtime, normalizePath(cliJs)];
    return [path];
  }

  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return [Bun.which("node") ?? process.execPath, path];
  }

  return [path];
}

/** Message shown wherever acpx is needed and missing - it names the fix. */
export const ACPX_MISSING_MESSAGE =
  "acpx CLI not found. Install it with `npm install -g acpx`, or set ORC_ACPX_PATH " +
  "to its location. Agents that do not need acpx (the built-in `claude` backend) still work.";

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
  /** Spawn-ready prefix: either [binary] or [interpreter, cli.js]. */
  private readonly acpxCmd: string[];

  constructor(opts: SessionOpts, acpxCmd: string[]) {
    this.id = ulid();
    this.agent = opts.acpxAgent ?? "claude";
    this.sessionName = opts.runtimeSessionId ?? `orc-${this.id}`;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.autoApprove = opts.autoApprove ?? true;
    this.acpxCmd = acpxCmd;
  }

  async ensureSession(): Promise<void> {
    // No pre-creation needed - we use `exec` mode which handles session
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
      logger.warn("ACPX stdout closed without a result event — synthesising empty result", {
        agent: this.agent,
      });
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
    logger.info("ACPX process exited", { agent: this.agent, code });
    if (this.done) return;
    if (code !== 0) {
      const detail = this.stderrBuf.trim();
      const msg = `acpx exited with code ${code}${detail ? `: ${detail}` : ""}`;
      logger.error(msg, { agent: this.agent, stderr: detail });
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
      ...this.acpxCmd,
      "--format",
      "json",
      ...(this.autoApprove ? ["--approve-all"] : []),
      this.agent,
      "-s",
      this.sessionName,
      "prompt",
      prompt,
    ];

    logger.info("Spawning ACPX process", {
      agent: this.agent,
      cwd: this.cwd,
      cmd: `${args.slice(0, -1).join(" ")} <prompt>`,
    });

    this.proc = Bun.spawn({
      cmd: args,
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    logger.info("ACPX process started", { agent: this.agent, pid: this.proc.pid });

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
        logger.debug("ACPX stderr", { agent: this.agent, line });
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

async function acpxVersion(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn({ cmd: [...cmd, "--version"], stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (proc.exitCode !== 0) return null;
    return out.trim().split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

function createAcpxBackend(): AgentBackend {
  return {
    name: "acpx",

    async preflight() {
      const resolved = resolveAcpxCli();
      if (!resolved) return { ok: false, error: ACPX_MISSING_MESSAGE };
      const version = await acpxVersion(resolved.cmd);
      if (!version) {
        return { ok: false, error: `Found acpx at ${resolved.path} but \`--version\` failed` };
      }
      return { ok: true };
    },

    async describe(): Promise<BackendDescription> {
      const resolved = resolveAcpxCli();
      return {
        kind: "cli",
        requires: "the acpx CLI (npm i -g acpx), or ORC_ACPX_PATH",
        target: resolved?.path ?? null,
        source: resolved?.source ?? null,
        version: resolved ? await acpxVersion(resolved.cmd) : null,
      };
    },

    async startSession(opts) {
      const resolved = resolveAcpxCli();
      if (!resolved) throw new Error(ACPX_MISSING_MESSAGE);
      const session = new AcpxSession(opts, resolved.cmd);
      await session.ensureSession();
      return session;
    },

    async resumeSession(runtimeSessionId, opts) {
      const resolved = resolveAcpxCli();
      if (!resolved) throw new Error(ACPX_MISSING_MESSAGE);
      const session = new AcpxSession({ ...opts, runtimeSessionId }, resolved.cmd);
      return session;
    },

    async stop() {},
  };
}

registerBackend("acpx", createAcpxBackend);
