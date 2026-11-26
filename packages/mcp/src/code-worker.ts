import type { WorkerInput, WorkerOutput } from "./code-protocol.js";
import { executeCode } from "./code-sandbox.js";

declare const self: {
  postMessage(message: WorkerOutput): void;
  addEventListener(type: "message", handler: (event: MessageEvent<WorkerInput>) => void): void;
};

const pending = new Map<number, (payload: string) => void>();
let nextId = 0;
// Elicitation pauses the wall clock; the runner extends this before resuming.
let activeDeadline = 0;

function send(message: WorkerOutput): void {
  self.postMessage(message);
}

self.addEventListener("message", (event: MessageEvent<WorkerInput>) => {
  const message = event.data;
  if (message.type === "reply") {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.payload);
    return;
  }
  if (message.type === "deadline") {
    activeDeadline = message.deadline;
    return;
  }
  activeDeadline = message.deadline;
  void executeCode(
    message.code,
    () => activeDeadline,
    (payload) => {
      const id = ++nextId;
      return new Promise<string>((resolve) => {
        pending.set(id, resolve);
        send({ type: "request", id, payload });
      });
    },
    message.wasm,
  ).then(
    (output) => send({ type: "done", output }),
    (error: unknown) => {
      const messageText = error instanceof Error ? error.message.slice(0, 512) : "Script failed";
      send({ type: "failure", message: messageText });
    },
  );
});

send({ type: "ready" });
