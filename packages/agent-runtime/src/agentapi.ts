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

const logger = createLogger("agent-runtime:agentapi");

const DEFAULT_URL = "http://localhost:3284";

function baseUrl(opts: SessionOpts): string {
  return opts.agentApiUrl ?? process.env.AGENTAPI_URL ?? DEFAULT_URL;
}

// Parse a raw SSE stream into {event, data} objects.
async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      const blocks = buf.split("\n\n");
      buf = blocks.pop() ?? "";

      for (const block of blocks) {
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (data) yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class AgentApiSession implements AgentSession {
  readonly id: string;
  private readonly url: string;
  private readonly runtimeId: string;
  private queue: AgentEvent[] = [];
  private resolveNext: (() => void) | null = null;
  private done = false;
  private abort: AbortController | null = null;

  constructor(opts: SessionOpts) {
    this.id = ulid();
    this.url = baseUrl(opts);
    this.runtimeId = opts.runtimeSessionId ?? `orc-${this.id}`;
  }

  async send(prompt: string): Promise<void> {
    // Tear down any previous stream
    this.abort?.abort();
    this.abort = new AbortController();
    this.done = false;
    this.queue = [];

    // Snapshot last known message id so we can skip historical agent output
    let lastMsgId = 0;
    try {
      const r = await fetch(`${this.url}/messages`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const body = (await r.json()) as { messages?: Array<{ id: number }> };
        lastMsgId = body.messages?.at(-1)?.id ?? 0;
      }
    } catch {
      // If /messages fails, proceed without filtering — we'll emit everything
    }

    // POST the prompt. agentapi resolves once the agent starts processing.
    const res = await fetch(`${this.url}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: prompt, type: "user" }),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`agentapi POST /message ${res.status}: ${txt}`);
    }

    // Open the SSE stream and process events in the background
    const eventsRes = await fetch(`${this.url}/events`, {
      signal: this.abort.signal,
    });
    if (!eventsRes.ok || !eventsRes.body) {
      throw new Error(`agentapi GET /events ${eventsRes.status}`);
    }

    void this.driveStream(eventsRes.body, lastMsgId);
  }

  private async driveStream(body: ReadableStream<Uint8Array>, lastMsgId: number): Promise<void> {
    // Track streaming text so we emit deltas, not full snapshots
    let agentText = "";
    let seenRunning = false;

    try {
      const signal = this.abort?.signal ?? AbortSignal.timeout(300_000);
      for await (const { event, data } of parseSse(body, signal)) {
        if (event === "status_change") {
          const sc = JSON.parse(data) as { status: string };
          if (sc.status === "running") {
            seenRunning = true;
          } else if (sc.status === "stable" && seenRunning) {
            // Agent finished this turn
            this.push({ type: "result", data: { runtimeSessionId: this.runtimeId } });
            this.done = true;
            this.resolveNext?.();
            return;
          }
          continue;
        }

        if (event === "message_update") {
          const msg = JSON.parse(data) as { id: number; message: string; role: string };
          // Skip messages that existed before our prompt
          if (msg.id <= lastMsgId) continue;
          if (msg.role !== "agent") continue;

          // Emit only the newly appended text (agentapi sends full snapshot each update)
          const delta = msg.message.slice(agentText.length);
          agentText = msg.message;
          if (delta) this.push({ type: "text", data: delta });
          continue;
        }

        if (event === "agent_error") {
          const err = JSON.parse(data) as { level: string; message: string };
          this.push({ type: "error", data: `agentapi [${err.level}]: ${err.message}` });
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === "AbortError")) {
        logger.error("agentapi SSE stream error", { err });
        this.push({ type: "error", data: String(err) });
      }
    } finally {
      if (!this.done) {
        this.push({ type: "result", data: { runtimeSessionId: this.runtimeId } });
        this.done = true;
        this.resolveNext?.();
      }
    }
  }

  private push(event: AgentEvent): void {
    this.queue.push(event);
    this.resolveNext?.();
    this.resolveNext = null;
  }

  async *events(): AsyncIterable<AgentEvent> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift() as AgentEvent;
      if (this.done) break;
      await new Promise<void>((r) => {
        this.resolveNext = r;
      });
    }
    while (this.queue.length > 0) yield this.queue.shift() as AgentEvent;
  }

  respondPermission(_requestId: string, _result: PermissionResult): void {
    // agentapi handles permissions at the agent level (e.g. --allowedTools flag)
  }

  alive(): boolean {
    return !this.done;
  }

  async close(): Promise<void> {
    this.abort?.abort();
    this.done = true;
    this.resolveNext?.();
    this.resolveNext = null;
  }
}

function createAgentApiBackend(): AgentBackend {
  return {
    name: "agentapi",

    async preflight() {
      const url = process.env.AGENTAPI_URL ?? DEFAULT_URL;
      try {
        const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { ok: false, error: `agentapi /status → ${res.status}` };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `Cannot reach agentapi at ${url}: ${String(err)}` };
      }
    },

    async startSession(opts) {
      return new AgentApiSession(opts);
    },

    async resumeSession(runtimeSessionId, opts) {
      // agentapi maintains session context in its terminal emulator;
      // resuming just reuses the same server process.
      return new AgentApiSession({ ...opts, runtimeSessionId });
    },

    async stop() {},
  };
}

registerBackend("agentapi", createAgentApiBackend);
