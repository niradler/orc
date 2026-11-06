import { OrcError } from "@orc/core/errors";
import type { HostRuntime } from "@orc/core/exec-host";
import type { CacheTokenUsage, SessionCacheUsage } from "@orc/core/usage";
import { z } from "zod";
import { MAX_TRANSCRIPT_BYTES } from "./transcript.js";

const Count = z.number().int().nonnegative();
const ClaudeUsage = z.object({
  input_tokens: Count,
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

function codexTokens(value: z.infer<typeof CodexUsage>): CacheTokenUsage {
  return {
    input_tokens: value.input_tokens,
    cached_input_tokens: value.cached_input_tokens,
    cache_write_tokens: value.cache_write_input_tokens ?? null,
  };
}

export async function loadSessionCacheUsage(
  runtime: Pick<HostRuntime, "isFile" | "readFile">,
  backend: string,
  path: string,
): Promise<SessionCacheUsage> {
  try {
    if (!(await runtime.isFile(path))) return { latest: null, totals: null };
    return readSessionCacheUsage(backend, await runtime.readFile(path, MAX_TRANSCRIPT_BYTES));
  } catch {
    throw new OrcError("Session cache usage could not be read", "CACHE_UNAVAILABLE", 503);
  }
}

export function readSessionCacheUsage(backend: string, bytes: Uint8Array): SessionCacheUsage {
  const result: SessionCacheUsage = { latest: null, totals: null };
  if (backend !== "claude" && backend !== "codex") return result;
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
        result.latest = { ...tokens, recorded_at: recordedAt, may_be_cold_after: mayBeColdAfter };
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
    } else {
      const payload = object(row.payload);
      if (row.type !== "event_msg" || payload.type !== "token_count") continue;
      const info = object(payload.info);
      const latest = CodexUsage.safeParse(info.last_token_usage);
      if (!latest.success) continue;
      const totals = CodexUsage.safeParse(info.total_token_usage);
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
        };
        result.totals = totals.success ? codexTokens(totals.data) : null;
      }
    }
  }
  return result;
}
