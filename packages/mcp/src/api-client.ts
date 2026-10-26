import { loadConfig, resolveApiBase } from "@orc/core/config";
import { OrcError } from "@orc/core/errors";

/** Base URL of the local ORC API (the daemon), reachable from MCP processes on this host. */
export function orcApiBase(): string {
  return resolveApiBase();
}

/**
 * JSON call to the ORC API, for work only the daemon can do (scheduling, starting job runs).
 * API errors come back as the matching ORC error so tool output reads the same either way.
 */
export async function orcApi<T>(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const response = await fetch(`${orcApiBase()}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${loadConfig().api.secret ?? ""}`,
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 300) };
  }
  if (response.ok) return body as T;
  const err = body as { error?: string; code?: string } | null;
  throw new OrcError(
    err?.error ?? `ORC API ${method} ${path} failed (HTTP ${response.status})`,
    err?.code ?? "API_ERROR",
    response.status,
  );
}
