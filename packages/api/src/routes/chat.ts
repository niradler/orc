import { Hono } from "hono";
import { stream } from "hono/streaming";

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
  const systemPrompt = body.system;
  const autoApprove = body.autoApprove ?? true;

  const acpxPath = Bun.which("acpx");
  if (!acpxPath) {
    return c.json({ error: "acpx CLI not found on PATH" }, 503);
  }

  const prompt = buildPrompt(messages, systemPrompt);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");

  return stream(c, async (s) => {
    const args = [acpxPath, "--format", "json", ...(autoApprove ? ["--approve-all"] : []), agent, "exec", "-f", "-"];
    const proc = Bun.spawn(args, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    s.onAbort(() => {
      proc.kill();
    });

    c.req.raw.signal.addEventListener("abort", () => {
      proc.kill();
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    try {
      await readLines(proc.stdout as ReadableStream<Uint8Array>, (line) => {
        const text = parseTextFromLine(line);
        if (text !== null) {
          s.write(`data: ${JSON.stringify({ type: "text", text })}\n\n`);
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown streaming error";
      s.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
    }

    s.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  });
});

export { app as chatRouter };
