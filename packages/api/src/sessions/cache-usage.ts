import { OrcError } from "@orc/core/errors";
import type { HostRuntime } from "@orc/core/exec-host";
import type { CacheTokenUsage, SessionCacheUsage } from "@orc/core/usage";
import { z } from "zod";
import { parsePiSession } from "./pi.js";
import { MAX_TRANSCRIPT_BYTES } from "./transcript.js";
import { parseOpenCodeUsage } from "./usage-parsers.js";

const Count = z.number().int().nonnegative();
const ClaudeUsage = z.object({
  input_tokens: Count,
  output_tokens: Count.optional(),
  cache_read_input_tokens: Count,
  cache_creation_input_tokens: Count,
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: Count.optional(),
      ephemeral_1h_input_tokens: Count.optional(),
    })
    .optional(),
});
const CodexUsage = z
  .object({
    input_tokens: Count,
    cached_input_tokens: Count,
    cache_write_input_tokens: Count.optional(),
    output_tokens: Count.optional(),
    total_tokens: Count.optional(),
  })
  .refine(
    (value) =>
      value.cached_input_tokens + (value.cache_write_input_tokens ?? 0) <= value.input_tokens,
  );

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/** Only a provider that recorded this literal reason is trusted; timing is never a substitute. */
function recordedTrigger(value: unknown): "manual" | "auto" | null {
  return value === "manual" || value === "auto" ? value : null;
}

function parsedObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return object(value);
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function codexTokens(value: z.infer<typeof CodexUsage>): CacheTokenUsage {
  return {
    input_tokens: value.input_tokens,
    cached_input_tokens: value.cached_input_tokens,
    cache_write_tokens: value.cache_write_input_tokens ?? null,
  };
}

export async function loadSessionCacheUsage(
  runtime: Pick<HostRuntime, "isFile" | "readFile"> & Partial<Pick<HostRuntime, "sqliteQuery">>,
  backend: string,
  path: string,
  externalId: string | null = null,
): Promise<SessionCacheUsage> {
  try {
    if (!(await runtime.isFile(path))) return emptySessionCacheUsage();
    if (backend === "opencode") {
      if (!externalId || !runtime.sqliteQuery) return emptySessionCacheUsage();
      return await readOpenCodeCacheUsage(
        runtime as Pick<HostRuntime, "sqliteQuery">,
        path,
        externalId,
      );
    }
    return readSessionCacheUsage(backend, await runtime.readFile(path, MAX_TRANSCRIPT_BYTES));
  } catch {
    throw new OrcError("Session cache usage could not be read", "CACHE_UNAVAILABLE", 503);
  }
}

export function emptySessionCacheUsage(): SessionCacheUsage {
  return {
    latest: null,
    totals: null,
    output_tokens: null,
    requests: null,
    compactions: null,
    timeline: null,
  };
}

type CachePoint = {
  recorded_at: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number | null;
  output_tokens: number | null;
  context_tokens?: number;
};

function recordCachePoint(
  result: SessionCacheUsage,
  timeline: NonNullable<SessionCacheUsage["timeline"]>,
  point: CachePoint,
): void {
  const tokens: CacheTokenUsage = {
    input_tokens: point.input_tokens,
    cached_input_tokens: point.cached_input_tokens,
    cache_write_tokens: point.cache_write_tokens,
  };
  if (
    !result.latest ||
    !point.recorded_at ||
    !result.latest.recorded_at ||
    point.recorded_at >= result.latest.recorded_at
  )
    result.latest = {
      ...tokens,
      recorded_at: point.recorded_at,
      may_be_cold_after: null,
      context_tokens: point.context_tokens ?? point.input_tokens,
      context_window: null,
    };
  const totals = result.totals ?? {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
  };
  totals.input_tokens += tokens.input_tokens;
  totals.cached_input_tokens += tokens.cached_input_tokens;
  totals.cache_write_tokens =
    totals.cache_write_tokens !== null && tokens.cache_write_tokens !== null
      ? totals.cache_write_tokens + tokens.cache_write_tokens
      : null;
  result.totals = totals;
  result.output_tokens = (result.output_tokens ?? 0) + (point.output_tokens ?? 0);
  result.requests = (result.requests ?? 0) + 1;
  timeline.push({
    request: timeline.length + 1,
    recorded_at: point.recorded_at,
    context_tokens: point.context_tokens ?? point.input_tokens,
    cached_input_tokens: point.cached_input_tokens,
    output_tokens: point.output_tokens,
  });
}

/** Pi records per-assistant usage on the active branch and context edits for compaction. */
function readPiCacheUsage(bytes: Uint8Array): SessionCacheUsage {
  const result = emptySessionCacheUsage();
  let parsed: ReturnType<typeof parsePiSession>;
  try {
    parsed = parsePiSession(new TextDecoder().decode(bytes));
  } catch {
    return result;
  }
  if (!parsed) return result;
  const compactions: NonNullable<SessionCacheUsage["compactions"]> = [];
  for (const entry of parsed.branch) {
    if (entry.type !== "context_edit") continue;
    // Pi's context edits record what changed, never why, so the trigger stays unknown.
    compactions.push({
      recorded_at: timestamp(entry.timestamp),
      pre_tokens: null,
      post_tokens: null,
      trigger: null,
    });
  }
  result.compactions = compactions;
  const timeline: NonNullable<SessionCacheUsage["timeline"]> = [];
  for (const entry of parsed.messages) {
    const usage = entry.message?.usage;
    if (entry.message?.role !== "assistant" || !usage) continue;
    const cached = usage.cacheRead ?? 0;
    const writes = usage.cacheWrite ?? 0;
    recordCachePoint(result, timeline, {
      recorded_at: timestamp(entry.timestamp),
      input_tokens: (usage.input ?? 0) + cached + writes,
      cached_input_tokens: cached,
      cache_write_tokens: writes,
      output_tokens: usage.output ?? null,
    });
  }
  if (timeline.length) result.timeline = downsample(timeline);
  return result;
}

type OpenCodeUsageRow = { id: string; data: string; time_created: number };

async function openCodeRows<T extends object>(
  runtime: Pick<HostRuntime, "sqliteQuery">,
  path: string,
  sql: string,
): Promise<T[]> {
  try {
    return await runtime.sqliteQuery<T>(path, sql);
  } catch (error) {
    if (/no such (table|column)/i.test(error instanceof Error ? error.message : String(error)))
      return [];
    throw error;
  }
}

/** OpenCode keeps per-request usage in its local database rather than the transcript file. */
async function readOpenCodeCacheUsage(
  runtime: Pick<HostRuntime, "sqliteQuery">,
  path: string,
  sessionId: string,
): Promise<SessionCacheUsage> {
  const result = emptySessionCacheUsage();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return result;
  const current = await openCodeRows<OpenCodeUsageRow & { type: string }>(
    runtime,
    path,
    `SELECT id, type, data, time_created FROM session_message WHERE session_id = '${sessionId}' AND type IN ('assistant', 'compaction') ORDER BY seq`,
  );
  let rows: OpenCodeUsageRow[];
  let compactions: { time: number; trigger: "manual" | "auto" | null }[];
  if (current.length) {
    rows = current;
    compactions = current
      .filter((row) => row.type === "compaction")
      .map((row) => ({
        time: row.time_created,
        trigger: recordedTrigger(parsedObject(row.data).trigger),
      }));
  } else {
    rows = (
      await openCodeRows<OpenCodeUsageRow & { role: string | null }>(
        runtime,
        path,
        `SELECT id, json_extract(data, '$.role') AS role, data, time_created FROM message WHERE session_id = '${sessionId}' ORDER BY time_created`,
      )
    ).filter((row) => row.role === "assistant");
    compactions = [];
  }
  if (!rows.length) return result;
  const usage = parseOpenCodeUsage(rows);
  const timeline: NonNullable<SessionCacheUsage["timeline"]> = [];
  for (const event of usage.events) {
    recordCachePoint(result, timeline, {
      recorded_at: event.ts > 0 ? new Date(event.ts).toISOString() : null,
      input_tokens: event.inputTokens + event.cacheReadTokens + event.cacheWriteTokens,
      cached_input_tokens: event.cacheReadTokens,
      cache_write_tokens: event.cacheWriteTokens,
      output_tokens: event.outputTokens,
      context_tokens:
        event.inputTokens +
        event.outputTokens +
        event.reasoningTokens +
        event.cacheReadTokens +
        event.cacheWriteTokens,
    });
  }
  result.compactions = compactions.map((entry) => ({
    recorded_at:
      Number.isFinite(entry.time) && entry.time > 0 ? new Date(entry.time).toISOString() : null,
    pre_tokens: null,
    post_tokens: null,
    trigger: entry.trigger,
  }));
  if (timeline.length) result.timeline = downsample(timeline);
  return result;
}

const TIMELINE_POINTS = 200;

function downsample<T extends { context_tokens: number }>(points: T[]): T[] {
  if (points.length <= TIMELINE_POINTS) return points;
  const size = points.length / TIMELINE_POINTS;
  return Array.from({ length: TIMELINE_POINTS }, (_, bucket) =>
    points
      .slice(Math.floor(bucket * size), Math.floor((bucket + 1) * size))
      .reduce((peak, point) => (point.context_tokens > peak.context_tokens ? point : peak)),
  );
}

export function readSessionCacheUsage(backend: string, bytes: Uint8Array): SessionCacheUsage {
  if (backend === "pi") return readPiCacheUsage(bytes);
  const result = emptySessionCacheUsage();
  if (backend !== "claude" && backend !== "codex") return result;
  const compactions: NonNullable<SessionCacheUsage["compactions"]> = [];
  const timeline: NonNullable<SessionCacheUsage["timeline"]> = [];
  let codexTotal: number | null = null;
  result.compactions = compactions;
  const codexCompactedAt: number[] = [];
  const seen = new Set<string>();
  for (const line of new TextDecoder().decode(bytes).split("\n")) {
    let row: Record<string, unknown>;
    try {
      row = object(JSON.parse(line));
    } catch {
      continue;
    }
    const recordedAt = timestamp(row.timestamp);
    if (backend === "claude") {
      if (row.type === "system" && row.subtype === "compact_boundary") {
        const meta = object(row.compactMetadata);
        const tokens = (value: unknown) => {
          const parsed = Count.safeParse(value);
          return parsed.success ? parsed.data : null;
        };
        compactions.push({
          recorded_at: recordedAt,
          pre_tokens: tokens(meta.preTokens),
          post_tokens: tokens(meta.postTokens),
          trigger: recordedTrigger(meta.trigger),
        });
        continue;
      }
      if (row.type !== "assistant") continue;
      const message = object(row.message);
      if (message.model === "<synthetic>") continue;
      const usage = ClaudeUsage.safeParse(message.usage);
      if (!usage.success || (typeof message.id === "string" && seen.has(message.id))) continue;
      if (typeof message.id === "string") seen.add(message.id);
      const value = usage.data;
      const writes = value.cache_creation_input_tokens ?? 0;
      const tokens: CacheTokenUsage = {
        input_tokens: value.input_tokens + value.cache_read_input_tokens + writes,
        cached_input_tokens: value.cache_read_input_tokens,
        cache_write_tokens: value.cache_creation_input_tokens ?? null,
      };
      let lifetime = 0;
      if ((value.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) lifetime = 3600;
      else if ((value.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) lifetime = 300;
      const mayBeColdAfter =
        lifetime && recordedAt
          ? new Date(Date.parse(recordedAt) + lifetime * 1000).toISOString()
          : null;
      if (
        !result.latest ||
        !recordedAt ||
        !result.latest.recorded_at ||
        recordedAt >= result.latest.recorded_at
      )
        result.latest = {
          ...tokens,
          recorded_at: recordedAt,
          may_be_cold_after: mayBeColdAfter,
          context_tokens: tokens.input_tokens,
          context_window: null,
        };
      const totals = result.totals ?? {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
      };
      totals.input_tokens += tokens.input_tokens;
      totals.cached_input_tokens += tokens.cached_input_tokens;
      totals.cache_write_tokens =
        totals.cache_write_tokens !== null && tokens.cache_write_tokens !== null
          ? totals.cache_write_tokens + tokens.cache_write_tokens
          : null;
      result.totals = totals;
      result.output_tokens = (result.output_tokens ?? 0) + (value.output_tokens ?? 0);
      result.requests = (result.requests ?? 0) + 1;
      timeline.push({
        request: timeline.length + 1,
        recorded_at: recordedAt,
        context_tokens: tokens.input_tokens,
        cached_input_tokens: tokens.cached_input_tokens,
        output_tokens: value.output_tokens ?? null,
      });
    } else {
      if (row.type === "compacted") {
        compactions.push({
          recorded_at: recordedAt,
          pre_tokens: timeline.at(-1)?.context_tokens ?? null,
          post_tokens: null,
          trigger: null,
        });
        codexCompactedAt.push(timeline.length);
        continue;
      }
      const payload = object(row.payload);
      if (row.type !== "event_msg" || payload.type !== "token_count") continue;
      const info = object(payload.info);
      const latest = CodexUsage.safeParse(info.last_token_usage);
      if (!latest.success || latest.data.input_tokens === 0) continue;
      const totals = CodexUsage.safeParse(info.total_token_usage);
      const total = totals.success ? totals.data.input_tokens : null;
      const context = latest.data.total_tokens ?? latest.data.input_tokens;
      const window = Count.positive().safeParse(info.model_context_window);
      if (total === null || total !== codexTotal)
        timeline.push({
          request: timeline.length + 1,
          recorded_at: recordedAt,
          context_tokens: context,
          cached_input_tokens: latest.data.cached_input_tokens,
          output_tokens: latest.data.output_tokens ?? null,
        });
      codexTotal = total;
      if (
        !result.latest ||
        !recordedAt ||
        !result.latest.recorded_at ||
        recordedAt >= result.latest.recorded_at
      ) {
        result.latest = {
          ...codexTokens(latest.data),
          recorded_at: recordedAt,
          may_be_cold_after: null,
          context_tokens: context,
          context_window: window.success ? window.data : null,
        };
        result.totals = totals.success ? codexTokens(totals.data) : null;
        result.output_tokens = totals.success ? (totals.data.output_tokens ?? null) : null;
      }
    }
  }
  codexCompactedAt.forEach((at, index) => {
    const compaction = compactions[index];
    if (compaction) compaction.post_tokens = timeline[at]?.context_tokens ?? null;
  });
  if (timeline.length) result.timeline = downsample(timeline);
  return result;
}
