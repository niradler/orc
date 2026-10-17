import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ExecHost,
  ensureSshMaster,
  hostBinary,
  hostExec,
  hostSpawn,
  resolveExecHost,
} from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { sessionExecHost } from "./execution-host.js";
import { endStdin, readLines, writeToStdin } from "./io.js";
import { buildOrcMcpServer } from "./orc-mcp.js";
import { registerBackend } from "./registry.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  BackendDescription,
  PermissionResult,
  SessionOpts,
} from "./types.js";

const GRACE_TIMEOUT_MS = 8_000;

export function resolveCodexLaunch(
  path: string,
  which: (name: string) => string | null = Bun.which,
): string[] {
  if (!/\.(cmd|bat)$/i.test(path)) return [path];
  const script = join(dirname(path), "node_modules", "@openai", "codex", "bin", "codex.js");
  const node = which("node");
  if (!existsSync(script) || !node)
    throw new Error(
      "Codex shell shim has no runnable codex.js/Node interpreter; install the native Codex executable on PATH",
    );
  return [node, script];
}

async function codexCommand(host: ExecHost): Promise<string[]> {
  const executable = await hostBinary(host, "codex");
  if (!executable) throw new Error("Codex CLI not found on PATH");
  return host.kind === "local" ? resolveCodexLaunch(executable) : [executable];
}

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
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "CODEX_HOME",
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (allowed.has(k) || k.startsWith("OPENAI_"))) {
      env[k] = v;
    }
  }
  return env;
}

type StreamState = { hasReceivedResult: boolean };

export class CodexSession implements AgentSession {
  readonly id = ulid();

  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private killProc: (() => void) | null = null;
  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private done = false;
  private readonly state: StreamState = {
    hasReceivedResult: false,
  };
  private runtimeSessionId: string | undefined;
  private stderrLines: string[] = [];
  private readonly cwd: string;
  private readonly host: ExecHost;
  private readonly opts: SessionOpts;
  private outputDrained: Promise<void> = Promise.resolve();
  private errorsDrained: Promise<void> = Promise.resolve();

  constructor(
    opts: SessionOpts,
    host: ExecHost = resolveExecHost(),
    private readonly launcher: (host: ExecHost) => Promise<string[]> = codexCommand,
  ) {
    this.cwd = opts.cwd;
    this.host = host;
    this.opts = opts;
    this.runtimeSessionId = opts.runtimeSessionId;
  }

  async start(opts: SessionOpts, prompt: string): Promise<void> {
    if (this.host.kind === "ssh") await ensureSshMaster(this.host);
    const mcp = buildOrcMcpServer(this.host);
    const env = buildCodexEnv();
    if (mcp.headers?.Authorization) env.ORC_CODEX_MCP_TOKEN = mcp.headers.Authorization.slice(7);
    const args = [...(await this.launcher(this.host)), "exec"];
    if (opts.runtimeSessionId) args.push("resume", opts.runtimeSessionId);
    args.push("--json", "--skip-git-repo-check", "-c", 'approval_policy="never"');
    args.push(
      "-c",
      `sandbox_mode=${JSON.stringify(opts.autoApprove ? "workspace-write" : "read-only")}`,
    );
    args.push("-c", `mcp_servers.orc.url=${JSON.stringify(mcp.url)}`);
    args.push("-c", "mcp_servers.orc.required=true");
    if (opts.autoApprove) {
      for (const tool of [
        "context",
        "memory_list",
        "memory_read",
        "memory_history",
        "wiki_search",
        "wiki_get",
        "wiki_index",
        "wiki_history",
        "skill_read",
        "skill_list",
        "kb_list",
        "kb_search",
        "kb_evidence",
        "kb_read",
        "kb_documents",
        "kb_maintenance",
        "kb_write",
        "search",
        "audit_list",
        "session_event",
        "session_log",
        "session_snapshot",
        "session_restore",
        "task_get",
        "task_list",
        "task_update",
        "memory_create",
        "memory_update",
        "wiki_write",
        "flow_report",
        "flow_status",
      ]) {
        args.push("-c", `mcp_servers.orc.tools.${tool}.approval_mode="approve"`);
      }
    }
    if (mcp.headers?.Authorization)
      args.push("-c", 'mcp_servers.orc.bearer_token_env_var="ORC_CODEX_MCP_TOKEN"');
    if (opts.model) args.push("--model", opts.model);
    args.push("-");

    const handle = await hostSpawn(this.host, args, {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    });
    this.proc = handle.proc;
    this.killProc = handle.kill;
    writeToStdin(this.proc.stdin, new TextEncoder().encode(prompt));
    endStdin(this.proc.stdin);

    if (this.proc.stdout) {
      this.outputDrained = readLines(this.proc.stdout, (line) => {
        try {
          this.handleLine(JSON.parse(line) as Record<string, unknown>);
        } catch {}
      });
    }

    if (this.proc.stderr) {
      this.errorsDrained = readLines(this.proc.stderr, (line) => {
        this.stderrLines.push(line);
        if (this.stderrLines.length > 100) this.stderrLines.shift();
      });
    }

    void this.watchExit();
  }

  private handleLine(msg: Record<string, unknown>): void {
    const type = String(msg.type ?? "");

    if (type === "thread.started") {
      this.runtimeSessionId = String(msg.thread_id);
      return;
    }
    if (type === "turn.failed" || type === "error") {
      const error = msg.error as { message?: string } | undefined;
      this.push({
        type: "error",
        data: error?.message ?? String(msg.message ?? "Codex turn failed"),
      });
      return;
    }
    if (type === "item.started" || type === "item.completed") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return;
      const id = String(item.id ?? ulid());
      if (item.type === "agent_message" && type === "item.completed") {
        this.push({ type: "text", data: String(item.text ?? "") });
      } else if (item.type === "command_execution" || item.type === "mcp_tool_call") {
        if (type === "item.started") {
          this.push({
            type: "tool_use",
            data: {
              id,
              name: String(item.tool ?? item.type),
              input: JSON.stringify(item.arguments ?? item.command),
            },
          });
        } else {
          this.push({
            type: "tool_result",
            data: {
              toolUseId: id,
              content: JSON.stringify(item.result ?? item.aggregated_output ?? item.error),
              isError:
                item.status === "failed" ||
                (typeof item.exit_code === "number" && item.exit_code !== 0),
            },
          });
        }
      }
      return;
    }
    if (type === "turn.completed") {
      this.state.hasReceivedResult = true;
      this.push({
        type: "result",
        data: { runtimeSessionId: this.runtimeSessionId, usage: msg.usage },
      });
      return;
    }
  }

  private async watchExit(): Promise<void> {
    if (!this.proc) return;
    const code = await this.proc.exited;
    await Promise.all([this.outputDrained, this.errorsDrained]);
    if (code !== 0 && !this.state.hasReceivedResult) {
      const stderr = this.stderrLines.join("\n").trim();
      this.push({
        type: "error",
        data: stderr || `codex exited with code ${code}`,
      });
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
    if (this.proc && this.proc.exitCode === null) throw new Error("Codex turn is still running");
    this.done = false;
    this.state.hasReceivedResult = false;
    this.eventQueue.length = 0;
    this.stderrLines = [];
    await this.start({ ...this.opts, runtimeSessionId: this.runtimeSessionId }, prompt);
  }

  respondPermission(_requestId: string, _result: PermissionResult): void {}

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
    const timer = setTimeout(() => this.killProc?.(), GRACE_TIMEOUT_MS);
    try {
      await this.proc.exited;
    } finally {
      clearTimeout(timer);
    }
    this.proc = null;
    this.killProc = null;
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }
}

function createCodexBackend(): AgentBackend {
  return {
    name: "codex-cli",
    profileCapabilities: { model: true, toolAllowlist: false },

    async preflight() {
      const host = resolveExecHost();
      try {
        if (await hostBinary(host, "codex")) {
          const launch = await codexCommand(host);
          const status = await hostExec(host, [...launch, "login", "status"], { timeoutMs: 15000 });
          return status.code === 0
            ? { ok: true }
            : {
                ok: false,
                error:
                  "Codex CLI is installed but not authenticated; run codex login or configure OPENAI_API_KEY",
              };
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        ok: false,
        error:
          host.kind === "ssh"
            ? `codex CLI not found on ${host.alias} (npm i -g @openai/codex there)`
            : "codex CLI not found on PATH (npm i -g @openai/codex)",
      };
    },

    async describe(): Promise<BackendDescription> {
      const host = resolveExecHost();
      const path = await hostBinary(host, "codex").catch(() => null);
      return {
        kind: "cli",
        requires: host.kind === "ssh" ? `the codex CLI on ${host.alias}` : "the codex CLI on PATH",
        target: path && host.kind === "ssh" ? `${host.alias}:${path}` : (path ?? null),
        source: path ? (host.kind === "ssh" ? "ssh" : "path") : null,
        version: null,
      };
    },

    async startSession(opts) {
      const session = new CodexSession(opts, sessionExecHost(opts));
      return session;
    },

    async resumeSession(runtimeSessionId, opts) {
      const session = new CodexSession({ ...opts, runtimeSessionId }, sessionExecHost(opts));
      return session;
    },

    async stop() {},
  };
}

registerBackend("codex-cli", createCodexBackend);

export async function startCodexSession(
  opts: SessionOpts,
  initialPrompt: string,
): Promise<CodexSession> {
  const session = new CodexSession(opts);
  await session.start(opts, initialPrompt);
  return session;
}
