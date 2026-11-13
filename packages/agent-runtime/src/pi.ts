import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  JsonAgentSessionEvent,
  RpcExtensionUIRequest,
  RpcSessionState,
} from "@earendil-works/pi-coding-agent";
import { ChatAgentOptionsSchema } from "@orc/core/chat-options";
import {
  hostBinary,
  hostExec,
  hostIsFile,
  remoteTempPath,
  removeHostFile,
  writeHostFile,
} from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import type { AgentCapabilities } from "@orc/core/types";
import { z } from "zod";
import { UNKNOWN_CAPABILITIES } from "./capabilities.js";
import { sessionExecHost } from "./execution-host.js";
import { buildOrcMcpServer } from "./orc-mcp.js";
import { piExtension } from "./pi-extension.js";
import { PiRpc } from "./pi-rpc.js";
import { dialogSchema, eventSchema, stateSchema } from "./pi-schema.js";
import { registerBackend } from "./registry.js";
import {
  type AgentBackend,
  type AgentEvent,
  type AgentSession,
  type ImageAttachment,
  type LivePermissionMode,
  type PermissionResult,
  permissionModeAllows,
  type SessionOpts,
} from "./types.js";

export const PI_CAPABILITIES: AgentCapabilities = Object.freeze({
  ...UNKNOWN_CAPABILITIES,
  source: "adapter",
  resume: true,
  modelSelection: true,
  images: true,
  toolOutput: true,
  approvals: true,
  questions: true,
  livePermissions: true,
  interrupt: true,
  steering: true,
  mcp: true,
  // `pi --fork <path|id>` copies a session into a new native identity.
  fork: true,
});
export async function piCommand(
  opts: Pick<SessionOpts, "executionHost" | "providerExecutable">,
): Promise<string[]> {
  const host = sessionExecHost(opts);
  const binary =
    host.kind === "local" && opts.providerExecutable
      ? Bun.which(opts.providerExecutable)
      : await hostBinary(host, "pi");
  if (!binary)
    throw new Error(
      "Pi CLI not found. Install @earendil-works/pi-coding-agent 1.5.2 or newer on the execution host.",
    );
  if (host.kind === "local") {
    let script = realpathSync(binary);
    if (/\.(cmd|ps1)$/i.test(binary)) {
      script = join(
        dirname(binary),
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "bundle",
        "cli.js",
      );
      if (!existsSync(script))
        throw new Error(
          "The Pi command shim has no CLI entry point. Configure the Pi JavaScript executable path.",
        );
    }
    if (/\.[cm]?js$/i.test(script)) {
      const node = Bun.which("node");
      if (!node) throw new Error("Pi requires Node.js 22.19 or newer on the execution host.");
      return [node, script];
    }
  }
  return [binary];
}

export class PiSession implements AgentSession {
  readonly id = ulid();
  readonly capabilities = { ...PI_CAPABILITIES };
  private rpc?: PiRpc;
  private runtimeId?: string;
  private sessionFile: string | undefined;
  // Pi writes the session file lazily, only once the transcript holds a user or
  // assistant message. Until then the native id is not resumable, so we must not
  // hand it to the chat runtime to pin for the next send.
  private resumable = false;
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private finished = false;
  private running = false;
  private turn = 0;
  private operation: Promise<void> | undefined;
  private closed = false;
  private stopping = false;
  private readonly allowedTools = new Set<string>();
  private failedTurn = false;
  private extensionFailed = false;
  private reloadPending = false;
  private modelError: string | undefined;
  private usage: unknown;
  private mode: LivePermissionMode;
  private readonly dialogs = new Map<
    string,
    {
      method: "select" | "confirm" | "input" | "editor";
      permission: boolean;
      tool?: string;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  private cleanup: () => Promise<void> = async () => {};
  private bridgeReady: ((ready: boolean) => void) | undefined;

  constructor(private readonly opts: SessionOpts) {
    this.mode =
      opts.permissionMode === "plan"
        ? "default"
        : (opts.permissionMode ?? (opts.autoApprove ? "bypassPermissions" : "default"));
    if (opts.permissionMode === "plan")
      throw new Error("Pi does not implement ORC plan permissions.");
  }
  async initialize(): Promise<void> {
    const host = sessionExecHost(this.opts);
    if (this.opts.runtimeSessionId && !z.uuid().safeParse(this.opts.runtimeSessionId).success)
      throw new Error("Pi resume requires the original native UUID, not a path or partial ID.");
    const command = await piCommand(this.opts);
    const version = await hostExec(host, [...command, "--version"], {
      timeoutMs: 10_000,
      env: this.opts.env,
      passEnv: Object.keys(this.opts.env ?? {}),
    });
    const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version.stdout.trim());
    if (
      version.code !== 0 ||
      !parsed ||
      Number(parsed[1]) < 1 ||
      (Number(parsed[1]) === 1 &&
        (Number(parsed[2]) < 5 || (Number(parsed[2]) === 5 && Number(parsed[3]) < 2)))
    )
      throw new Error("Pi 1.5.2 or newer is required for the native RPC adapter.");
    const config = {
      serverName: `orc_${this.id.toLowerCase()}`,
      ...(this.opts.orcMcp
        ? {
            server: buildOrcMcpServer(
              host,
              false,
              this.opts.orcMcpMode,
              this.opts.orcMcpProject,
              this.opts.orcPreviewSessionId ?? this.opts.attentionContext?.chatThreadId,
            ),
          }
        : {}),
    };
    const source = `const config=${JSON.stringify(config)}; export default (pi) => (${piExtension.toString()})(pi,config);\n`;
    let extension: string;
    let promptFile: string | undefined;
    try {
      if (host.kind === "ssh") {
        extension = remoteTempPath(".pi-extension.mjs");
        promptFile = this.opts.systemPromptAppend ? remoteTempPath(".pi-system.md") : undefined;
        const files = [extension, ...(promptFile ? [promptFile] : [])];
        this.cleanup = async () => {
          for (const file of files) await removeHostFile(host, file);
        };
        await writeHostFile(host, extension, source);
        if (promptFile) await writeHostFile(host, promptFile, this.opts.systemPromptAppend ?? "");
      } else {
        const dir = mkdtempSync(join(tmpdir(), "orc-pi-"));
        this.cleanup = async () => rmSync(dir, { recursive: true, force: true });
        extension = join(dir, "bridge.mjs");
        writeFileSync(extension, source, { mode: 0o600 });
        if (this.opts.systemPromptAppend) {
          promptFile = join(dir, "system-prompt.md");
          writeFileSync(promptFile, this.opts.systemPromptAppend, { mode: 0o600 });
        }
      }
      this.rpc = await PiRpc.start(
        host,
        [
          ...command,
          "--mode",
          "rpc",
          "--extension",
          extension,
          ...(this.opts.forkSourceRuntimeId
            ? ["--fork", this.opts.forkSourceRuntimeId]
            : this.opts.runtimeSessionId
              ? ["--session", this.opts.runtimeSessionId]
              : []),
          ...(this.opts.model ? ["--model", this.opts.model] : []),
          ...(promptFile ? ["--append-system-prompt", promptFile] : []),
        ],
        this.opts.cwd,
        this.opts.env ?? {},
      );
      this.rpc.onRecord((record) => this.receive(record));
      this.rpc.onFailure((error) => {
        this.push({ type: "error", data: error.message });
        this.finish("failed");
      });
      const state = stateSchema.parse(
        (await this.rpc.request({ type: "get_state" })).data,
      ) satisfies Pick<RpcSessionState, "sessionId">;
      this.runtimeId = state.sessionId;
      this.sessionFile = state.sessionFile;
      // A resumed session was loaded from disk, so it is already persisted; a brand
      // new one stays non-resumable until a turn appends its first message.
      this.resumable = !!this.opts.runtimeSessionId;
      if (this.opts.runtimeSessionId && this.opts.runtimeSessionId !== state.sessionId)
        throw new Error(
          "Pi did not resume the exact requested session; its original identity was preserved.",
        );
      const commands = z
        .object({ commands: z.array(z.object({ name: z.string() })) })
        .parse((await this.rpc.request({ type: "get_commands" })).data);
      if (!commands.commands.some((command) => command.name === "orc-adapter-check"))
        throw new Error("Pi could not load the ORC session bridge; refusing an unguarded session.");
      await this.checkBridge();
      await this.applyOptions();
      this.queue.length = 0;
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private client(): PiRpc {
    if (!this.rpc) throw new Error("Pi session is not initialized.");
    return this.rpc;
  }
  private async checkBridge(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = new Promise<boolean>((resolve) => {
        this.bridgeReady = resolve;
        timer = setTimeout(() => resolve(false), 15_000);
      });
      await this.client().request({ type: "prompt", message: "/orc-adapter-check" });
      if (!(await ready))
        throw new Error("Pi could not connect the ORC session bridge or MCP tools.");
    } finally {
      clearTimeout(timer);
      this.bridgeReady = undefined;
    }
  }
  private async applyOptions(): Promise<void> {
    if (!this.opts.chatAgentOptions) return;
    const parsed = ChatAgentOptionsSchema.parse(this.opts.chatAgentOptions);
    if (parsed.runtime !== "pi") throw new Error("Pi requires native Pi options.");
    const options = parsed.options;
    if (options.thinkingLevel !== undefined)
      await this.client().request({ type: "set_thinking_level", level: options.thinkingLevel });
    if (options.steeringMode !== undefined)
      await this.client().request({ type: "set_steering_mode", mode: options.steeringMode });
    if (options.followUpMode !== undefined)
      await this.client().request({ type: "set_follow_up_mode", mode: options.followUpMode });
    if (options.autoCompaction !== undefined)
      await this.client().request({ type: "set_auto_compaction", enabled: options.autoCompaction });
    if (options.autoRetry !== undefined)
      await this.client().request({ type: "set_auto_retry", enabled: options.autoRetry });
  }
  private async verifyIdentity() {
    const state = stateSchema.parse((await this.client().request({ type: "get_state" })).data);
    if (state.sessionId !== this.runtimeId)
      throw new Error(
        "Pi replaced the native session. The original ORC session identity was preserved.",
      );
    this.sessionFile = state.sessionFile;
    return state;
  }
  private async refreshResumable(): Promise<void> {
    // A persisted session stays persisted; never downgrade on a transient check
    // failure, and skip the host round-trip once we know it is resumable.
    if (this.resumable) return;
    this.resumable = this.sessionFile
      ? await hostIsFile(sessionExecHost(this.opts), this.sessionFile).catch(() => false)
      : false;
  }
  private async completeTurn(
    outcome: "completed" | "failed" | "stopped",
    turn: number,
  ): Promise<void> {
    try {
      const state = await this.verifyIdentity();
      if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) return;
      if (this.reloadPending) {
        await this.checkBridge();
        await this.applyOptions();
        this.reloadPending = false;
      }
      if (turn === this.turn && !this.finished) {
        await this.refreshResumable();
        this.finish(outcome);
      }
    } catch (error) {
      if (turn !== this.turn || this.finished) return;
      this.push({ type: "error", data: error instanceof Error ? error.message : String(error) });
      this.finish("failed");
      await this.close();
    }
  }
  private push(event: AgentEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = undefined;
  }
  private finish(outcome: "completed" | "failed" | "stopped"): void {
    if (this.finished) return;
    this.running = false;
    this.finished = true;
    for (const id of [...this.dialogs.keys()]) this.resolveDialog(id, { cancelled: true });
    if (outcome === "failed" && this.modelError)
      this.push({ type: "error", data: this.modelError });
    this.push({
      type: "result",
      data: {
        // An unpersisted session cannot be resumed; say so explicitly instead of
        // handing out an id the next send would fail to resume.
        ...(this.resumable ? { runtimeSessionId: this.runtimeId } : { resumable: false }),
        usage: this.usage,
        outcome,
      },
    });
  }
  private receive(record: unknown): void {
    const head = z.object({ type: z.string() }).parse(record);
    if (head.type === "extension_error") {
      const failure = z.object({ error: z.string() }).parse(record);
      this.extensionFailed = true;
      this.push({ type: "error", data: failure.error });
      return;
    }
    if (head.type === "extension_ui_request") {
      this.dialog(dialogSchema.parse(record));
      return;
    }
    const parsed = eventSchema.safeParse(record);
    if (!parsed.success) {
      if (
        [
          "message_update",
          "message_end",
          "tool_execution_start",
          "tool_execution_end",
          "agent_settled",
        ].includes(head.type)
      )
        throw new Error("Invalid Pi event");
      return;
    }
    const event = parsed.data;
    const eventType: JsonAgentSessionEvent["type"] = event.type;
    if (eventType === "message_update" && event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" || update.type === "thinking_delta")
        this.push({
          type: update.type === "text_delta" ? "text" : "thinking",
          data: update.delta ?? "",
        });
    } else if (event.type === "tool_execution_start")
      this.push({
        type: "tool_use",
        data: { id: event.toolCallId, name: event.toolName, input: JSON.stringify(event.args) },
      });
    else if (event.type === "tool_execution_end")
      this.push({
        type: "tool_result",
        data: {
          toolUseId: event.toolCallId,
          content: event.result.content.map((block) => block.text ?? `[${block.type}]`).join("\n"),
          isError: event.isError,
        },
      });
    else if (event.type === "message_end" && event.message.role === "assistant") {
      const counts = z.record(z.string(), z.unknown()).safeParse(event.message.usage);
      if (counts.success) {
        const totals = z.record(z.string(), z.number()).parse(this.usage ?? {});
        for (const [key, value] of Object.entries(counts.data))
          if (typeof value === "number" && Number.isFinite(value) && value >= 0)
            totals[key] = (totals[key] ?? 0) + value;
        this.usage = totals;
      }
      this.failedTurn = event.message.stopReason === "error";
      this.modelError = this.failedTurn
        ? (event.message.errorMessage ?? "Pi model request failed.")
        : undefined;
    } else if (event.type === "agent_settled" && this.running)
      void this.completeTurn(
        event.aborted || this.stopping
          ? "stopped"
          : this.failedTurn || this.extensionFailed
            ? "failed"
            : "completed",
        this.turn,
      );
    else if (event.type === "compaction_start" || event.type === "auto_retry_start")
      this.push({
        type: "system_status",
        data:
          event.type === "compaction_start"
            ? "Compacting Pi context…"
            : "Pi is retrying the model request…",
      });
  }
  private dialog(
    request: z.infer<typeof dialogSchema> & { method: RpcExtensionUIRequest["method"] },
  ): void {
    if (request.method === "notify") {
      if (request.message === "orc-adapter-reloaded") {
        this.reloadPending = true;
        return;
      }
      if (request.message === "orc-adapter-session-replacement-blocked") {
        this.extensionFailed = true;
        this.push({
          type: "error",
          data: "Native Pi session replacement is not supported. Start a new conversation in ORC.",
        });
        return;
      }
      if (request.message === "orc-adapter-mcp-failed" && !this.bridgeReady) {
        this.extensionFailed = true;
        this.push({
          type: "error",
          data: "Pi could not reconnect the scoped ORC MCP tools after reload.",
        });
        return;
      }
      if (request.message.startsWith("orc-adapter-")) {
        this.bridgeReady?.(request.message === "orc-adapter-ready");
        return;
      }
      this.push({ type: "system_status", data: request.message });
      return;
    }
    if (request.method === "setStatus") {
      if (request.statusText) this.push({ type: "system_status", data: request.statusText });
      return;
    }
    if (request.method === "setWidget") {
      if (request.widgetLines?.length)
        this.push({ type: "system_status", data: request.widgetLines.join("\n") });
      return;
    }
    if (request.method === "setTitle" || request.method === "set_editor_text") return;
    const permission = request.method === "confirm" && request.title === "ORC tool approval";
    const tool =
      permission && request.method === "confirm"
        ? z
            .object({ tool: z.string(), input: z.record(z.string(), z.unknown()) })
            .parse(JSON.parse(request.message))
        : undefined;
    const toolName = tool?.tool === "edit" ? "Edit" : tool?.tool === "write" ? "Write" : tool?.tool;
    if (this.closed || this.stopping || !this.running || this.dialogs.size >= 20) {
      void this.rpc
        ?.write({ type: "extension_ui_response", id: request.id, cancelled: true })
        .catch(() => {});
      return;
    }
    this.dialogs.set(request.id, {
      method: request.method,
      permission,
      ...(toolName ? { tool: toolName } : {}),
    });
    this.rpc?.waitingForHuman(true);
    if (request.timeout) {
      const timer = setTimeout(
        () => this.resolveDialog(request.id, { cancelled: true }),
        Math.min(request.timeout, 2_147_483_647),
      );
      const dialog = this.dialogs.get(request.id);
      if (dialog) dialog.timer = timer;
    }
    if (tool && toolName) {
      if (permissionModeAllows(this.mode, toolName) || this.allowedTools.has(toolName)) {
        this.respondPermission(request.id, "approved");
        return;
      }
      this.push({
        type: "permission_request",
        data: {
          requestId: request.id,
          tool: toolName,
          command:
            typeof tool.input.command === "string"
              ? tool.input.command
              : JSON.stringify(tool.input),
          input: tool.input,
          cwd: this.opts.cwd,
        },
      });
    } else
      this.push({
        type: "question_request",
        data: {
          requestId: request.id,
          questions: [
            {
              id: "answer",
              header: request.title.slice(0, 500),
              question: request.method === "confirm" ? request.message : request.title,
              options:
                request.method === "select"
                  ? request.options.map((label) => ({ label, description: "" }))
                  : request.method === "confirm"
                    ? [
                        { label: "Yes", description: "" },
                        { label: "No", description: "" },
                      ]
                    : null,
            },
          ],
        },
      });
  }
  private resolveDialog(
    id: string,
    response: { cancelled: true } | { confirmed: boolean } | { value: string },
  ): void {
    const dialog = this.dialogs.get(id);
    if (!dialog) return;
    clearTimeout(dialog.timer);
    this.dialogs.delete(id);
    this.rpc?.waitingForHuman(this.dialogs.size > 0);
    void this.rpc?.write({ type: "extension_ui_response", id, ...response }).catch(() => {});
    this.push({ type: "request_resolved", data: { requestId: id } });
  }
  respondPermission(id: string, result: PermissionResult): void {
    const dialog = this.dialogs.get(id);
    if (!dialog?.permission) return;
    if (result === "session" && dialog.tool) this.allowedTools.add(dialog.tool);
    this.resolveDialog(id, { confirmed: result !== "denied" });
  }
  respondQuestion(id: string, answers: Record<string, string[]>): void {
    const dialog = this.dialogs.get(id);
    if (!dialog || dialog.permission) return;
    const value = answers.answer?.[0];
    this.resolveDialog(
      id,
      value === undefined
        ? { cancelled: true }
        : dialog.method === "confirm"
          ? { confirmed: value === "Yes" }
          : { value },
    );
  }
  setPermissionMode(mode: LivePermissionMode): void {
    this.mode = mode;
    for (const [id, dialog] of this.dialogs)
      if (dialog.permission && dialog.tool && permissionModeAllows(mode, dialog.tool))
        this.respondPermission(id, "approved");
  }
  async send(prompt: string, images?: ImageAttachment[]): Promise<void> {
    if (!this.rpc?.alive()) throw new Error("Pi session is closed.");
    if (this.running || this.operation)
      throw new Error("Pi is already running or settling; use steering or wait for it to stop.");
    const turn = ++this.turn;
    this.finished = false;
    this.running = true;
    this.stopping = false;
    this.failedTurn = false;
    this.extensionFailed = false;
    this.modelError = undefined;
    this.usage = undefined;
    this.queue.length = 0;
    if (prompt.trim() === "/compact" && images?.length) {
      this.finish("failed");
      throw new Error("Pi compaction does not accept images.");
    }
    const execute = async () => {
      await this.verifyIdentity();
      if (turn !== this.turn) return;
      if (this.reloadPending) {
        await this.checkBridge();
        await this.applyOptions();
        this.reloadPending = false;
      }
      if (prompt.trim() === "/compact") {
        this.push({ type: "system_status", data: "Compacting Pi context…" });
        await this.client().request({ type: "compact" }, 120_000);
        if (turn === this.turn) await this.completeTurn("completed", turn);
        return;
      }
      const reply = await this.client().request({
        type: "prompt",
        message: prompt,
        ...(images?.length
          ? {
              images: images.map((image) => ({
                type: "image" as const,
                data: Buffer.from(image.data).toString("base64"),
                mimeType: image.mimeType,
              })),
            }
          : {}),
      });
      const data = z
        .object({ disposition: z.enum(["started", "queued", "handled"]) })
        .parse(reply.data);
      if (data.disposition === "handled" && turn === this.turn)
        await this.completeTurn(
          this.extensionFailed || this.failedTurn ? "failed" : "completed",
          turn,
        );
    };
    const operation = execute()
      .catch((error: unknown) => {
        if (turn !== this.turn) return;
        this.push({ type: "error", data: error instanceof Error ? error.message : String(error) });
        this.finish("failed");
      })
      .finally(() => {
        if (this.operation === operation) this.operation = undefined;
      });
    this.operation = operation;
  }

  async steer(prompt: string): Promise<void> {
    if (!this.running) throw new Error("Pi has no active turn to steer.");
    await this.client().request({ type: "steer", message: prompt });
  }
  async interrupt(): Promise<void> {
    if (!this.rpc?.alive()) return;
    this.stopping = true;
    ++this.turn;
    for (const id of [...this.dialogs.keys()]) this.resolveDialog(id, { cancelled: true });
    await this.rpc.request({ type: "clear_queue" });
    await this.rpc.request({ type: "abort" });
    await this.refreshResumable();
    this.finish("stopped");
    const operation = this.operation;
    if (operation) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          operation,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]);
        if (this.operation === operation) await this.close();
      } finally {
        clearTimeout(timer);
      }
    }
  }
  getRuntimeSessionId(): string | undefined {
    return this.runtimeId;
  }
  waitingForHuman(): boolean {
    return this.dialogs.size > 0;
  }
  alive(): boolean {
    return this.rpc?.alive() ?? false;
  }
  async *events(): AsyncIterable<AgentEvent> {
    while (true) {
      while (this.queue.length) {
        const event = this.queue.shift();
        if (event) yield event;
      }
      if (this.finished || this.closed) break;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.dialogs.keys()]) this.resolveDialog(id, { cancelled: true });
    await this.rpc?.close();
    await this.cleanup();
    this.finish("stopped");
    this.wake?.();
  }
}

export function createPiBackend(): AgentBackend {
  const open = async (opts: SessionOpts) => {
    const session = new PiSession(opts);
    await session.initialize();
    return session;
  };
  return {
    name: "pi",
    capabilities: PI_CAPABILITIES,
    profileCapabilities: { model: true, toolAllowlist: false },
    startSession: open,
    resumeSession: (runtimeSessionId, opts) => open({ ...opts, runtimeSessionId }),
    forkSession: (sourceRuntimeId, opts) => open({ ...opts, forkSourceRuntimeId: sourceRuntimeId }),
    preflight: async (opts = {}) => {
      try {
        await piCommand(opts);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    stop: async () => {},
    describe: () => ({
      kind: "cli",
      requires: "Pi CLI >=1.5.2, configured model credentials",
      source: "path",
    }),
  };
}
registerBackend("pi", createPiBackend);
