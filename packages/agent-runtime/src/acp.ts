import {
  type ClientConnection,
  client,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { loadConfig } from "@orc/core/config";
import { type HostProcess, hostBinary, hostSpawn } from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import type { AgentCapabilities } from "@orc/core/types";
import { createAcpxParser } from "./acpx.js";
import { ACP_CAPABILITIES, OPENCODE_CAPABILITIES } from "./capabilities.js";
import { sessionExecHost } from "./execution-host.js";
import { endStdin, writeToStdin } from "./io.js";
import { buildOrcMcpServer } from "./orc-mcp.js";
import { registerBackend } from "./registry.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  ImageAttachment,
  PermissionResult,
  SessionOpts,
} from "./types.js";

/** Bound frames before JSON decoding, including a peer that never sends a newline. */
function boundedOutput(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let bytes = 0;
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          bytes = byte === 10 ? 0 : bytes + 1;
          if (bytes > 2_000_000) throw new Error("ACP protocol message exceeded the output limit.");
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export class AcpSession implements AgentSession {
  readonly id = ulid();
  capabilities: AgentCapabilities = { ...ACP_CAPABILITIES };
  private connection: ClientConnection | undefined;
  private child: HostProcess | undefined;
  private runtimeId: string | undefined;
  private closed = false;
  private done = true;
  private busy = false;
  private cancelling = false;
  private replaying = false;
  private failure: string | undefined;
  private outputBytes = 0;
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private parse = createAcpxParser();
  private readonly pending = new Map<
    string,
    { params: RequestPermissionRequest; resolve: (value: RequestPermissionResponse) => void }
  >();

  constructor(
    private readonly opts: SessionOpts,
    private readonly command: readonly string[],
    initial: AgentCapabilities = ACP_CAPABILITIES,
  ) {
    this.capabilities = { ...initial };
    this.runtimeId = opts.runtimeSessionId;
  }

  private push(event: AgentEvent): void {
    if (this.closed) return;
    this.outputBytes += JSON.stringify(event).length;
    if (this.outputBytes > 2_000_000) {
      this.fail("ACP response exceeded the output limit.");
      return;
    }
    this.queue.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  private fail(message: string): void {
    if (this.failure || this.closed) return;
    this.failure = message;
    this.queue.push({ type: "error", data: message });
    this.done = true;
    this.cancelPermissions();
    this.wake?.();
    this.connection?.close();
    this.child?.kill();
  }

  private cancelPermissions(): void {
    for (const pending of [...this.pending.values()])
      pending.resolve({ outcome: { outcome: "cancelled" } });
    this.pending.clear();
  }

  private async request<T>(operation: Promise<T>, method: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`ACP ${method} timed out.`)), 30000);
        }),
      ]);
    } catch {
      throw new Error(
        `ACP ${method} failed. Check the agent's login, protocol support and configuration.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private permission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (
      this.replaying ||
      this.closed ||
      this.failure ||
      !this.busy ||
      this.done ||
      this.cancelling ||
      params.sessionId !== this.runtimeId ||
      signal.aborted
    )
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    // Never turn an ORC session grant into the agent's persistent "allow_always" policy.
    const once = params.options.find((option) => option.kind === "allow_once");
    if (this.opts.autoApprove && once)
      return Promise.resolve({ outcome: { outcome: "selected", optionId: once.optionId } });
    const id = ulid();
    return new Promise<RequestPermissionResponse>((resolve) => {
      const finish = (value: RequestPermissionResponse) => {
        signal.removeEventListener("abort", abort);
        if (this.pending.delete(id))
          this.push({ type: "request_resolved", data: { requestId: id } });
        resolve(value);
      };
      const abort = () => finish({ outcome: { outcome: "cancelled" } });
      this.pending.set(id, { params, resolve: finish });
      signal.addEventListener("abort", abort, { once: true });
      this.push({
        type: "permission_request",
        data: {
          requestId: id,
          tool: params.toolCall.kind ?? "tool",
          command: params.toolCall.title ?? "Agent action",
          input: { toolCall: params.toolCall },
          cwd: this.opts.cwd,
        },
      });
    });
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error("ACP connection is closed.");
    try {
      this.child = await hostSpawn(sessionExecHost(this.opts), this.command, {
        cwd: this.opts.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, ...this.opts.env },
        passEnv: Object.keys(this.opts.env ?? {}),
      });
      const child = this.child;
      if (!child.proc.stdout || typeof child.proc.stdout === "number")
        throw new Error("ACP agent has no protocol output.");
      const output = new WritableStream<Uint8Array>({
        write: (data) => {
          writeToStdin(child.proc.stdin, data);
        },
        close: () => endStdin(child.proc.stdin),
      });
      this.connection = client({ name: "orc" })
        .onRequest("session/request_permission", ({ params, signal }) =>
          this.permission(params, signal),
        )
        .onNotification("session/update", ({ params }) => {
          if (this.replaying || this.closed || params.sessionId !== this.runtimeId || this.done)
            return;
          const events = this.parse(JSON.stringify({ method: "session/update", params }));
          for (const event of events) this.push(event);
          if (params.update.sessionUpdate === "plan")
            this.push({
              type: "system_status",
              data: params.update.entries
                .map((entry) => `${entry.status}: ${entry.content}`)
                .join("\n"),
            });
          else if (
            (params.update.sessionUpdate === "agent_message_chunk" ||
              params.update.sessionUpdate === "agent_thought_chunk") &&
            params.update.content.type !== "text"
          )
            this.push({
              type: "system_status",
              data: `Agent returned ${params.update.content.type} content; view it in the native agent.`,
            });
        })
        .connect(ndJsonStream(output, boundedOutput(child.proc.stdout)));
      void this.connection.closed.then(() => {
        if (!this.closed)
          this.fail("ACP connection closed. Resume this conversation after checking the agent.");
      });
      void child.proc.exited.then(() => {
        if (!this.closed)
          this.fail("ACP agent exited. Resume this conversation after checking the agent.");
      });
      const agent = this.connection.agent;
      const initialized = await this.request(
        agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "orc", version: "1" },
          clientCapabilities: {},
        }),
        "initialize",
      );
      if (initialized.protocolVersion !== PROTOCOL_VERSION)
        throw new Error("Unsupported ACP protocol version.");
      const native = initialized.agentCapabilities;
      this.capabilities = {
        ...this.capabilities,
        source: "negotiated",
        resume: native?.loadSession === true,
        images: native?.promptCapabilities?.image === true,
        mcp: native?.mcpCapabilities?.http === true,
      };
      const server = this.opts.orcMcp
        ? buildOrcMcpServer(
            sessionExecHost(this.opts),
            false,
            this.opts.orcMcpMode,
            this.opts.orcMcpProject,
            this.opts.orcPreviewSessionId ?? this.opts.attentionContext?.chatThreadId,
          )
        : null;
      if (server && !this.capabilities.mcp)
        throw new Error(
          "This ACP agent cannot connect to ORC over HTTP MCP. Disable ORC tools for this conversation or use ACPX.",
        );
      const mcpServers = server
        ? [
            {
              name: "orc",
              type: "http" as const,
              url: server.url,
              headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({
                name,
                value,
              })),
            },
          ]
        : [];
      const common = { cwd: this.opts.cwd, mcpServers };
      let configOptions: SessionConfigOption[] = [];
      this.replaying = true;
      try {
        if (this.runtimeId) {
          if (!this.capabilities.resume)
            throw new Error(
              "This ACP agent cannot resume saved sessions; the original identity was preserved.",
            );
          const loaded = await this.request(
            agent.request<LoadSessionResponse>("session/load", {
              ...common,
              sessionId: this.runtimeId,
            }),
            "session/load",
          );
          configOptions = loaded?.configOptions ?? [];
        } else {
          const created = await this.request(
            agent.request<NewSessionResponse, NewSessionRequest>("session/new", common),
            "session/new",
          );
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(created.sessionId))
            throw new Error("ACP returned an invalid session identity.");
          this.runtimeId = created.sessionId;
          configOptions = created.configOptions ?? [];
        }
      } finally {
        this.replaying = false;
      }
      const model = configOptions.find(
        (option) => option.category === "model" && option.type === "select",
      );
      this.capabilities.modelSelection = !!model;
      if (this.opts.model) {
        if (!model)
          throw new Error(
            "This ACP agent does not expose model selection. Clear the explicit model or use ACPX.",
          );
        await this.request(
          agent.request("session/set_config_option", {
            sessionId: this.runtimeId,
            configId: model.id,
            value: this.opts.model,
          }),
          "session/set_config_option",
        );
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async send(prompt: string, images?: ImageAttachment[]): Promise<void> {
    if (this.closed || this.failure || !this.connection || !this.runtimeId)
      throw new Error("ACP connection is unavailable.");
    if (this.busy) throw new Error("ACP turn is still running.");
    if (images?.length && !this.capabilities.images)
      throw new Error("This ACP agent does not accept images.");
    this.busy = true;
    this.cancelling = false;
    this.done = false;
    this.queue.length = 0;
    this.outputBytes = 0;
    this.parse = createAcpxParser();
    this.push({ type: "capabilities", data: this.capabilities });
    const text = [this.opts.systemPromptAppend, prompt].filter(Boolean).join("\n\n");
    void this.connection.agent
      .request<PromptResponse, PromptRequest>("session/prompt", {
        sessionId: this.runtimeId,
        prompt: [
          { type: "text", text },
          ...(images ?? []).map((image) => ({
            type: "image" as const,
            mimeType: image.mimeType,
            data: Buffer.from(image.data).toString("base64"),
          })),
        ],
      })
      .then((result) => {
        if (this.closed || this.failure) return;
        if (result.stopReason === "cancelled")
          this.push({ type: "system_status", data: "ACP turn stopped." });
        else if (result.stopReason !== "end_turn")
          this.push({ type: "error", data: `ACP turn ended: ${result.stopReason}` });
        this.push({
          type: "result",
          data: { runtimeSessionId: this.runtimeId, usage: result.usage },
        });
      })
      .catch(() =>
        this.fail("ACP prompt failed. Check the agent's login and session availability."),
      )
      .finally(() => {
        this.done = true;
        this.busy = false;
        this.cancelPermissions();
        this.wake?.();
      });
  }

  respondPermission(id: string, result: PermissionResult): void {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("This approval is no longer pending.");
    const kind = result === "denied" ? "reject_once" : "allow_once";
    const option = pending.params.options.find((option) => option.kind === kind);
    pending.resolve({
      outcome: option
        ? { outcome: "selected", optionId: option.optionId }
        : { outcome: "cancelled" },
    });
  }
  waitingForHuman(): boolean {
    return this.pending.size > 0;
  }
  getRuntimeSessionId(): string | undefined {
    return this.runtimeId;
  }
  alive(): boolean {
    return !this.closed && !this.failure && this.child?.proc.exitCode === null;
  }
  async interrupt(): Promise<void> {
    if (!this.busy || !this.connection || !this.runtimeId) return;
    this.cancelling = true;
    this.cancelPermissions();
    await this.connection.agent.notify("session/cancel", { sessionId: this.runtimeId });
  }
  async *events(): AsyncIterable<AgentEvent> {
    while (!this.done || this.queue.length) {
      const event = this.queue.shift();
      if (event) yield event;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.interrupt().catch(() => {});
    this.closed = true;
    this.cancelPermissions();
    this.connection?.close();
    if (this.child) {
      const child = this.child;
      endStdin(child.proc.stdin);
      const timer = setTimeout(() => child.kill(), 1000);
      try {
        await child.proc.exited;
      } finally {
        clearTimeout(timer);
      }
    }
    this.done = true;
    this.wake?.();
  }
}

/** An ACP agent ORC ships a launch command for; config can still override the command. */
type BuiltinAcpAgent = {
  name: string;
  command: readonly [string, ...string[]];
  capabilities: AgentCapabilities;
  requires: string;
  missing: string;
};

export const OPENCODE_BUILTIN: BuiltinAcpAgent = {
  name: "opencode",
  command: ["opencode", "acp"],
  capabilities: OPENCODE_CAPABILITIES,
  requires:
    "OpenCode with ACP support on the execution host, or an agent_loop.acp_commands.opencode override",
  missing:
    "OpenCode is not installed on the selected execution host. Install it (npm install -g opencode-ai, see https://opencode.ai) or point agent_loop.acp_commands.opencode at an installed ACP command.",
};

function acpCommand(opts: SessionOpts, builtin?: BuiltinAcpAgent): string[] {
  const id = opts.acpAgent ?? opts.acpxAgent ?? builtin?.name;
  const configured = id ? loadConfig().agent_loop.acp_commands?.[id] : undefined;
  if (configured) return [configured.command, ...configured.args];
  if (builtin && id === builtin.name)
    return [opts.providerExecutable ?? builtin.command[0], ...builtin.command.slice(1)];
  throw new Error(
    "Configure agent_loop.acp_commands.<agent> with an ACP command and select that agent.",
  );
}
function createAcpBackend(builtin?: BuiltinAcpAgent): AgentBackend {
  const open = async (opts: SessionOpts) => {
    if (opts.toolAllowlist !== undefined || opts.ruleGuard)
      throw new Error("Direct ACP cannot enforce a tool whitelist or native ORC hooks.");
    if (opts.chatAgentOptions?.runtime === "acpx" && opts.chatAgentOptions.args.length)
      throw new Error(
        "ACPX launch flags do not apply to direct ACP. Configure the ACP command in ORC config.",
      );
    const session = new AcpSession(opts, acpCommand(opts, builtin), builtin?.capabilities);
    await session.initialize();
    return session;
  };
  return {
    name: builtin?.name ?? "acp",
    capabilities: builtin?.capabilities ?? ACP_CAPABILITIES,
    profileCapabilities: { model: true, toolAllowlist: false },
    preflight: async (opts = {}) => {
      const commands = loadConfig().agent_loop.acp_commands ?? {};
      const selected = opts.acpAgent ?? opts.acpxAgent ?? builtin?.name;
      const configured = selected ? commands[selected] : undefined;
      if (configured) {
        if (await hostBinary(sessionExecHost(opts), configured.command)) return { ok: true };
      } else if (builtin && selected === builtin.name) {
        const binary = opts.providerExecutable ?? builtin.command[0];
        if (await hostBinary(sessionExecHost(opts), binary)) return { ok: true };
        return { ok: false, error: builtin.missing };
      } else if (!selected) {
        for (const entry of Object.values(commands))
          if (await hostBinary(sessionExecHost(opts), entry.command)) return { ok: true };
      }
      return {
        ok: false,
        error:
          "Configure an installed ACP executable in agent_loop.acp_commands on the selected execution host.",
      };
    },
    describe: () =>
      builtin
        ? { kind: "cli", requires: builtin.requires, source: "builtin" }
        : {
            kind: "cli",
            requires: "an installed, authenticated ACP command in agent_loop.acp_commands",
            source: "config",
          },
    startSession: open,
    resumeSession: (id, opts) => open({ ...opts, runtimeSessionId: id }),
    stop: async () => {},
  };
}
registerBackend("acp", createAcpBackend);
registerBackend("opencode", () => createAcpBackend(OPENCODE_BUILTIN));
