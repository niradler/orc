import {
  type ClientCapabilities,
  type ClientConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  client,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type ListSessionsResponse,
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
  type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import {
  CHAT_SUBAGENT_MAX_ITEMS,
  type ChatSubagentActivity,
  type ChatSubagentPayload,
} from "@orc/core/chat";
import { loadConfig } from "@orc/core/config";
import { type HostProcess, hostBinary, hostIsDirectory, hostSpawn } from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import type { AgentCapabilities } from "@orc/core/types";
import { createAcpxParser } from "./acpx.js";
import { ACP_CAPABILITIES, OPENCODE_CAPABILITIES } from "./capabilities.js";
import { acpElicitationForm } from "./elicitation.js";
import { sessionExecHost } from "./execution-host.js";
import { endStdin, stderrTail, writeToStdin } from "./io.js";
import { buildOrcMcpServer } from "./orc-mcp.js";
import { planEvent, planFromToolInput } from "./plan.js";
import { registerBackend } from "./registry.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  ImageAttachment,
  PermissionResult,
  SessionOpts,
} from "./types.js";

export type AcpEffortChoice = { value: string; label: string };

/**
 * The agent explicitly did not consume the steering text (e.g. `_session/steering`
 * answered `promptRequired`). Nothing was delivered, so the caller may safely
 * queue the same message instead of treating it as possibly duplicated.
 */
export class SteerNotConsumedError extends Error {
  constructor() {
    super("The agent did not consume the steering message.");
    this.name = "SteerNotConsumedError";
  }
}

type SteeringResponse = {
  outcome?: "injected" | "promptRequired" | "startedNewTurn";
  reason?: string;
};

/** Effort levels from a thought_level select option, flattening option groups. */
function effortChoicesOf(option: SessionConfigOption | undefined): AcpEffortChoice[] | undefined {
  if (!option || option.type !== "select" || option.category !== "thought_level") return undefined;
  const choices = option.options
    .flatMap((entry) => ("group" in entry ? entry.options : [entry]))
    .slice(0, 16)
    .map((entry) => ({ value: entry.value, label: entry.name || entry.value }));
  return choices.length ? choices : undefined;
}

function thoughtLevelOption(
  options: readonly SessionConfigOption[],
): SessionConfigOption | undefined {
  return options.find((option) => option.category === "thought_level" && option.type === "select");
}

type ChildSessionMeta = { id: string; title?: string; parentId?: string };

/** OpenCode tags child-session updates with _meta["opencode/child-session"]. */
function childSessionMeta(update: unknown): ChildSessionMeta | null {
  const meta = (update as { _meta?: Record<string, unknown> } | null)?._meta?.[
    "opencode/child-session"
  ];
  if (!meta || typeof meta !== "object") return null;
  const record = meta as { id?: unknown; title?: unknown; parentID?: unknown };
  if (typeof record.id !== "string" || !record.id) return null;
  return {
    id: record.id.slice(0, 200),
    ...(typeof record.title === "string" && record.title
      ? { title: record.title.slice(0, 200) }
      : {}),
    ...(typeof record.parentID === "string" && record.parentID
      ? { parentId: record.parentID.slice(0, 200) }
      : {}),
  };
}

/** The child session a completed parent tool call spawned, when it names one. */
function completedChildSession(update: {
  sessionUpdate?: string;
  status?: string | null;
  rawOutput?: unknown;
}): { id: string; failed: boolean } | null {
  if (update.sessionUpdate !== "tool_call_update") return null;
  if (update.status !== "completed" && update.status !== "failed") return null;
  const output = update.rawOutput;
  if (!output || typeof output !== "object") return null;
  const record = output as { metadata?: { sessionId?: unknown }; sessionId?: unknown };
  const id = record.metadata?.sessionId ?? record.sessionId;
  if (typeof id !== "string" || !id) return null;
  return { id: id.slice(0, 200), failed: update.status === "failed" };
}

/** Inline child activity keeps bounded excerpts; the full transcript stays in the child session. */
const CHILD_INPUT_LIMIT = 1000;
const CHILD_RESULT_LIMIT = 2000;

function appendChildActivity(
  activity: ChatSubagentActivity,
  event: AgentEvent,
): ChatSubagentActivity {
  if (event.type === "tool_use") {
    const input = event.data.input.slice(0, CHILD_INPUT_LIMIT);
    const at = activity.findIndex((item) => item.type === "tool" && item.id === event.data.id);
    if (at >= 0) {
      const next = [...activity];
      const previous = next[at];
      if (previous?.type === "tool") next[at] = { ...previous, name: event.data.name, input };
      return next;
    }
    return [...activity, { type: "tool", ...event.data, input, startedAt: Date.now() }].slice(
      -CHAT_SUBAGENT_MAX_ITEMS,
    ) as ChatSubagentActivity;
  }
  if (event.type === "tool_result") {
    return activity.map((item) =>
      item.type === "tool" && item.id === event.data.toolUseId
        ? {
            ...item,
            result: event.data.content.slice(0, CHILD_RESULT_LIMIT),
            isError: event.data.isError,
          }
        : item,
    );
  }
  if (event.type === "thinking") {
    const last = activity[activity.length - 1];
    if (last?.type === "thinking")
      return [...activity.slice(0, -1), { ...last, text: (last.text + event.data).slice(-20000) }];
    return [...activity, { type: "thinking", id: ulid(), text: event.data.slice(0, 20000) }].slice(
      -CHAT_SUBAGENT_MAX_ITEMS,
    ) as ChatSubagentActivity;
  }
  return activity;
}

type ChildState = {
  nodeId: string;
  parentId?: string;
  title?: string;
  startedAt: number;
  status: "running" | "completed" | "failed";
  parse: (line: string) => AgentEvent[];
  activity: ChatSubagentActivity;
  text: string;
};

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
  /** The folder the session actually runs in; a resume can move it into a worktree. */
  private effectiveCwd: string;
  private movedFrom: string | undefined;
  private moveNoted = false;
  private sessionList = false;
  /** OpenCode 2.x steers through `_session/steering`; a second prompt is rejected. */
  private steeringExtension = false;
  private closed = false;
  private done = true;
  private busy = false;
  private cancelling = false;
  private replaying = false;
  private failure: string | undefined;
  private stderr = stderrTail(null);
  private outputBytes = 0;
  private readonly queue: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  private parse = createAcpxParser();
  /** Live child sessions (OpenCode subagents), keyed by their native session id. */
  private readonly children = new Map<string, ChildState>();
  /** Task tool calls shown as subagents when the agent does not stream the child session. */
  private readonly tasks = new Map<string, ChatSubagentPayload>();
  /** Notices from session setup; send() clears the queue, so they wait for the turn. */
  private readonly setupNotes: string[] = [];
  private readonly pending = new Map<
    string,
    { params: RequestPermissionRequest; resolve: (value: RequestPermissionResponse) => void }
  >();
  private readonly questions = new Map<
    string,
    {
      form: ReturnType<typeof acpElicitationForm>;
      resolve: (value: CreateElicitationResponse) => void;
    }
  >();

  constructor(
    private readonly opts: SessionOpts,
    private readonly command: readonly string[],
    initial: AgentCapabilities = ACP_CAPABILITIES,
  ) {
    this.capabilities = { ...initial };
    this.runtimeId = opts.runtimeSessionId;
    this.effectiveCwd = opts.cwd;
  }

  private push(event: AgentEvent): void {
    if (this.closed) return;
    if (event.type !== "subagent") this.outputBytes += JSON.stringify(event).length;
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
    this.failure = this.stderr.append(message);
    if (!this.done) this.queue.push({ type: "error", data: this.failure });
    this.done = true;
    this.cancelPending();
    this.wake?.();
    this.connection?.close();
    this.child?.kill();
  }

  private cancelPermissions(): void {
    for (const pending of [...this.pending.values()])
      pending.resolve({ outcome: { outcome: "cancelled" } });
    this.pending.clear();
  }

  private cancelQuestions(): void {
    for (const question of [...this.questions.values()]) question.resolve({ action: "cancel" });
    this.questions.clear();
  }

  private cancelPending(): void {
    this.cancelPermissions();
    this.cancelQuestions();
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
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : "";
      // An agent-reported failure already explains itself; the generic hint only
      // helps when the agent never answered.
      if (message && message !== `ACP ${method} timed out.`)
        throw new Error(`ACP ${method} failed: ${message}`);
      throw new Error(
        `ACP ${method} failed. Check the agent's login, protocol support and configuration.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ask a capable agent where it keeps a saved session; sessions can move into worktrees. */
  private async savedDirectory(sessionId: string): Promise<string | undefined> {
    if (!this.sessionList || !this.connection) return undefined;
    const listed = await this.request(
      this.connection.agent.request<ListSessionsResponse>("session/list", { cwd: null }),
      "session/list",
    );
    return listed.sessions.find((session) => session.sessionId === sessionId)?.cwd;
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
    // Never turn an ordinary ORC approval into the agent's persistent policy.
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
      // A child session's approval names the subagent so the prompt is unambiguous.
      const child = childSessionMeta(params.toolCall);
      const title = params.toolCall.title ?? "Agent action";
      this.push({
        type: "permission_request",
        data: {
          requestId: id,
          tool: params.toolCall.kind ?? "tool",
          command: child?.title ? `${child.title}: ${title}` : title,
          input: { toolCall: params.toolCall },
          cwd: this.effectiveCwd,
        },
      });
    });
  }

  private elicitation(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    if (
      this.replaying ||
      this.closed ||
      this.failure ||
      !this.busy ||
      this.done ||
      this.cancelling ||
      signal.aborted ||
      ("sessionId" in params && params.sessionId !== this.runtimeId)
    )
      return Promise.resolve({ action: "cancel" });
    if (params.mode !== "form") {
      this.push({
        type: "system_status",
        data:
          params.mode === "url"
            ? "This agent needs input in its native client: it requested URL elicitation."
            : `This agent needs input in its native client: unsupported elicitation mode "${params.mode}".`,
      });
      return Promise.resolve({ action: "decline" });
    }
    const id = ulid();
    let form: ReturnType<typeof acpElicitationForm>;
    try {
      form = acpElicitationForm(id, params);
    } catch (error) {
      this.push({
        type: "system_status",
        data: `${error instanceof Error ? error.message : "The agent requested an unsupported form."} Continue in the agent's native client.`,
      });
      return Promise.resolve({ action: "decline" });
    }
    return new Promise<CreateElicitationResponse>((resolve) => {
      const finish = (value: CreateElicitationResponse) => {
        signal.removeEventListener("abort", abort);
        if (this.questions.delete(id))
          this.push({ type: "request_resolved", data: { requestId: id } });
        resolve(value);
      };
      const abort = () => finish({ action: "cancel" });
      this.questions.set(id, { form, resolve: finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      this.push({ type: "question_request", data: form.question });
    });
  }

  /**
   * Child-session updates arrive on the parent's session id, tagged with the
   * child's identity. They accumulate into one inline transcript block per child
   * instead of mixing into the parent's text and tool stream.
   */
  private childUpdate(meta: ChildSessionMeta, params: { update: unknown }): void {
    let state = this.children.get(meta.id);
    if (!state) {
      const adopted = [...this.tasks.values()].find(
        (task) =>
          task.status === "running" &&
          ![...this.children.values()].some((child) => child.nodeId === task.id),
      );
      const parent = meta.parentId ? this.children.get(meta.parentId) : undefined;
      state = {
        nodeId: adopted?.id ?? meta.id,
        ...(parent ? { parentId: parent.nodeId } : {}),
        startedAt: adopted?.startedAt ?? Date.now(),
        status: "running",
        parse: createAcpxParser(),
        activity: [],
        text: "",
      };
      this.children.set(meta.id, state);
    }
    if (meta.title) state.title = meta.title;
    const events = state.parse(JSON.stringify({ method: "session/update", params }));
    let discrete = false;
    for (const event of events) {
      if (event.type === "text") {
        state.text = (state.text + event.data).slice(-100000);
        continue;
      }
      if (event.type === "tool_use" || event.type === "tool_result") discrete = true;
      state.activity = appendChildActivity(state.activity, event);
    }
    // Text and thinking stream into the block silently; pushing every chunk would
    // resend the whole transcript each time. Discrete tool events carry it live.
    if (discrete) this.pushChild(state);
  }

  private pushChild(state: ChildState): void {
    this.push({
      type: "subagent",
      data: {
        id: state.nodeId,
        ...(state.parentId ? { parentId: state.parentId } : {}),
        ...(state.title ? { title: state.title } : {}),
        status: state.status,
        startedAt: state.startedAt,
        ...(state.status === "running" ? {} : { durationMs: Date.now() - state.startedAt }),
        activity: state.activity,
        ...(state.text ? { text: state.text } : {}),
      },
    });
  }

  private taskUpdate(update: {
    sessionUpdate?: string;
    toolCallId?: string;
    title?: string | null;
    status?: string | null;
    rawInput?: unknown;
  }): void {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    if (!update.toolCallId) return;
    const input = (update.rawInput ?? {}) as { subagent_type?: unknown; description?: unknown };
    const known = this.tasks.get(update.toolCallId);
    if (!known && typeof input.subagent_type !== "string") return;
    if ([...this.children.values()].some((child) => child.nodeId === update.toolCallId)) return;
    const startedAt = known?.startedAt ?? Date.now();
    const status: ChatSubagentPayload["status"] =
      update.status === "completed"
        ? "completed"
        : update.status === "failed"
          ? "failed"
          : update.status === "cancelled"
            ? "stopped"
            : "running";
    const title =
      typeof input.description === "string" && input.description
        ? input.description
        : (known?.title ?? update.title ?? "Subagent");
    const next: ChatSubagentPayload = {
      id: update.toolCallId.slice(0, 200),
      title: title.slice(0, 200),
      status,
      startedAt,
      ...(status === "running" ? {} : { durationMs: Date.now() - startedAt }),
      activity: [],
    };
    if (known && known.status === next.status && known.title === next.title) return;
    this.tasks.set(update.toolCallId, next);
    this.push({ type: "subagent", data: next });
  }

  /** The parent's task call finished, so the child it names is done too. */
  private finishChild(id: string, failed: boolean): void {
    const state = this.children.get(id);
    if (!state || state.status !== "running") return;
    state.status = failed ? "failed" : "completed";
    this.pushChild(state);
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new Error("ACP connection is closed.");
    try {
      this.child = await hostSpawn(sessionExecHost(this.opts), this.command, {
        cwd: this.opts.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...this.opts.env },
        passEnv: Object.keys(this.opts.env ?? {}),
      });
      const child = this.child;
      this.stderr = stderrTail(child.proc.stderr);
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
        .onRequest("elicitation/create", ({ params, signal }) => this.elicitation(params, signal))
        .onNotification("session/update", ({ params }) => {
          if (this.replaying || this.closed || params.sessionId !== this.runtimeId || this.done)
            return;
          if (params.update.sessionUpdate === "config_option_update") {
            // A model change can change the effort levels the session offers.
            const choices = effortChoicesOf(thoughtLevelOption(params.update.configOptions ?? []));
            const next = { ...this.capabilities };
            if (choices) next.effortChoices = choices;
            else delete next.effortChoices;
            this.capabilities = next;
            this.push({ type: "capabilities", data: next });
            return;
          }
          const child = childSessionMeta(params.update);
          if (child) {
            this.childUpdate(child, params);
            return;
          }
          const events = this.parse(JSON.stringify({ method: "session/update", params }));
          for (const event of events) {
            this.push(event);
            // OpenCode and other ACP agents publish their checklist as a tool call.
            if (event.type === "tool_use") {
              const plan = planFromToolInput(event.data.name, event.data.input);
              if (plan) this.push(plan);
            }
          }
          const finished = completedChildSession(params.update);
          if (finished) this.finishChild(finished.id, finished.failed);
          this.taskUpdate(params.update);
          if (params.update.sessionUpdate === "plan") {
            const plan = planEvent("plan", params.update.entries ?? []);
            if (plan) this.push(plan);
          } else if (
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
      void this.connection.closed.then(async () => {
        await this.stderr.settled();
        if (!this.closed)
          this.fail("ACP connection closed. Resume this conversation after checking the agent.");
      });
      void child.proc.exited.then(async () => {
        await this.stderr.settled();
        if (!this.closed)
          this.fail("ACP agent exited. Resume this conversation after checking the agent.");
      });
      const agent = this.connection.agent;
      const clientCapabilities: ClientCapabilities = {
        elicitation: { form: {} },
        // OpenCode streams subagent activity on the parent session only when the
        // client opts in; other ACP agents ignore the unknown key.
        _meta: { "opencode/child-session-updates": true },
      };
      const initialized = await this.request(
        agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "orc", version: "1" },
          clientCapabilities,
        }),
        "initialize",
      );
      if (initialized.protocolVersion !== PROTOCOL_VERSION)
        throw new Error("Unsupported ACP protocol version.");
      const native = initialized.agentCapabilities;
      this.steeringExtension =
        (initialized as { _meta?: { steering?: { supported?: boolean } } })._meta?.steering
          ?.supported === true;
      this.sessionList = native?.sessionCapabilities?.list != null;
      this.capabilities = {
        ...this.capabilities,
        source: "negotiated",
        resume: native?.loadSession === true,
        images: native?.promptCapabilities?.image === true,
        mcp: native?.mcpCapabilities?.http === true,
        // `session/fork` is unstable in ACP, so only trust the negotiated handshake.
        fork: native?.sessionCapabilities?.fork != null,
        // Form elicitation is a client capability. The agent may use it after this handshake.
        questions: clientCapabilities.elicitation?.form !== undefined,
        // ACP has no steering field. The backend's declaration survives the
        // handshake; steer() downgrades it if the agent rejects a mid-turn prompt.
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
      const common = { cwd: this.effectiveCwd, mcpServers };
      let configOptions: SessionConfigOption[] = [];
      this.replaying = true;
      try {
        if (this.runtimeId) {
          if (!this.capabilities.resume)
            throw new Error(
              "This ACP agent cannot resume saved sessions; the original identity was preserved.",
            );
          const sessionId = this.runtimeId;
          const load = (cwd: string) =>
            agent.request<LoadSessionResponse>("session/load", {
              ...common,
              cwd,
              sessionId,
            });
          let loaded: LoadSessionResponse;
          try {
            loaded = await this.request(load(this.effectiveCwd), "session/load");
          } catch (error) {
            // OpenCode can move a session into a worktree it created, so the folder
            // recorded by ORC no longer owns the session. Ask the agent where it
            // lives and load it there instead of losing the conversation.
            const saved = await this.savedDirectory(sessionId).catch(() => undefined);
            if (!saved || saved === this.effectiveCwd) throw error;
            if (!(await hostIsDirectory(sessionExecHost(this.opts), saved)))
              throw new Error(
                `ACP session/load failed: the session moved to ${saved}, which is no longer available on the execution host.`,
              );
            loaded = await this.request(load(saved), "session/load");
            this.movedFrom = this.effectiveCwd;
            this.effectiveCwd = saved;
          }
          configOptions = loaded?.configOptions ?? [];
        } else if (this.opts.forkSourceRuntimeId) {
          if (!this.capabilities.fork)
            throw new Error(
              "This ACP agent cannot fork sessions; its handshake advertises no session/fork.",
            );
          const forked = await this.request(
            agent.request<ForkSessionResponse, ForkSessionRequest>("session/fork", {
              ...common,
              sessionId: this.opts.forkSourceRuntimeId,
            }),
            "session/fork",
          );
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(forked.sessionId))
            throw new Error("ACP returned an invalid forked session identity.");
          this.runtimeId = forked.sessionId;
          configOptions = forked.configOptions ?? [];
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
        const changed = await this.request(
          agent.request<SetSessionConfigOptionResponse>("session/set_config_option", {
            sessionId: this.runtimeId,
            configId: model.id,
            value: this.opts.model,
          }),
          "session/set_config_option",
        );
        if (changed?.configOptions?.length) configOptions = changed.configOptions;
      }
      const mode = configOptions.find(
        (option) => option.category === "mode" && option.type === "select",
      );
      const modes =
        mode?.type === "select"
          ? mode.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]))
          : [];
      if (modes.some((entry) => entry.value === "plan")) {
        this.capabilities = { ...this.capabilities, permissionModes: ["default", "plan"] };
        const wanted =
          this.opts.permissionMode === "plan"
            ? "plan"
            : modes.find((entry) => entry.value !== "plan")?.value;
        if (mode && wanted && wanted !== mode.currentValue)
          await this.request(
            agent.request("session/set_config_option", {
              sessionId: this.runtimeId,
              configId: mode.id,
              value: wanted,
            }),
            "session/set_config_option",
          );
      }
      const effort = thoughtLevelOption(configOptions);
      const choices = effortChoicesOf(effort);
      if (choices) this.capabilities = { ...this.capabilities, effortChoices: choices };
      const saved = this.opts.chatAgentOptions;
      const requested = saved?.runtime === "opencode" ? saved.options.effort : undefined;
      if (requested && requested !== "default") {
        if (!choices)
          this.setupNotes.push(
            "This session does not expose effort levels; the agent default is used.",
          );
        else if (!choices.some((choice) => choice.value === requested))
          this.setupNotes.push(
            `Effort "${requested}" is not available for this model; the agent default is used.`,
          );
        else if (effort)
          await this.request(
            agent.request("session/set_config_option", {
              sessionId: this.runtimeId,
              configId: effort.id,
              value: requested,
            }),
            "session/set_config_option",
          );
      }
    } catch (error) {
      await this.close();
      await this.stderr.settled();
      throw error instanceof Error ? new Error(this.stderr.append(error.message)) : error;
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
    this.children.clear();
    this.tasks.clear();
    this.push({ type: "capabilities", data: this.capabilities });
    for (const note of this.setupNotes.splice(0)) this.push({ type: "system_status", data: note });
    if (this.movedFrom && !this.moveNoted) {
      this.moveNoted = true;
      this.push({
        type: "system_status",
        data: `This session moved to ${this.effectiveCwd}; continuing there.`,
      });
    }
    const text =
      prompt.trim() === "/compact"
        ? "/compact"
        : [this.opts.systemPromptAppend, prompt].filter(Boolean).join("\n\n");
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
      .then(async (result) => {
        if (this.closed || this.failure) return;
        // The protocol connection dispatches notifications and responses concurrently.
        // Let final session/update frames flush before this turn stops accepting them.
        await Promise.resolve();
        if (this.closed || this.failure) return;
        if (result.stopReason === "cancelled")
          this.push({ type: "system_status", data: "ACP turn stopped." });
        else if (result.stopReason !== "end_turn")
          this.push({ type: "error", data: `ACP turn ended: ${result.stopReason}` });
        // Close any child block whose task call never reported completion.
        for (const state of this.children.values())
          if (state.status === "running") {
            state.status =
              result.stopReason === "end_turn" || result.stopReason === "cancelled"
                ? "completed"
                : "failed";
            this.pushChild(state);
          }
        for (const task of this.tasks.values())
          if (
            task.status === "running" &&
            ![...this.children.values()].some((child) => child.nodeId === task.id)
          )
            this.taskUpdate({
              sessionUpdate: "tool_call_update",
              toolCallId: task.id,
              status:
                result.stopReason === "end_turn"
                  ? "completed"
                  : result.stopReason === "cancelled"
                    ? "cancelled"
                    : "failed",
            });
        this.push({
          type: "result",
          data: {
            runtimeSessionId: this.runtimeId,
            usage: result.usage,
            ...(this.movedFrom ? { cwd: this.effectiveCwd } : {}),
          },
        });
        this.done = true;
      })
      .catch(() =>
        this.fail("ACP prompt failed. Check the agent's login and session availability."),
      )
      .finally(() => {
        this.done = true;
        this.busy = false;
        this.cancelPending();
        this.wake?.();
      });
  }

  /**
   * OpenCode 2.x runs one prompt at a time and rejects a second `session/prompt`;
   * when it advertises the steering extension, steer through `_session/steering`
   * and let the owning prompt stay pending until the steered output finishes.
   * Older OpenCode (verified against 1.19.5) treats a second `session/prompt`
   * during a running turn as steering: the text joins the active turn and that
   * request resolves when the turn ends. Agents without the declared capability
   * keep steering=false and never reach this method.
   */
  async steer(prompt: string): Promise<void> {
    if (this.closed || this.failure || !this.connection || !this.runtimeId)
      throw new Error("ACP connection is unavailable.");
    if (this.capabilities.steering !== true)
      throw new Error("This ACP agent does not accept steering.");
    if (!this.busy || this.done || this.cancelling)
      throw new Error("ACP has no active turn to steer.");
    if (this.steeringExtension) {
      const started = Date.now();
      let result: SteeringResponse;
      try {
        result = await this.connection.agent.request<SteeringResponse>("_session/steering", {
          sessionId: this.runtimeId,
          prompt: [{ type: "text", text: prompt }],
          // Ask the agent to refuse rather than start a turn of its own when idle;
          // a refusal means the text was not consumed and can be queued safely.
          _meta: { steering: { idleBehavior: "promptRequired" } },
        });
      } catch (error) {
        if (Date.now() - started <= 2000 && !this.closed && !this.failure && !this.cancelling) {
          this.capabilities = { ...this.capabilities, steering: false };
          this.push({ type: "capabilities", data: this.capabilities });
          this.push({
            type: "system_status",
            data: "This agent rejected steering; the running turn continues. Queue the message instead.",
          });
        }
        throw error;
      }
      if (result?.outcome === "injected" || result?.outcome === "startedNewTurn") return;
      throw new SteerNotConsumedError();
    }
    const started = Date.now();
    // OpenCode answers an accepted steer only when the turn ends, so do not wait
    // for it. A refusal is immediate; a later failure belongs to the turn itself
    // and must not relabel this session's steering support.
    void this.connection.agent
      .request<PromptResponse, PromptRequest>("session/prompt", {
        sessionId: this.runtimeId,
        prompt: [{ type: "text", text: prompt }],
      })
      .catch(() => {
        if (Date.now() - started > 2000) return;
        // A dead, closed or cancelling turn is not a steering refusal; its own
        // failure path already reports what happened.
        if (this.closed || this.failure || this.cancelling) return;
        this.capabilities = { ...this.capabilities, steering: false };
        // Tell the client now so its send control stops offering steering for
        // this turn instead of failing on the next attempt.
        this.push({ type: "capabilities", data: this.capabilities });
        this.push({
          type: "system_status",
          data: "This agent rejected steering; the running turn continues. Queue the message instead.",
        });
      });
  }

  respondQuestion(id: string, answers: Record<string, string[]>): void {
    const pending = this.questions.get(id);
    if (!pending) throw new Error("This question is no longer pending.");
    const content = pending.form.content(answers);
    this.questions.delete(id);
    pending.resolve(content ? { action: "accept", content } : { action: "decline" });
    this.push({ type: "request_resolved", data: { requestId: id } });
  }

  respondPermission(id: string, result: PermissionResult): void {
    const pending = this.pending.get(id);
    if (!pending) throw new Error("This approval is no longer pending.");
    const kind =
      result === "denied" ? "reject_once" : result === "session" ? "allow_always" : "allow_once";
    const option =
      pending.params.options.find((entry) => entry.kind === kind) ??
      // Older or narrower agents may offer only the one-shot grant.
      (result === "session"
        ? pending.params.options.find((entry) => entry.kind === "allow_once")
        : undefined);
    pending.resolve({
      outcome: option
        ? { outcome: "selected", optionId: option.optionId }
        : { outcome: "cancelled" },
    });
  }
  waitingForHuman(): boolean {
    return this.pending.size > 0 || this.questions.size > 0;
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
    this.cancelPending();
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
    // An explicit Stop already cancelled the turn; do not cancel a second time.
    if (!this.cancelling) await this.interrupt().catch(() => {});
    this.closed = true;
    this.cancelPending();
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

/**
 * Effort levels for a chat that has not started: a metadata-only ACP handshake
 * (initialize + session/new), deleting the probe session afterwards so it never
 * reaches the session list. Null when the agent cannot clean up after itself,
 * exposes no effort option, or does not answer in time.
 */
export async function probeOpenCodeEffortChoices(opts: {
  cwd: string;
  executionHost?: string | null | undefined;
  providerExecutable?: string | undefined;
  env?: Record<string, string> | undefined;
}): Promise<AcpEffortChoice[] | null> {
  const host = sessionExecHost(opts);
  const command = acpCommand({ ...opts, acpAgent: "opencode" }, OPENCODE_BUILTIN);
  let child: HostProcess | undefined;
  let connection: ClientConnection | undefined;
  const deadline = setTimeout(() => child?.kill(), 15_000);
  try {
    child = await hostSpawn(host, command, {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...opts.env },
      passEnv: Object.keys(opts.env ?? {}),
    });
    if (!child.proc.stdout || typeof child.proc.stdout === "number") return null;
    const proc = child;
    const output = new WritableStream<Uint8Array>({
      write: (data) => writeToStdin(proc.proc.stdin, data),
      close: () => endStdin(proc.proc.stdin),
    });
    connection = client({ name: "orc-probe" }).connect(
      ndJsonStream(output, boundedOutput(child.proc.stdout)),
    );
    const agent = connection.agent;
    const initialized = await agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "orc", version: "1" },
      clientCapabilities: { elicitation: { form: {} } },
    });
    // Without session/delete the probe would leave a junk session behind.
    if (initialized.agentCapabilities?.sessionCapabilities?.delete == null) return null;
    const created = await agent.request<NewSessionResponse, NewSessionRequest>("session/new", {
      cwd: opts.cwd,
      mcpServers: [],
    });
    const choices = effortChoicesOf(thoughtLevelOption(created.configOptions ?? [])) ?? null;
    await agent.request("session/delete", { sessionId: created.sessionId }).catch(() => {});
    return choices;
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
    connection?.close();
    if (child) {
      const proc = child;
      endStdin(proc.proc.stdin);
      const kill = setTimeout(() => proc.kill(), 1000);
      await proc.proc.exited.catch(() => {});
      clearTimeout(kill);
    }
  }
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
    forkSession: (id, opts) => open({ ...opts, forkSourceRuntimeId: id }),
    stop: async () => {},
  };
}
registerBackend("acp", createAcpBackend);
registerBackend("opencode", () => createAcpBackend(OPENCODE_BUILTIN));
