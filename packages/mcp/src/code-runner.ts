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

interface CodeRequest {
  serial: boolean;
  toolName?: string;
  dispatch(): Promise<string>;
}

function errorPayload(error: string): string {
  return JSON.stringify({ error });
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
    let running = 0;
    let serialRunning = false;
    let requests = 0;
    let replyBytes = 0;
    const dispatchedTools: string[] = [];
    let closed = false;

    function finish(result: CodeOutput | Error): void {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
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

    function drain(): void {
      while (!closed && !signal.aborted && Date.now() < deadline) {
        const request = queue[0];
        if (!request || serialRunning || running >= CODE_LIMITS.parallelCalls) return;
        if (request.serial && running > 0) return;
        queue.shift();
        running++;
        serialRunning = request.serial;
        if (request.toolName) dispatchedTools.push(request.toolName);
        void request
          .dispatch()
          .then(
            (payload) => {
              if (closed) return;
              replyBytes += Buffer.byteLength(payload);
              if (replyBytes > CODE_LIMITS.totalResponseBytes) {
                finish(new Error("Code execution exceeded its tool response budget"));
                return;
              }
              post({ type: "reply", id: request.id, payload });
            },
            () =>
              post({ type: "reply", id: request.id, payload: errorPayload("Tool request failed") }),
          )
          .finally(() => {
            running--;
            serialRunning = false;
            if (!closed) drain();
            else if (running === 0) activeExecutions--;
          });
      }
    }

    const timer = setTimeout(() => finish(new Error("Code execution timed out")), timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    worker.addEventListener("error", () => finish(new Error("Code worker failed to start or run")));
    worker.addEventListener("message", ({ data }: MessageEvent<WorkerOutput>) => {
      if (closed) return;
      if (Date.now() >= deadline) return finish(new Error("Code execution timed out"));
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
          } catch {
            post({ type: "reply", id: data.id, payload: errorPayload("Invalid tool request") });
          }
          break;
      }
    });
  });
}
