import { ChatAnswersSchema, type ChatQuestion, ChatQuestionSchema } from "@orc/core/chat";
import { ChatAgentOptionsSchema } from "@orc/core/chat-options";
import { type ExecHost, ensureSshMaster, hostSpawn } from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { buildCodexEnv, codexCommand, hasConfiguredOrcMcp } from "./codex.js";
import { elicitationForm } from "./elicitation.js";
import { endStdin, readLines, writeToStdin } from "./io.js";
import { buildOrcMcpServer } from "./orc-mcp.js";
import {
  type AgentEvent,
  type AgentSession,
  type LivePermissionMode,
  type PermissionResult,
  permissionModeAllows,
  type SessionOpts,
} from "./types.js";

type Pending = {
  wireId: string | number;
  kind: "permission" | "question";
  question?: ChatQuestion;
  asyncTurnId?: string;
  permissions?: Record<string, unknown>;
  tool?: string;
  form?: ReturnType<typeof elicitationForm>;
  /** An MCP tool approval, answered as an elicitation; set when Codex can remember a session grant. */
  mcpApproval?: { sessionPersist: boolean };
};
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Interactive chat uses JSON-RPC; exec remains available for unattended callers. */
export class CodexAppSession implements AgentSession {
  readonly id = ulid();
  private child: Awaited<ReturnType<typeof hostSpawn>> | null = null;
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private closed = false;
  private runtimeId: string | undefined;
  private sequence = 0;
  private completedTurn = false;
  private readonly streamedItems = new Set<string>();
  /** The message whose text was streamed last; a new message starts a new paragraph. */
  private textItem: string | undefined;
  private readonly actionItems = new Map<string, Record<string, unknown>>();
  private readonly calls = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly pending = new Map<string, Pending>();
  private liveMode: LivePermissionMode | undefined;

  constructor(
    private readonly opts: SessionOpts,
    private readonly host: ExecHost,
    private readonly launcher: (host: ExecHost) => Promise<string[]> = codexCommand,
  ) {
    this.runtimeId = opts.runtimeSessionId;
  }

  private write(message: unknown): void {
    if (!this.child || this.closed) throw new Error("Codex connection is closed.");
    writeToStdin(this.child.proc.stdin, new TextEncoder().encode(`${JSON.stringify(message)}\n`));
  }

  private async call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = ++this.sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Codex ${method} timed out.`)), 60_000);
        this.calls.set(id, { resolve, reject });
        this.write({ id, method, params });
      });
    } finally {
      clearTimeout(timer);
      this.calls.delete(id);
    }
  }

  private push(event: AgentEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  private resolved(id: string): void {
    if (!this.pending.delete(id)) return;
    this.push({ type: "request_resolved", data: { requestId: id } });
  }

  private handle(message: Record<string, unknown>): void {
    if (!message.method && typeof message.id === "number") {
      const call = this.calls.get(message.id);
      if (message.error)
        call?.reject(new Error(String(object(message.error).message ?? "Codex request failed.")));
      else call?.resolve(object(message.result));
      return;
    }
    const method = String(message.method ?? "");
    const params = object(message.params);
    if (typeof message.id === "number" || typeof message.id === "string") {
      if (params.threadId !== this.runtimeId) {
        this.write({
          id: message.id,
          error: { code: -32602, message: "Request does not belong to this conversation." },
        });
        return;
      }
      const requestId = crypto.randomUUID();
      if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval" ||
        method === "item/permissions/requestApproval"
      ) {
        const permissions =
          method === "item/permissions/requestApproval" ? object(params.permissions) : undefined;
        const tool = permissions
          ? "additional permissions"
          : method.includes("commandExecution")
            ? "command"
            : "file changes";
        this.pending.set(requestId, {
          wireId: message.id,
          kind: "permission",
          tool,
          ...(permissions ? { permissions } : {}),
        });
        if (permissionModeAllows(this.liveMode, tool)) {
          this.respondPermission(requestId, "approved");
          return;
        }
        this.push({
          type: "permission_request",
          data: {
            requestId,
            input: {
              ...params,
              ...(typeof params.itemId === "string" && this.actionItems.has(params.itemId)
                ? { item: this.actionItems.get(params.itemId) }
                : {}),
            },
            ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
            tool,
            command: [
              params.command,
              params.cwd ? `Folder: ${params.cwd}` : undefined,
              params.reason,
              params.grantRoot ? `Write access: ${params.grantRoot}` : undefined,
              permissions ? JSON.stringify(permissions, null, 2) : undefined,
            ]
              .filter((value) => typeof value === "string")
              .join("\n"),
          },
        });
      } else if (
        method === "mcpServer/elicitation/request" &&
        object(params._meta).codex_approval_kind === "mcp_tool_call"
      ) {
        // Codex asks to approve MCP tool calls as an empty form. Answering it as a form
        // cancels the call, so it is an approval like any other.
        const meta = object(params._meta);
        const server = String(params.serverName ?? "");
        const call = [...this.actionItems.values()]
          .reverse()
          .find(
            (item) =>
              item.type === "mcpToolCall" && item.server === server && item.status === "inProgress",
          );
        const tool = call?.tool ? `mcp__${server}__${String(call.tool)}` : `mcp__${server}`;
        this.pending.set(requestId, {
          wireId: message.id,
          kind: "permission",
          tool,
          mcpApproval: {
            sessionPersist: Array.isArray(meta.persist) && meta.persist.includes("session"),
          },
        });
        if (permissionModeAllows(this.liveMode, tool)) {
          this.respondPermission(requestId, "approved");
          return;
        }
        const args = meta.tool_params ?? call?.arguments;
        this.push({
          type: "permission_request",
          data: {
            requestId,
            input: { ...params, ...(call ? { item: call } : {}) },
            tool,
            command: [
              params.message,
              args && Object.keys(object(args)).length ? JSON.stringify(args, null, 2) : undefined,
            ]
              .filter((value) => typeof value === "string")
              .join("\n"),
          },
        });
      } else if (method === "mcpServer/elicitation/request") {
        try {
          const form = elicitationForm(requestId, params);
          this.pending.set(requestId, {
            wireId: message.id,
            kind: "question",
            question: form.question,
            form,
          });
          this.push({ type: "question_request", data: form.question });
        } catch {
          this.write({ id: message.id, result: { action: "cancel", content: null } });
          this.push({
            type: "system_status",
            data: "MCP form declined: secret, URL authentication, or unsupported input requires the native client",
          });
        }
      } else if (method === "item/tool/requestUserInput") {
        const parsed = ChatQuestionSchema.safeParse({ requestId, questions: params.questions });
        if (
          !parsed.success ||
          new Set(parsed.data.questions.map((q) => q.id)).size !== parsed.data.questions.length
        ) {
          this.write({
            id: message.id,
            error: { code: -32602, message: "Unsupported question format." },
          });
          return;
        }
        this.pending.set(requestId, {
          wireId: message.id,
          kind: "question",
          question: parsed.data,
        });
        this.push({ type: "question_request", data: parsed.data });
      } else {
        // Unsupported requests fail explicitly instead of hanging or granting access.
        this.write({
          id: message.id,
          error: {
            code: -32601,
            message: "This interactive request is not supported by ORC chat.",
          },
        });
        this.push({
          type: "system_status",
          data: `Codex requested an unsupported interaction: ${method}`,
        });
      }
      return;
    }
    if (params.threadId && params.threadId !== this.runtimeId) return;
    if (method === "serverRequest/resolved") {
      for (const [id, request] of this.pending)
        if (request.wireId === params.requestId) this.resolved(id);
    } else if (method === "item/agentMessage/delta") {
      const itemId = String(params.itemId ?? "");
      this.streamedItems.add(itemId);
      this.pushText(itemId, String(params.delta ?? ""));
    } else if (method === "item/reasoning/summaryTextDelta") {
      this.push({ type: "thinking", data: String(params.delta ?? "") });
    } else if (method === "item/started" || method === "item/completed") {
      const item = object(params.item);
      if (method === "item/started" && typeof item.id === "string")
        this.actionItems.set(item.id, item);
      else if (method === "item/completed" && typeof item.id === "string")
        this.actionItems.delete(item.id);
      if (item.type === "agentMessage" && method === "item/completed") {
        if (!this.streamedItems.has(String(item.id)) && typeof item.text === "string" && item.text)
          this.pushText(String(item.id), item.text);
        if (Array.isArray(item.questions) && item.questions.length) {
          const requestId = crypto.randomUUID();
          const parsed = ChatQuestionSchema.safeParse({
            requestId,
            questions: item.questions.map((value, index) => {
              const question = object(value);
              return {
                id: `q-${index}`,
                header: "Your answer",
                question: question.title,
                options: Array.isArray(question.options)
                  ? question.options.map((label) => ({ label, description: "" }))
                  : null,
              };
            }),
          });
          if (!parsed.success || typeof params.turnId !== "string") {
            this.push({ type: "error", data: "Codex returned an unsupported question format." });
            return;
          }
          this.pending.set(requestId, {
            wireId: String(item.id),
            kind: "question",
            question: parsed.data,
            asyncTurnId: params.turnId,
          });
          this.push({ type: "question_request", data: parsed.data });
        }
        return;
      }
      if (
        !["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(String(item.type))
      )
        return;
      const id = String(item.id ?? "");
      if (method === "item/started")
        this.push({
          type: "tool_use",
          data: {
            id,
            name: String(item.tool ?? item.type),
            input: JSON.stringify(item.arguments ?? item.command ?? item.changes ?? ""),
          },
        });
      else
        this.push({
          type: "tool_result",
          data: {
            toolUseId: id,
            content: JSON.stringify(
              item.result ?? item.aggregatedOutput ?? item.changes ?? item.error ?? "",
            ),
            isError:
              item.status === "failed" ||
              item.status === "declined" ||
              (typeof item.exitCode === "number" && item.exitCode !== 0),
          },
        });
    } else if (method === "turn/completed") {
      const turn = object(params.turn);
      for (const [id, request] of this.pending)
        if (!request.asyncTurnId || turn.status !== "completed") this.resolved(id);
      if (turn.status === "failed")
        this.push({
          type: "error",
          data: String(object(turn.error).message ?? "Codex turn failed."),
        });
      else if (turn.status === "interrupted")
        this.push({ type: "system_status", data: "Codex turn stopped." });
      this.completedTurn = true;
      if (!this.pending.size) {
        this.push({ type: "result", data: { runtimeSessionId: this.runtimeId } });
        this.done = true;
      }
    } else if (method === "error" && params.willRetry !== true) {
      this.push({
        type: "error",
        data: String(object(params.error).message ?? "Codex turn failed."),
      });
    }
  }

  private pushText(itemId: string, text: string): void {
    const separated = this.textItem !== undefined && this.textItem !== itemId;
    this.textItem = itemId;
    this.push({ type: "text", data: separated ? `\n\n${text}` : text });
  }

  async send(prompt: string): Promise<void> {
    if (this.child && !this.done) throw new Error("Codex turn is still running.");
    this.done = false;
    this.completedTurn = false;
    this.streamedItems.clear();
    this.textItem = undefined;
    this.actionItems.clear();
    this.queue.length = 0;
    if (!this.child) {
      if (this.host.kind === "ssh") await ensureSshMaster(this.host);
      const command = await this.launcher(this.host);
      const supplied = this.opts.chatAgentOptions
        ? ChatAgentOptionsSchema.parse(this.opts.chatAgentOptions)
        : undefined;
      if (supplied && supplied.runtime !== "codex")
        throw new Error("Codex requires Codex launch arguments");
      const args = [
        ...command,
        "app-server",
        "--listen",
        "stdio://",
        ...(supplied?.runtime === "codex" ? supplied.args : []),
        "-c",
        'approvals_reviewer="user"',
        "-c",
        "features.default_mode_request_user_input=true",
      ];
      const mode = this.opts.permissionMode ?? (this.opts.autoApprove ? "acceptEdits" : "default");
      const env = buildCodexEnv();
      const mcp =
        this.opts.orcMcp === false
          ? null
          : buildOrcMcpServer(this.host, false, this.opts.orcMcpMode, this.opts.orcMcpProject);
      if (mcp) {
        if (await hasConfiguredOrcMcp(this.host, command, this.opts.cwd))
          args.push("-c", "mcp_servers.orc.enabled=false");
        const key = `mcp_servers.orc_runtime_${this.id}`;
        args.push("-c", `${key}.url=${JSON.stringify(mcp.url)}`, "-c", `${key}.required=true`);
        if (mode !== "default") args.push("-c", `${key}.default_tools_approval_mode="approve"`);
        if (mcp.headers?.Authorization) {
          env.ORC_CODEX_MCP_TOKEN = mcp.headers.Authorization.slice(7);
          args.push("-c", `${key}.bearer_token_env_var="ORC_CODEX_MCP_TOKEN"`);
        }
      }
      this.child = await hostSpawn(this.host, args, {
        cwd: this.opts.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env,
        passEnv: ["ORC_CODEX_MCP_TOKEN"],
      });
      const child = this.child;
      const drained = child.proc.stdout
        ? readLines(child.proc.stdout, (line) => {
            if (line.length > 2_000_000) {
              this.push({ type: "error", data: "Codex message exceeded the output limit." });
              child.kill();
              return;
            }
            try {
              this.handle(JSON.parse(line));
            } catch {
              this.push({ type: "error", data: "Codex returned an invalid protocol message." });
              child.kill();
            }
          })
        : Promise.resolve();
      void child.proc.exited.then(async () => {
        await drained;
        for (const call of this.calls.values())
          call.reject(new Error("Codex connection ended before responding."));
        if (!this.done && !this.closed)
          this.push({ type: "error", data: "Codex connection ended before completing the turn." });
        this.done = true;
        this.wake?.();
      });
      await this.call("initialize", {
        clientInfo: { name: "orc-chat", version: "1" },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: "initialized" });
      const result = await this.call(this.runtimeId ? "thread/resume" : "thread/start", {
        ...(this.runtimeId ? { threadId: this.runtimeId, excludeTurns: true } : {}),
        cwd: this.opts.cwd,
        model: this.opts.model,
        approvalPolicy: mode === "default" ? "on-request" : "never",
        approvalsReviewer: "user",
        sandbox:
          mode === "bypassPermissions"
            ? "danger-full-access"
            : mode === "acceptEdits"
              ? "workspace-write"
              : "read-only",
        ...(this.opts.systemPromptAppend
          ? { developerInstructions: this.opts.systemPromptAppend }
          : {}),
      });
      const id = object(result.thread).id;
      if (
        typeof id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id) ||
        (this.runtimeId && id !== this.runtimeId)
      )
        throw new Error("Codex did not resume the requested conversation.");
      this.runtimeId = id;
    }
    await this.call("turn/start", {
      threadId: this.runtimeId,
      input: [{ type: "text", text: prompt }],
    });
  }

  setPermissionMode(mode: LivePermissionMode): void {
    this.liveMode = mode;
    for (const [requestId, request] of this.pending)
      if (request.kind === "permission" && request.tool && permissionModeAllows(mode, request.tool))
        this.respondPermission(requestId, "approved");
  }

  respondPermission(requestId: string, result: PermissionResult): void {
    const request = this.pending.get(requestId);
    if (request?.kind !== "permission") throw new Error("This approval is no longer pending.");
    if (request.mcpApproval) {
      this.write({
        id: request.wireId,
        result:
          result === "denied"
            ? { action: "decline", content: null }
            : {
                action: "accept",
                content: {},
                ...(result === "session" && request.mcpApproval.sessionPersist
                  ? { _meta: { persist: "session" } }
                  : {}),
              },
      });
      this.resolved(requestId);
      return;
    }
    this.write({
      id: request.wireId,
      result: request.permissions
        ? {
            permissions: result === "denied" ? {} : request.permissions,
            scope: result === "session" ? "session" : "turn",
          }
        : {
            decision:
              result === "denied"
                ? "decline"
                : result === "session"
                  ? "acceptForSession"
                  : "accept",
          },
    });
    this.resolved(requestId);
  }

  async respondQuestion(requestId: string, answers: Record<string, string[]>): Promise<void> {
    const request = this.pending.get(requestId);
    if (request?.kind !== "question" || !request.question)
      throw new Error("This question is no longer pending.");
    const parsed = ChatAnswersSchema.parse(answers);
    const ids = request.question.questions.map((question) => question.id);
    if (
      Object.keys(parsed).length !== ids.length ||
      ids.some((id) => !parsed[id]?.some((answer) => answer.trim()))
    )
      throw new Error("Answer every question before continuing.");
    if (request.form) {
      this.write({
        id: request.wireId,
        result: { action: "accept", content: request.form.content(parsed) },
      });
      this.resolved(requestId);
      return;
    }
    if (request.asyncTurnId) {
      const input = [
        {
          type: "text",
          text: JSON.stringify({
            questions: request.question.questions.map((question) => ({
              question: question.question,
              answer: parsed[question.id],
            })),
          }),
        },
      ];
      const completed = this.completedTurn;
      this.pending.delete(requestId);
      this.completedTurn = false;
      try {
        await this.call(completed ? "turn/start" : "turn/steer", {
          threadId: this.runtimeId,
          ...(completed ? {} : { expectedTurnId: request.asyncTurnId }),
          input,
        });
      } catch (error) {
        this.pending.set(requestId, request);
        throw error;
      }
      this.push({ type: "request_resolved", data: { requestId } });
      return;
    } else
      this.write({
        id: request.wireId,
        result: { answers: Object.fromEntries(ids.map((id) => [id, { answers: parsed[id] }])) },
      });
    this.resolved(requestId);
  }

  getRuntimeSessionId(): string | undefined {
    return this.runtimeId;
  }
  alive(): boolean {
    return !this.closed && this.child?.proc.exitCode === null;
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
    this.closed = true;
    this.pending.clear();
    if (this.child) {
      endStdin(this.child.proc.stdin);
      const timer = setTimeout(() => this.child?.kill(), 3000);
      try {
        await this.child.proc.exited;
      } finally {
        clearTimeout(timer);
      }
    }
    this.done = true;
    this.wake?.();
  }
}
