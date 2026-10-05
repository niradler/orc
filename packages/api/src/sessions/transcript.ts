import { statSync } from "node:fs";
import { GeminiSession, geminiText } from "./gemini.js";

export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; name: string; input: string; id?: string; result?: string }
  | { type: "tool_result"; text: string; forId?: string };

export type TranscriptTurn = {
  index: number;
  role: "user" | "assistant" | "tool" | "system";
  time: string | null;
  blocks: TranscriptBlock[];
};

export type TranscriptPage = {
  total: number;
  offset: number;
  turns: TranscriptTurn[];
  matches: number[];
};

export const MAX_TRANSCRIPT_BYTES = 150 * 1024 * 1024;
const TEXT_MAX = 20_000;
const TOOL_INPUT_MAX = 2_000;
const TOOL_RESULT_MAX = 4_000;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more characters]` : text;

async function* jsonLines(path: string): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let tail = "";
  const parse = (line: string) => {
    if (!line.trim()) return null;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  for await (const chunk of Bun.file(path).stream()) {
    const lines = (tail + decoder.decode(chunk, { stream: true })).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const parsed = parse(line);
      if (parsed) yield parsed;
    }
  }
  const parsed = parse(tail);
  if (parsed) yield parsed;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : ((b as { text?: string }).text ?? "")))
      .filter(Boolean)
      .join("\n");
  }
  return stringify(content);
}

type RawBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  id?: string;
  tool_use_id?: string;
};

function anthropicBlocks(content: unknown): TranscriptBlock[] {
  if (typeof content === "string") return [{ type: "text", text: cut(content, TEXT_MAX) }];
  if (!Array.isArray(content)) return [];
  const out: TranscriptBlock[] = [];
  for (const raw of content as RawBlock[]) {
    if (raw.type === "text" && raw.text) out.push({ type: "text", text: cut(raw.text, TEXT_MAX) });
    else if (raw.type === "thinking" && raw.thinking)
      out.push({ type: "thinking", text: cut(raw.thinking, TEXT_MAX) });
    else if (raw.type === "tool_use")
      out.push({
        type: "tool_use",
        name: raw.name ?? "tool",
        input: cut(stringify(raw.input), TOOL_INPUT_MAX),
        ...(raw.id ? { id: raw.id } : {}),
      });
    else if (raw.type === "tool_result")
      out.push({
        type: "tool_result",
        text: cut(resultText(raw.content), TOOL_RESULT_MAX),
        ...(raw.tool_use_id ? { forId: raw.tool_use_id } : {}),
      });
  }
  return out;
}

const isSystemText = (text: string) =>
  /^\s*<(system-reminder|command-|local-command|environment_context|user_instructions)/.test(
    text,
  ) || /^\s*<([a-z][\w-]*)[\s>][\s\S]*<\/\1>\s*$/.test(text);
type Draft = {
  role: TranscriptTurn["role"];
  time: string | null;
  blocks: TranscriptBlock[];
  key?: string;
};

async function* claudeTurns(path: string): AsyncGenerator<Draft> {
  for await (const line of jsonLines(path)) {
    const type = line.type;
    if ((type !== "user" && type !== "assistant") || line.isMeta) continue;
    const message = line.message as { id?: string; content?: unknown } | undefined;
    const blocks = anthropicBlocks(message?.content);
    if (blocks.length === 0) continue;
    const time = (line.timestamp as string | undefined) ?? null;
    if (type === "assistant") {
      yield { role: "assistant", time, blocks, ...(message?.id ? { key: message.id } : {}) };
      continue;
    }
    const onlyResults = blocks.every((b) => b.type === "tool_result");
    const systemish = blocks.every((b) => b.type === "text" && isSystemText(b.text));
    yield { role: onlyResults ? "tool" : systemish ? "system" : "user", time, blocks };
  }
}

async function* codexTurns(path: string): AsyncGenerator<Draft> {
  for await (const line of jsonLines(path)) {
    if (line.type !== "response_item") continue;
    const p = line.payload as Record<string, unknown> | undefined;
    if (!p) continue;
    const time = (line.timestamp as string | undefined) ?? null;
    const kind = String(p.type ?? "");
    if (kind === "message") {
      const role = p.role === "assistant" ? "assistant" : p.role === "user" ? "user" : null;
      if (!role) continue;
      const text = ((p.content as { text?: string }[] | undefined) ?? [])
        .map((b) => b.text ?? "")
        .filter(Boolean)
        .join("\n");
      if (!text) continue;
      yield {
        role: role === "user" && isSystemText(text) ? "system" : role,
        time,
        blocks: [{ type: "text", text: cut(text, TEXT_MAX) }],
      };
    } else if (kind === "reasoning") {
      const summary = ((p.summary as { text?: string }[] | undefined) ?? [])
        .map((b) => b.text ?? "")
        .filter(Boolean)
        .join("\n");
      if (summary)
        yield {
          role: "assistant",
          time,
          blocks: [{ type: "thinking", text: cut(summary, TEXT_MAX) }],
        };
    } else if (kind.endsWith("_call_output")) {
      const out = (p.output as { output?: unknown } | string | undefined) ?? "";
      const text =
        typeof out === "string" ? out : resultText((out as { output?: unknown }).output ?? out);
      yield {
        role: "tool",
        time,
        blocks: [
          {
            type: "tool_result",
            text: cut(text, TOOL_RESULT_MAX),
            ...(p.call_id ? { forId: String(p.call_id) } : {}),
          },
        ],
      };
    } else if (kind.endsWith("_call")) {
      yield {
        role: "assistant",
        time,
        blocks: [
          {
            type: "tool_use",
            name: String(p.name ?? kind),
            input: cut(stringify(p.arguments ?? p.action ?? p.input ?? ""), TOOL_INPUT_MAX),
            ...(p.call_id ? { id: String(p.call_id) } : {}),
          },
        ],
      };
    }
  }
}

function stripCursorWrappers(text: string): string {
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
  return (query?.[1] ?? text).replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/g, "").trim();
}

async function* cursorTurns(path: string): AsyncGenerator<Draft> {
  for await (const line of jsonLines(path)) {
    if (line.role !== "user" && line.role !== "assistant") continue;
    const message = line.message as { content?: unknown } | undefined;
    const blocks = anthropicBlocks(message?.content).map((b) =>
      b.type === "text" && line.role === "user" ? { ...b, text: stripCursorWrappers(b.text) } : b,
    );
    if (blocks.length === 0) continue;
    const onlyResults = blocks.every((b) => b.type === "tool_result");
    yield {
      role: onlyResults ? "tool" : line.role,
      time: typeof line.timestamp === "string" ? line.timestamp : null,
      blocks,
    };
  }
}

async function* geminiTurns(path: string): AsyncGenerator<Draft> {
  if (path.endsWith(".jsonl")) {
    yield* cursorTurns(path);
    return;
  }
  const data = GeminiSession.parse(await Bun.file(path).json());
  for (const message of data.messages) {
    const blocks: TranscriptBlock[] = [];
    const text = geminiText(message.content);
    if (text) blocks.push({ type: "text", text: cut(text, TEXT_MAX) });
    for (const tool of message.toolCalls ?? []) {
      blocks.push({
        type: "tool_use",
        id: tool.id,
        name: tool.name,
        input: cut(stringify(tool.args), TOOL_INPUT_MAX),
        ...(tool.result != null
          ? { result: cut(geminiText(tool.result) || stringify(tool.result), TOOL_RESULT_MAX) }
          : {}),
      });
    }
    if (blocks.length)
      yield {
        role: message.type === "user" ? "user" : message.type === "gemini" ? "assistant" : "system",
        time: message.timestamp ?? null,
        blocks,
      };
  }
}

const readers: Record<string, (path: string) => AsyncGenerator<Draft>> = {
  claude: claudeTurns,
  codex: codexTurns,
  cursor: cursorTurns,
  "cursor-agent": cursorTurns,
  gemini: geminiTurns,
};

type ToolUse = Extract<TranscriptBlock, { type: "tool_use" }>;

function pairToolCalls(turns: TranscriptTurn[]): TranscriptTurn[] {
  const calls = new Map<string, ToolUse>();
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type === "tool_use" && block.id) calls.set(block.id, block);
    }
  }
  for (const turn of turns) {
    if (turn.role !== "tool") continue;
    turn.blocks = turn.blocks.filter((block) => {
      const call = block.type === "tool_result" && block.forId ? calls.get(block.forId) : undefined;
      if (!call || block.type !== "tool_result") return true;
      call.result = block.text;
      return false;
    });
  }
  return turns.filter((turn) => turn.blocks.length > 0).map((turn, index) => ({ ...turn, index }));
}

const PARSE_CACHE_SIZE = 4;
const parseCache = new Map<string, { stamp: string; turns: TranscriptTurn[] }>();

async function parseTranscript(path: string, backend: string): Promise<TranscriptTurn[]> {
  const reader = readers[backend];
  if (!reader) throw new Error(`No transcript reader for ${backend}`);
  const st = statSync(path);
  if (st.size > MAX_TRANSCRIPT_BYTES) throw new Error("Transcript is too large to render");
  const stamp = `${st.mtimeMs}:${st.size}`;
  const cached = parseCache.get(path);
  if (cached?.stamp === stamp) return cached.turns;

  const turns: TranscriptTurn[] = [];
  let lastKey: string | undefined;
  for await (const draft of reader(path)) {
    const prev = turns[turns.length - 1];
    if (draft.key && prev && lastKey === draft.key && prev.role === "assistant") {
      prev.blocks.push(...draft.blocks);
    } else {
      turns.push({
        index: turns.length,
        role: draft.role,
        time: draft.time,
        blocks: [...draft.blocks],
      });
      lastKey = draft.key;
    }
  }
  const paired = pairToolCalls(turns);
  parseCache.delete(path);
  parseCache.set(path, { stamp, turns: paired });
  if (parseCache.size > PARSE_CACHE_SIZE) {
    parseCache.delete(parseCache.keys().next().value as string);
  }
  return paired;
}

export async function readTranscript(
  path: string,
  backend: string,
  opts: { offset?: number; limit?: number; q?: string | undefined } = {},
): Promise<TranscriptPage> {
  const turns = await parseTranscript(path, backend);
  const needle = opts.q?.trim().toLowerCase();
  const matches: number[] = [];
  if (needle) {
    for (const turn of turns) {
      const text = turn.blocks
        .map((b) => (b.type === "tool_use" ? `${b.name} ${b.input} ${b.result ?? ""}` : b.text))
        .join("\n")
        .toLowerCase();
      if (text.includes(needle)) matches.push(turn.index);
    }
  }
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return { total: turns.length, offset, turns: turns.slice(offset, offset + limit), matches };
}
