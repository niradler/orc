import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { registerBackend } from "./registry.js";
import type {
  AgentBackend,
  AgentEvent,
  AgentSession,
  PermissionResult,
  SessionOpts,
} from "./types.js";

const logger = createLogger("agent-runtime:a2a");

type A2aResponseEvent = {
  kind?: string;
  type?: string;
  role?: string;
  status?: { state?: string; message?: { parts?: Array<{ text?: string }> } };
  parts?: Array<{ text?: string; kind?: string }>;
  artifact?: { artifactId?: string; name?: string; parts?: Array<{ text?: string }> };
  taskId?: string;
  contextId?: string;
  final?: boolean;
  id?: string;
  messageId?: string;
};

class A2aSession implements AgentSession {
  readonly id: string;

  private readonly eventQueue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private done = false;
  private readonly a2aUrl: string;
  private readonly cwd: string;
  private taskId: string | undefined;
  private contextId: string;
  private abortController: AbortController | null = null;

  constructor(opts: SessionOpts) {
    this.id = ulid();
    this.a2aUrl = opts.a2aUrl ?? "";
    this.cwd = opts.cwd;
    this.contextId = opts.runtimeSessionId ?? ulid();
  }

  private push(event: AgentEvent): void {
    this.eventQueue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  private baseUrl(): string {
    return this.a2aUrl.replace(/\/$/, "");
  }

  async send(prompt: string): Promise<void> {
    this.done = false;
    this.eventQueue.length = 0;
    this.abortController = new AbortController();

    const messageId = ulid();
    const body = {
      jsonrpc: "2.0",
      id: messageId,
      method: "message/send",
      params: {
        message: {
          messageId,
          role: "user",
          parts: [{ kind: "text", text: prompt }],
        },
        configuration: {
          contextId: this.contextId,
          ...(this.taskId ? { taskId: this.taskId } : {}),
        },
      },
    };

    try {
      const response = await fetch(`${this.baseUrl()}/a2a/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        this.push({
          type: "error",
          data: `A2A request failed: ${response.status} ${response.statusText}`,
        });
        this.done = true;
        this.resolveNext?.();
        return;
      }

      const result = (await response.json()) as {
        result?: A2aResponseEvent;
        error?: { message?: string };
      };

      if (result.error) {
        this.push({ type: "error", data: result.error.message ?? "A2A error" });
        this.done = true;
        this.resolveNext?.();
        return;
      }

      this.processA2aResult(result.result);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.push({ type: "error", data: String(err) });
      }
      this.done = true;
      this.resolveNext?.();
    }
  }

  private processA2aResult(event: A2aResponseEvent | undefined): void {
    if (!event) {
      this.push({ type: "result", data: { runtimeSessionId: this.contextId } });
      this.done = true;
      this.resolveNext?.();
      return;
    }

    if (event.taskId) this.taskId = event.taskId;

    const kind = event.kind ?? event.type;

    if (kind === "message" && event.parts) {
      const text = event.parts.map((p) => p.text ?? "").join("");
      if (text) this.push({ type: "text", data: text });
    }

    if (kind === "task") {
      const state = event.status?.state;
      if (state === "working") {
        const msg = event.status?.message?.parts?.map((p) => p.text ?? "").join("") ?? "working...";
        this.push({ type: "thinking", data: msg });
      } else if (state === "completed") {
        const msg = event.status?.message?.parts?.map((p) => p.text ?? "").join("") ?? "";
        if (msg) this.push({ type: "text", data: msg });
      } else if (state === "failed") {
        const msg =
          event.status?.message?.parts?.map((p) => p.text ?? "").join("") ?? "task failed";
        this.push({ type: "error", data: msg });
      }
    }

    if (event.artifact) {
      const content = event.artifact.parts?.map((p) => p.text ?? "").join("") ?? "";
      this.push({
        type: "tool_result",
        data: {
          toolUseId: event.artifact.artifactId ?? ulid(),
          content,
          isError: false,
        },
      });
    }

    this.push({ type: "result", data: { runtimeSessionId: this.contextId } });
    this.done = true;
    this.resolveNext?.();
  }

  respondPermission(_requestId: string, _result: PermissionResult): void {
    // A2A agents handle their own permissions
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
    return !this.done;
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }
}

function createA2aBackend(): AgentBackend {
  return {
    name: "a2a",

    async preflight() {
      return { ok: true };
    },

    async startSession(opts) {
      if (!opts.a2aUrl) throw new Error("a2aUrl is required for A2A backend");
      const session = new A2aSession(opts);

      try {
        const response = await fetch(
          `${opts.a2aUrl.replace(/\/$/, "")}/.well-known/agent-card.json`,
        );
        if (!response.ok) {
          logger.warn("A2A agent card not found, proceeding anyway", {
            url: opts.a2aUrl,
            status: response.status,
          });
        }
      } catch (err) {
        logger.warn("Failed to fetch A2A agent card", { url: opts.a2aUrl, err });
      }

      return session;
    },

    async resumeSession(runtimeSessionId, opts) {
      if (!opts.a2aUrl) throw new Error("a2aUrl is required for A2A backend");
      return new A2aSession({ ...opts, runtimeSessionId });
    },

    async stop() {},
  };
}

registerBackend("a2a", createA2aBackend);
