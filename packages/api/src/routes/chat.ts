import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackend, hasBackend } from "@orc/agent-runtime";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type ChatRequestBody = {
  messages: ChatMessage[];
  agent?: string;
  system?: string;
  autoApprove?: boolean;
};

type AcpxJsonRpc = {
  jsonrpc?: string;
  id?: number;
  method?: string;
  result?: { stopReason?: string };
  error?: { message?: string };
  params?: {
    update?: {
      sessionUpdate?: string;
      content?:
        | { type?: string; text?: string }
        | Array<{ type?: string; content?: { type?: string; text?: string } }>;
    };
  };
};

function buildMockReply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const content = lastUser?.content.trim() ?? "";
  const exactReply = content.match(/Reply with exactly:\s*([^.?!\n]+)[.?!]?/i);
  return exactReply?.[1]?.trim() || content || "ok";
}

function parseTextFromLine(line: string): string | null {
  let msg: AcpxJsonRpc;
  try {
    msg = JSON.parse(line) as AcpxJsonRpc;
  } catch {
    return null;
  }
  if (msg.error) return `[Error] ${msg.error.message ?? "Unknown error"}`;
  if (msg.method === "session/update" && msg.params?.update) {
    const u = msg.params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content) {
      if (!Array.isArray(u.content)) {
        if (u.content.type === "text" && u.content.text) return u.content.text;
      } else {
        const texts: string[] = [];
        for (const item of u.content) {
          if (item.content?.type === "text" && item.content.text) texts.push(item.content.text);
        }
        if (texts.length > 0) return texts.join("");
      }
    }
  }
  return null;
}

function buildPrompt(
  messages: Array<{ role: string; content: string }>,
  systemPrompt?: string,
): string {
  const parts: string[] = [];
  if (systemPrompt) {
    parts.push(`<system>\n${systemPrompt}\n</system>\n`);
  }
  for (const msg of messages) {
    if (msg.role === "user") parts.push(`<user>\n${msg.content}\n</user>\n`);
    else if (msg.role === "assistant") parts.push(`<assistant>\n${msg.content}\n</assistant>\n`);
  }
  return parts.join("\n");
}

async function readLines(
  readable: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = readable.getReader();
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

const app = new Hono();

app.post("/chat/stream", async (c) => {
  const body = (await c.req.json()) as ChatRequestBody;
  const messages = body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "messages array is required and must not be empty" }, 400);
  }

  const agent = body.agent ?? "claude";
  // Whitelist-style validation - `agent` is passed as an argv element to acpx,
  // so a value like "--help" or "-v" would be interpreted as a flag. Reject
  // anything that isn't a plain identifier.
  if (!/^[a-z][a-z0-9-]{0,31}$/i.test(agent)) {
    return c.json({ error: "invalid agent name" }, 400);
  }
  const systemPrompt = body.system;
  const autoApprove = body.autoApprove ?? true;

  if (process.env.ORC_E2E_CHAT_MOCK === "1") {
    const text = buildMockReply(messages);
    return streamSSE(c, async (s) => {
      await s.writeSSE({ data: JSON.stringify({ type: "open" }) });
      await Bun.sleep(75);
      await s.writeSSE({ data: JSON.stringify({ type: "text", text }) });
      await Bun.sleep(75);
      await s.writeSSE({ data: JSON.stringify({ type: "done" }) });
    });
  }

  const acpxPath = Bun.which("acpx");
  const prompt = buildPrompt(messages, systemPrompt);

  // When acpx is not available (e.g. running in Docker), fall back to the
  // first available registered backend: agentapi → claude.
  if (!acpxPath) {
    const fallback = ["agentapi", "claude"].find(hasBackend);
    if (!fallback) {
      return c.json(
        { error: "No agent backend available (acpx not on PATH, agentapi/claude not configured)" },
        503,
      );
    }
    return streamSSE(c, async (s) => {
      await s.writeSSE({ data: JSON.stringify({ type: "open" }) });
      try {
        const backend = createBackend(fallback);
        const session = await backend.startSession({ cwd: process.cwd(), autoApprove });
        await session.send(prompt);
        for await (const event of session.events()) {
          if (event.type === "text") {
            await s.writeSSE({ data: JSON.stringify({ type: "text", text: event.data }) });
          } else if (event.type === "error") {
            await s.writeSSE({ data: JSON.stringify({ type: "error", message: event.data }) });
          } else if (event.type === "result") {
            break;
          }
        }
        await session.close().catch(() => {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await s.writeSSE({ data: JSON.stringify({ type: "error", message }) });
      }
      await s.writeSSE({ data: JSON.stringify({ type: "done" }) });
    });
  }

  // On Windows, Bun.which returns a `.cmd` shim that wraps `node cli.js`. Driving
  // stdin/stdout through the cmd.exe wrapper is unreliable under Bun.spawn, so
  // resolve to the underlying `cli.js` and invoke node directly when possible.
  let spawnBin = acpxPath;
  const spawnPrefix: string[] = [];
  if (process.platform === "win32" && acpxPath.toLowerCase().endsWith(".cmd")) {
    const cliJs = join(dirname(acpxPath), "node_modules", "acpx", "dist", "cli.js");
    const nodeExe = Bun.which("node");
    if (nodeExe && existsSync(cliJs)) {
      spawnBin = nodeExe;
      spawnPrefix.push(cliJs);
    }
  }

  return streamSSE(c, async (s) => {
    const args = [
      spawnBin,
      ...spawnPrefix,
      "--format",
      "json",
      ...(autoApprove ? ["--approve-all"] : []),
      agent,
      "exec",
      "-f",
      "-",
    ];

    console.log("[chat] spawning acpx:", args.join(" "));

    const proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    let aborted = false;
    const cleanup = () => {
      if (aborted) return;
      aborted = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    };
    s.onAbort(cleanup);
    c.req.raw.signal.addEventListener("abort", cleanup);

    // Drain stderr into server logs so failures are visible (not silently hung).
    const stderrTask = readLines(proc.stderr as ReadableStream<Uint8Array>, (line) => {
      console.error("[chat] acpx stderr:", line);
    }).catch(() => undefined);

    // Write the prompt and await the write before closing stdin, otherwise the
    // Bun stdin pipe can be closed before bytes are flushed.
    try {
      const bytes = new TextEncoder().encode(prompt);
      // Bun's stdin is a FileSink - use its write/flush/end API directly.
      const sink = proc.stdin as unknown as {
        write: (chunk: Uint8Array | string) => number | Promise<number>;
        end: () => void | Promise<void>;
        flush?: () => void | Promise<void>;
      };
      await Promise.resolve(sink.write(bytes));
      if (sink.flush) await Promise.resolve(sink.flush());
      await Promise.resolve(sink.end());
    } catch (err) {
      const message = err instanceof Error ? err.message : "stdin write failed";
      console.error("[chat] stdin error:", message);
      await s.writeSSE({ data: JSON.stringify({ type: "error", message }) });
      cleanup();
      await s.writeSSE({ data: JSON.stringify({ type: "done" }) });
      return;
    }

    // Send an opening ping immediately so the client knows the stream is alive
    // (proxies won't buffer; user sees activity before acpx produces text).
    await s.writeSSE({ data: JSON.stringify({ type: "open" }) });

    try {
      await readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
        const text = parseTextFromLine(line);
        if (text !== null) {
          void s.writeSSE({ data: JSON.stringify({ type: "text", text }) });
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown streaming error";
      console.error("[chat] stdout read error:", message);
      await s.writeSSE({ data: JSON.stringify({ type: "error", message }) });
    }

    await stderrTask;
    const exitCode = await proc.exited;
    if (exitCode !== 0 && !aborted) {
      await s.writeSSE({
        data: JSON.stringify({ type: "error", message: `acpx exited with code ${exitCode}` }),
      });
    }

    await s.writeSSE({ data: JSON.stringify({ type: "done" }) });
  });
});

export { app as chatRouter };
