export async function readLines(
  stream: ReadableStream<Uint8Array> | number,
  onLine: (line: string) => void,
): Promise<void> {
  if (typeof stream === "number") return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    }
    if (buf.trim()) onLine(buf);
  } finally {
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
