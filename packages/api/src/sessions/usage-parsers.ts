export type UsageEventInput = {
  key: string;
  ts: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  otherTokens: number;
  estimated: boolean;
};

export type ParsedUsage = {
  events: UsageEventInput[];
  tokens: number;
  model: string | null;
};

type Json = Record<string, unknown>;

function count(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function timestamp(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
}

export function eventTotal(event: UsageEventInput): number {
  return (
    event.inputTokens +
    event.outputTokens +
    event.cacheReadTokens +
    event.cacheWriteTokens +
    event.reasoningTokens +
    event.otherTokens
  );
}

function finish(events: UsageEventInput[], fallbackModel: string | null): ParsedUsage {
  const unique = new Map<string, UsageEventInput>();
  for (const event of events) {
    if (eventTotal(event) <= 0) continue;
    unique.set(event.key, event);
  }
  const kept = [...unique.values()].sort((a, b) => a.ts - b.ts);
  return {
    events: kept,
    tokens: kept.reduce((sum, event) => sum + eventTotal(event), 0),
    model: [...kept].reverse().find((event) => event.model)?.model ?? fallbackModel,
  };
}

function emptyEvent(key: string, ts: number): UsageEventInput {
  return {
    key,
    ts,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    otherTokens: 0,
    estimated: false,
  };
}

/** Claude stores one usage record per assistant message in the transcript JSONL. */
export function parseClaudeUsage(content: string, fallbackTs = 0): ParsedUsage {
  const seen = new Set<string>();
  const events: UsageEventInput[] = [];
  let model: string | null = null;
  let index = 0;
  for (const line of content.split("\n")) {
    index += 1;
    if (!line.includes('"usage"')) continue;
    let parsed: Json;
    try {
      parsed = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const message = parsed.message as Json | undefined;
    const usage = message?.usage as Json | undefined;
    if (!message || !usage) continue;
    const id = text(message.id) ?? `claude-${index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const outputDetails = usage.output_tokens_details as Json | undefined;
    const reasoning = count(outputDetails?.thinking_tokens);
    const output = count(usage.output_tokens);
    const event = emptyEvent(id, timestamp(parsed.timestamp, fallbackTs));
    event.model = text(message.model);
    event.inputTokens = count(usage.input_tokens);
    event.outputTokens = Math.max(0, output - reasoning);
    event.reasoningTokens = Math.min(output, reasoning);
    event.cacheReadTokens = count(usage.cache_read_input_tokens);
    event.cacheWriteTokens = count(usage.cache_creation_input_tokens);
    model = event.model ?? model;
    events.push(event);
  }
  return finish(events, model);
}

/**
 * Codex records per-turn usage as `token_count` events. `last_token_usage` is that
 * turn's delta; cached input is inside `input_tokens`, and with reasoning enabled
 * `output_tokens` includes `reasoning_output_tokens`.
 */
export function parseCodexUsage(
  content: string,
  expectedTokens: number | null,
  fallbackTs = 0,
): ParsedUsage {
  const events: UsageEventInput[] = [];
  let model: string | null = null;
  let index = 0;
  for (const line of content.split("\n")) {
    index += 1;
    if (!line.includes('"model"') && !line.includes('"token_count"')) continue;
    let parsed: Json;
    try {
      parsed = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const payload = parsed.payload as Json | undefined;
    if (parsed.type === "session_meta" || parsed.type === "turn_context") {
      const settings = payload?.settings as Json | undefined;
      model = text(payload?.model) ?? text(settings?.model) ?? model;
      continue;
    }
    if (parsed.type !== "event_msg" || payload?.type !== "token_count") continue;
    const info = payload.info as Json | undefined;
    const last = info?.last_token_usage as Json | undefined;
    if (!last) continue;
    const input = count(last.input_tokens);
    const cached = Math.min(input, count(last.cached_input_tokens));
    const output = count(last.output_tokens);
    const reasoning = count(last.reasoning_output_tokens);
    const includesReasoning = info?.last_usage_includes_reasoning !== false;
    const event = emptyEvent(`codex-${index}`, timestamp(parsed.timestamp, fallbackTs));
    event.model = model;
    event.inputTokens = Math.max(0, input - cached);
    event.cacheReadTokens = cached;
    event.cacheWriteTokens = count(last.cache_write_input_tokens);
    event.outputTokens = includesReasoning ? Math.max(0, output - reasoning) : output;
    event.reasoningTokens = includesReasoning ? Math.min(output, reasoning) : reasoning;
    const reported = count(last.total_tokens);
    const split = eventTotal(event);
    if (reported > split) event.otherTokens = reported - split;
    events.push(event);
  }
  const parsed = finish(events, model);
  const expected = count(expectedTokens);
  if (expected > parsed.tokens) {
    const remainder = emptyEvent("remainder", fallbackTs || Date.now());
    remainder.otherTokens = expected - parsed.tokens;
    remainder.estimated = true;
    parsed.events.push(remainder);
    parsed.tokens = expected;
  }
  return parsed;
}

type PiEntry = {
  id?: unknown;
  timestamp?: unknown;
  message?:
    | {
        role?: unknown;
        model?: unknown;
        timestamp?: unknown;
        usage?:
          | {
              input?: unknown;
              output?: unknown;
              cacheRead?: unknown;
              cacheWrite?: unknown;
              reasoning?: unknown;
              totalTokens?: unknown;
            }
          | undefined;
      }
    | undefined;
};

/** Pi reports usage on each assistant message in the active branch. */
export function parsePiUsage(entries: readonly PiEntry[], fallbackTs = 0): ParsedUsage {
  const events: UsageEventInput[] = [];
  let model: string | null = null;
  let index = 0;
  for (const entry of entries) {
    index += 1;
    const message = entry.message;
    if (message?.role !== "assistant" || !message.usage) continue;
    const usage = message.usage;
    const event = emptyEvent(
      text(entry.id) ?? `pi-${index}`,
      timestamp(entry.timestamp, timestamp(message.timestamp, fallbackTs)),
    );
    event.model = text(message.model);
    event.inputTokens = count(usage.input);
    event.outputTokens = count(usage.output);
    event.cacheReadTokens = count(usage.cacheRead);
    event.cacheWriteTokens = count(usage.cacheWrite);
    event.reasoningTokens = count(usage.reasoning);
    const reported = count(usage.totalTokens);
    const split = eventTotal(event);
    if (reported > split) event.otherTokens = reported - split;
    model = event.model ?? model;
    events.push(event);
  }
  return finish(events, model);
}

/** Gemini exposes a single per-message total, not an input/output split. */
export function parseGeminiUsage(
  messages: readonly {
    timestamp?: string | undefined;
    tokens?: { total: number } | null | undefined;
  }[],
  fallbackTs = 0,
): ParsedUsage {
  const events: UsageEventInput[] = [];
  messages.forEach((message, index) => {
    const total = count(message.tokens?.total);
    if (total <= 0) return;
    const event = emptyEvent(`gemini-${index}`, timestamp(message.timestamp, fallbackTs));
    event.otherTokens = total;
    event.estimated = true;
    events.push(event);
  });
  return finish(events, null);
}

export type OpenCodeMessageRow = {
  id: string;
  data: string;
  time_created?: number | null;
};

/** OpenCode 2.2+ keeps per-assistant usage and model inline in `session_message.data`. */
export function parseOpenCodeUsage(rows: readonly OpenCodeMessageRow[]): ParsedUsage {
  const events: UsageEventInput[] = [];
  let model: string | null = null;
  for (const row of rows) {
    let data: Json;
    try {
      data = JSON.parse(row.data) as Json;
    } catch {
      continue;
    }
    const tokens = data.tokens as Json | undefined;
    if (!tokens) continue;
    const cache = tokens.cache as Json | undefined;
    const modelInfo = data.model as Json | undefined;
    const provider = text(modelInfo?.providerID);
    const id = text(modelInfo?.id) ?? text(modelInfo?.modelID);
    const time = data.time as Json | undefined;
    const event = emptyEvent(row.id, timestamp(time?.created, row.time_created ?? 0));
    event.model = id ? (provider ? `${provider}/${id}` : id) : null;
    event.inputTokens = count(tokens.input);
    event.outputTokens = count(tokens.output);
    event.reasoningTokens = count(tokens.reasoning);
    event.cacheReadTokens = count(cache?.read);
    event.cacheWriteTokens = count(cache?.write);
    model = event.model ?? model;
    events.push(event);
  }
  return finish(events, model);
}
