export async function readLines(
  stream: ReadableStream<Uint8Array> | number,
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof stream === "number" || signal?.aborted) return;
  const reader = stream.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || signal?.aborted) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    }
    if (buf.trim() && !signal?.aborted) onLine(buf);
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function writeToStdin(
  stdin: import("bun").FileSink | number | undefined,
  data: Uint8Array,
): void {
  if (!stdin || typeof stdin === "number") return;
  stdin.write(data);
}

export function endStdin(stdin: import("bun").FileSink | number | undefined): void {
  if (!stdin || typeof stdin === "number") return;
  stdin.end();
}

/** How long an exited process's pipes may stay open, e.g. held by a leftover grandchild. */
export const STREAM_DRAIN_TIMEOUT_MS = 2000;

type OutputStream = ReadableStream<Uint8Array> | number | null | undefined;

export interface ProcessOutputHandlers {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** A pipe failed mid-read; lines already delivered stay delivered. */
  onError?: (err: unknown, stream: "stdout" | "stderr") => void;
}

/**
 * Reads a child's stdout and stderr line by line. The returned `drain` waits until both
 * end, but gives up after `timeoutMs` and cancels the readers, so a leftover grandchild
 * holding the pipes can neither stall the caller nor feed lines into a later turn.
 * Cancelling closes our end, so such a child gets EPIPE if it writes afterwards.
 */
export function readProcessOutput(
  proc: { stdout?: OutputStream; stderr?: OutputStream },
  handlers: ProcessOutputHandlers,
): (timeoutMs?: number) => Promise<void> {
  const readers = new AbortController();
  const read = (name: "stdout" | "stderr") => {
    const stream = proc[name];
    const onLine = handlers[name];
    if (!stream || !onLine) return Promise.resolve();
    return readLines(stream, onLine, readers.signal).catch((err) => handlers.onError?.(err, name));
  };
  const finished = Promise.all([read("stdout"), read("stderr")]);
  return async (timeoutMs = STREAM_DRAIN_TIMEOUT_MS) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([finished, timeout]);
    clearTimeout(timer);
    readers.abort();
  };
}
