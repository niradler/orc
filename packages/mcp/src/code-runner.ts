import { readFileSync } from "node:fs";
import { createLogger } from "@orc/core/logger";
import {
  CODE_LIMITS,
  type CodeOutput,
  type WorkerInput,
  type WorkerOutput,
} from "./code-protocol.js";

const logger = createLogger("mcp:code");
let activeExecutions = 0;

declare const ORC_NPM_BUNDLE: boolean;

let embeddedAssets: { script: string; wasm: string } | undefined;
let embeddedWorker: { url: string; wasm: ArrayBuffer } | undefined;

export function registerCodeWorkerAssets(assets: { script: string; wasm: string }): void {
  embeddedAssets = assets;
}

function startWorker(): Worker {
  if (embeddedAssets) {
    if (!embeddedWorker) {
      const wasm = readFileSync(embeddedAssets.wasm);
      const script = readFileSync(embeddedAssets.script);
      embeddedWorker = {
        url: URL.createObjectURL(new File([new Uint8Array(script)], "code-worker.js")),
        wasm: new Uint8Array(wasm).buffer,
      };
    }
    return new Worker(embeddedWorker.url, { env: {} });
  }
  if (typeof ORC_NPM_BUNDLE !== "undefined" && ORC_NPM_BUNDLE) {
    return new Worker(new URL("./code-worker.js", import.meta.url), { env: {} });
  }
  return new Worker(new URL("./code-worker.ts", import.meta.url), { env: {} });
}

export interface CodeRequest {
  serial: boolean;
  toolName?: string | undefined;
  timeoutMs?: number | undefined;
  envelope?: boolean | undefined;
  pause?: boolean | undefined;
  dispatch(signal: AbortSignal): Promise<string>;
}

function errorPayload(error: string): string {
  return JSON.stringify({ error });
}

function envelopeErrorPayload(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } });
}

function isCallPayload(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { operation?: unknown })?.operation === "call";
  } catch {
    return false;
  }
}

export function runCodeWorker(
  code: string,
  timeoutMs: number,
  signal: AbortSignal,
  prepare: (payload: string) => CodeRequest,
): Promise<CodeOutput> {
  if (signal.aborted) return Promise.reject(new Error("Code execution cancelled"));
  if (activeExecutions >= CODE_LIMITS.executions) {
    return Promise.reject(new Error("Code mode is busy. Try again later."));
  }
  const started = Date.now();
  const deadline = started + timeoutMs;
  let effectiveDeadline = deadline;
  let pausedMs = 0;
  let pauseStartedAt: number | undefined;
  let worker: Worker;
  try {
    worker = startWorker();
  } catch {
    logger.error("Could not load code worker assets");
    return Promise.reject(new Error("Code worker failed to start"));
  }
  activeExecutions++;

  return new Promise<CodeOutput>((resolve, reject) => {
    const queue: (CodeRequest & { id: number })[] = [];
    const callTimers = new Set<ReturnType<typeof setTimeout>>();
    let running = 0;
    let serialRunning = false;
    let requests = 0;
    let replyBytes = 0;
    const dispatchedTools: string[] = [];
    let closed = false;
    const workerAbort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    function finish(result: CodeOutput | Error): void {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      for (const activeTimer of callTimers) clearTimeout(activeTimer);
      callTimers.clear();
      signal.removeEventListener("abort", cancel);
      workerAbort.abort();
      queue.length = 0;
      worker.terminate();
      if (running === 0) activeExecutions--;
      logger.info("Code execution finished", {
        status: result instanceof Error ? "failed" : "completed",
        durationMs: Date.now() - started,
        requests,
        dispatchedTools,
        inFlight: running,
      });
      if (result instanceof Error) reject(result);
      else resolve(result);
    }

    function cancel(): void {
      finish(new Error("Code execution cancelled"));
    }

    function post(message: WorkerInput): void {
      if (!closed) worker.postMessage(message);
    }

    // Extend the worker's wall-clock budget after an elicitation pause. Sent
    // before the reply so the resumed script does not see a stale deadline.
    function resumeClock(): void {
      if (pauseStartedAt === undefined) return;
      clearTimeout(timer);
      pausedMs += Date.now() - pauseStartedAt;
      pauseStartedAt = undefined;
      if (pausedMs > CODE_LIMITS.maxPauseMs) {
        finish(new Error("Code execution waited too long for user input"));
        return;
      }
      effectiveDeadline = deadline + pausedMs;
      const remaining = effectiveDeadline - Date.now();
      if (remaining <= 0) {
        finish(new Error("Code execution timed out"));
        return;
      }
      post({ type: "deadline", deadline: effectiveDeadline });
      timer = setTimeout(() => finish(new Error("Code execution timed out")), remaining);
    }

    function drain(): void {
      while (!closed && !signal.aborted && Date.now() < effectiveDeadline) {
        const request = queue[0];
        if (!request || serialRunning || running >= CODE_LIMITS.parallelCalls) return;
        if (request.serial && running > 0) return;
        queue.shift();
        if (request.pause) {
          const remainingPause = CODE_LIMITS.maxPauseMs - pausedMs;
          if (remainingPause <= 0) {
            finish(new Error("Code execution waited too long for user input"));
            return;
          }
          pauseStartedAt = Date.now();
          if (timer) clearTimeout(timer);
          timer = setTimeout(
            () => finish(new Error("Code execution waited too long for user input")),
            remainingPause,
          );
          post({ type: "deadline", deadline: pauseStartedAt + remainingPause });
        }
        running++;
        serialRunning = request.serial;
        if (request.toolName) dispatchedTools.push(request.toolName);
        let replied = false;
        let callTimer: ReturnType<typeof setTimeout> | undefined;
        if (request.timeoutMs !== undefined) {
          const remaining = Math.max(1, effectiveDeadline - Date.now());
          const limitMs = Math.max(1, Math.min(request.timeoutMs, remaining));
          callTimer = setTimeout(() => {
            if (callTimer) callTimers.delete(callTimer);
            if (replied || closed) return;
            replied = true;
            const label = request.toolName ? `Tool call "${request.toolName}"` : "Tool call";
            const message = `${label} timed out after ${limitMs}ms`;
            post({
              type: "reply",
              id: request.id,
              payload: request.envelope
                ? envelopeErrorPayload("TIMEOUT", message)
                : errorPayload(message),
            });
          }, limitMs);
          callTimers.add(callTimer);
        }
        const clearCallTimer = () => {
          if (!callTimer) return;
          clearTimeout(callTimer);
          callTimers.delete(callTimer);
          callTimer = undefined;
        };
        void request
          .dispatch(workerAbort.signal)
          .then(
            (payload) => {
              if (request.pause) resumeClock();
              clearCallTimer();
              if (closed || replied) return;
              replied = true;
              replyBytes += Buffer.byteLength(payload);
              if (replyBytes > CODE_LIMITS.totalResponseBytes) {
                finish(new Error("Code execution exceeded its tool response budget"));
                return;
              }
              post({ type: "reply", id: request.id, payload });
            },
            () => {
              if (request.pause) resumeClock();
              clearCallTimer();
              if (closed || replied) return;
              replied = true;
              post({
                type: "reply",
                id: request.id,
                payload: request.envelope
                  ? envelopeErrorPayload("TOOL_ERROR", "Tool request failed")
                  : errorPayload("Tool request failed"),
              });
            },
          )
          .finally(() => {
            clearCallTimer();
            running--;
            serialRunning = false;
            if (!closed) drain();
            else if (running === 0) activeExecutions--;
          });
      }
    }

    timer = setTimeout(() => finish(new Error("Code execution timed out")), timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    worker.addEventListener("error", () => finish(new Error("Code worker failed to start or run")));
    worker.addEventListener("message", ({ data }: MessageEvent<WorkerOutput>) => {
      if (closed) return;
      if (pauseStartedAt === undefined && Date.now() >= effectiveDeadline)
        return finish(new Error("Code execution timed out"));
      switch (data.type) {
        case "ready":
          post({
            type: "start",
            code,
            deadline,
            ...(embeddedWorker ? { wasm: embeddedWorker.wasm } : {}),
          });
          break;
        case "failure":
          finish(new Error(data.message));
          break;
        case "done":
          finish(data.output);
          break;
        case "request":
          if (++requests > CODE_LIMITS.requests) {
            finish(new Error("Code execution exceeded its tool request limit"));
            return;
          }
          try {
            queue.push({ ...prepare(data.payload), id: data.id });
            drain();
          } catch (error) {
            const message =
              error instanceof Error ? error.message.slice(0, 512) : "Invalid tool request";
            post({
              type: "reply",
              id: data.id,
              payload: isCallPayload(data.payload)
                ? envelopeErrorPayload("INVALID_ARGS", message)
                : errorPayload(message),
            });
          }
          break;
      }
    });
  });
}
