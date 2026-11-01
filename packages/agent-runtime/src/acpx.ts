import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acpxPermissionArgs, ChatAgentOptionsSchema } from "@orc/core/chat-options";
import {
  type ExecHost,
  type HostProcess,
  hostBinary,
  hostExec,
  hostSpawn,
  resolveExecHost,
} from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { sessionExecHost } from "./execution-host.js";
import { readProcessOutput } from "./io.js";
import { type OrcMcpConfigFile, writeOrcMcpConfigFile } from "./orc-mcp.js";
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
    | Array<{ type?: string; text?: string; content?: { type?: string; text?: string } }>;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  _meta?: {
    claudeCode?: {
      toolName?: string;
      toolResponse?: { stdout?: string; stderr?: string };
    };
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

  if (sessionUpdate === "agent_message_chunk" || sessionUpdate === "agent_thought_chunk") {
    const content = update.content;
    const blocks = Array.isArray(content)
      ? content.map((block) => block?.content ?? block)
      : [content];
    const type =
      sessionUpdate === "agent_thought_chunk" || blocks[0]?.type === "thinking"
        ? "thinking"
        : "text";
    const text = blocks
      .filter(
        (block) =>
          (block?.type === "text" || block?.type === "thinking") && typeof block.text === "string",
      )
      .map((block) => block?.text ?? "")
      .join("");
    return text ? { type, data: text } : null;
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

  if (
    sessionUpdate === "tool_call_update" &&
    (update.status === "completed" || update.status === "failed")
  ) {
    const toolResponse = update._meta?.claudeCode?.toolResponse;
    const output = update.rawOutput ?? toolResponse?.stdout ?? "";
    const isError =
      update.status === "failed" || (toolResponse?.stderr ? toolResponse.stderr.length > 0 : false);
    return {
      type: "tool_result",
      data: {
        toolUseId: update.toolCallId ?? "",
        content: typeof output === "string" ? output : JSON.stringify(output),
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
  source: "config" | "path" | "bundled" | "ssh";
};

/**
 * Find acpx without requiring it on PATH.
 *
 * PATH alone was the old rule, which meant a global `orc` install could not use
 * the acpx it depends on: npm links a dependency's bin into the *package's*
 * node_modules/.bin, not the user's PATH. An explicit path wins, followed by the
 * version installed alongside ORC, then PATH for standalone installations.
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

  const bundled = resolveBundledAcpx();
  if (bundled) return { cmd: interpreterFor(bundled), path: bundled, source: "bundled" };

  const onPath = Bun.which("acpx");
  if (onPath) {
    const path = normalizePath(onPath);
    return { cmd: interpreterFor(path), path, source: "path" };
  }

  return null;
}

export async function resolveAcpx(host: ExecHost): Promise<AcpxResolution | null> {
  if (host.kind === "local") return resolveAcpxCli();
  const path = await hostBinary(host, "acpx");
  return path ? { cmd: [path], path, source: "ssh" } : null;
}

export function acpxMissingMessage(host: ExecHost): string {
  return host.kind === "ssh"
    ? `acpx CLI not found on ${host.alias}. Install it there with \`npm install -g acpx\`.`
    : ACPX_MISSING_MESSAGE;
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

export class AcpxSession implements AgentSession {
  readonly id: string;

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private killProc: (() => void) | null = null;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private done = false;
  private gotResult = false;
  private stderrBuf = "";
  private drainOutput: () => Promise<void> = async () => {};
  private readonly agent: string;
  private readonly sessionName: string;
  private readonly cwd: string;
  private readonly model: string | undefined;
  private readonly autoApprove: boolean;
  private readonly extraArgs: string[];
  /** Spawn-ready prefix: either [binary] or [interpreter, cli.js]. */
  private readonly acpxCmd: string[];
  private readonly host: ExecHost;
  private readonly opts: SessionOpts;
  private mcpConfig: OrcMcpConfigFile | null = null;

  constructor(opts: SessionOpts, acpxCmd: string[], host: ExecHost) {
    this.id = ulid();
    this.host = host;
    this.opts = opts;
    this.agent = opts.acpxAgent ?? "claude";
    this.sessionName = opts.runtimeSessionId ?? `orc-${this.id}`;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.autoApprove = opts.autoApprove ?? true;
    const options = opts.chatAgentOptions
      ? ChatAgentOptionsSchema.parse(opts.chatAgentOptions)
      : undefined;
    if (options && options.runtime !== "acpx")
      throw new Error("ACPX requires ACPX launch arguments");
    this.extraArgs = options?.runtime === "acpx" ? options.args : [];
    this.acpxCmd = acpxCmd;
  }

  async ensureSession(): Promise<void> {
    const mcpArgs = await this.prepareMcpConfig();
    try {
      const result = await hostExec(
        this.host,
        [
          ...this.acpxCmd,
          "--format",
          "json",
          ...this.extraArgs,
          ...mcpArgs,
          this.agent,
          "sessions",
          "ensure",
          "--name",
          this.sessionName,
          ...(this.opts.acpxNativeSessionId
            ? ["--resume-session", this.opts.acpxNativeSessionId]
            : []),
        ],
        { cwd: this.cwd, timeoutMs: 30_000 },
      );
      if (result.code !== 0)
        throw new Error(
          `ACPX could not prepare this conversation (exit ${result.code}). Check the selected agent and its authentication.`,
        );
      if (this.opts.acpxNativeSessionId) {
        let resolved: unknown;
        try {
          resolved = JSON.parse(result.stdout);
        } catch {
          throw new Error(
            "ACPX returned an invalid native session response. The original identity was preserved.",
          );
        }
        if (
          !resolved ||
          typeof resolved !== "object" ||
          !("acpxSessionId" in resolved) ||
          resolved.acpxSessionId !== this.opts.acpxNativeSessionId
        )
          throw new Error(
            "The agent did not resume the requested native session. Its original identity was preserved.",
          );
      }
    } finally {
      this.releaseMcpConfig();
    }
  }

  private releaseMcpConfig(): void {
    this.mcpConfig?.cleanup();
    this.mcpConfig = null;
  }

  private async prepareMcpConfig(): Promise<string[]> {
    this.releaseMcpConfig();
    if (!this.opts.orcMcp) return [];
    this.mcpConfig = await writeOrcMcpConfigFile(
      this.host,
      this.opts.orcMcpProject,
      this.opts.orcMcpMode,
      "acpx",
    );
    return ["--mcp-config", this.mcpConfig.path];
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

  private async watchExit(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    const drainOutput = this.drainOutput;
    const code = await proc.exited;
    // Decide only once both streams are read: stdout can close before the exit code and
    // the stderr that explains it arrive. A leftover child holding the pipes only delays it briefly.
    await drainOutput();
    logger.info("ACPX process exited", { agent: this.agent, code });
    // A follow-up send() may have replaced this process meanwhile; its turn is not ours to end.
    if (this.proc !== proc) return;
    this.releaseMcpConfig();
    if (this.done) return;
    if (code !== 0) {
      const detail = this.stderrBuf.trim();
      const msg = `acpx exited with code ${code}${detail ? `: ${detail}` : ""}`;
      logger.error(msg, { agent: this.agent, stderr: detail });
      this.push({ type: "error", data: msg });
    } else if (!this.gotResult) {
      logger.warn("ACPX exited without a result event — synthesising empty result", {
        agent: this.agent,
      });
      this.push({ type: "result", data: { runtimeSessionId: this.sessionName } });
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
      ...(this.model ? ["--model", this.model] : []),
      ...(this.autoApprove && !acpxPermissionArgs(this.extraArgs) ? ["--approve-all"] : []),
      ...this.extraArgs,
      ...(await this.prepareMcpConfig()),
      this.agent,
      "prompt",
      "-s",
      this.sessionName,
      prompt,
    ];

    logger.info("Spawning ACPX process", {
      agent: this.agent,
      cwd: this.cwd,
      argumentCount: args.length - 1,
    });

    let handle: HostProcess;
    try {
      handle = await hostSpawn(this.host, args, {
        cwd: this.cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
    } catch (error) {
      this.releaseMcpConfig();
      throw error;
    }
    this.proc = handle.proc;
    this.killProc = handle.kill;

    logger.info("ACPX process started", {
      agent: this.agent,
      pid: this.proc.pid,
    });

    this.drainOutput = readProcessOutput(this.proc, {
      stdout: (line) => this.handleLine(line),
      stderr: (line) => {
        logger.debug("ACPX stderr", { agent: this.agent, line });
        this.stderrBuf += `${line}\n`;
      },
      onError: (err, stream) => {
        logger.error(`Error reading ACPX ${stream}`, { err, agent: this.agent });
        if (stream === "stdout")
          this.push({ type: "error", data: `ACPX stream error: ${String(err)}` });
      },
    });

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

  getRuntimeSessionId(): string {
    return this.sessionName;
  }

  async close(): Promise<void> {
    if (!this.proc) {
      this.releaseMcpConfig();
      return;
    }
    this.killProc?.();
    await this.proc.exited;
    this.proc = null;
    this.releaseMcpConfig();
    this.killProc = null;
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }
}

async function acpxVersion(host: ExecHost, cmd: string[]): Promise<string | null> {
  try {
    const result = await hostExec(host, [...cmd, "--version"], {
      timeoutMs: 30_000,
    });
    if (result.code !== 0) return null;
    return result.stdout.trim().split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

function createAcpxBackend(agent?: "cursor"): AgentBackend {
  return {
    name: agent ?? "acpx",
    profileCapabilities: { model: true, toolAllowlist: false },

    async preflight(opts = {}) {
      const host = sessionExecHost(opts);
      if (agent && !(await hostBinary(host, "cursor-agent")))
        return {
          ok: false,
          error: "Cursor Agent CLI not found on the execution host. Install Cursor CLI there.",
        };
      let resolved: AcpxResolution | null;
      try {
        resolved = await resolveAcpx(host);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (!resolved) return { ok: false, error: acpxMissingMessage(host) };
      const version = await acpxVersion(host, resolved.cmd);
      if (!version) {
        return {
          ok: false,
          error: `Found acpx at ${resolved.path} but \`--version\` failed`,
        };
      }
      return { ok: true };
    },

    async describe(): Promise<BackendDescription> {
      const host = resolveExecHost();
      const resolved = await resolveAcpx(host).catch(() => null);
      return {
        kind: "cli",
        requires: agent
          ? "Cursor Agent CLI and acpx on the execution host"
          : host.kind === "ssh"
            ? `the acpx CLI on ${host.alias}`
            : "the acpx CLI (npm i -g acpx), or ORC_ACPX_PATH",
        target:
          resolved && host.kind === "ssh"
            ? `${host.alias}:${resolved.path}`
            : (resolved?.path ?? null),
        source: resolved?.source ?? null,
        version: resolved ? await acpxVersion(host, resolved.cmd) : null,
      };
    },

    async startSession(opts) {
      const host = sessionExecHost(opts);
      const resolved = await resolveAcpx(host);
      if (!resolved) throw new Error(acpxMissingMessage(host));
      const session = new AcpxSession(
        agent ? { ...opts, acpxAgent: agent } : opts,
        resolved.cmd,
        host,
      );
      await session.ensureSession();
      return session;
    },

    async resumeSession(runtimeSessionId, opts) {
      const host = sessionExecHost(opts);
      const resolved = await resolveAcpx(host);
      if (!resolved) throw new Error(acpxMissingMessage(host));
      const session = new AcpxSession(
        { ...opts, ...(agent ? { acpxAgent: agent } : {}), runtimeSessionId },
        resolved.cmd,
        host,
      );
      if (opts.acpxNativeSessionId) await session.ensureSession();
      return session;
    },

    async stop() {},
  };
}

registerBackend("acpx", createAcpxBackend);
registerBackend("cursor", () => createAcpxBackend("cursor"));
