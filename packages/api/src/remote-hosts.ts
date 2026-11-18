import { loadConfig, type RemoteHost } from "@orc/core/config";
import { NotFoundError, ValidationError } from "@orc/core/errors";

export function findRemoteHost(id: string): RemoteHost {
  const host = loadConfig().remote_hosts.find((item) => item.id === id);
  if (!host) throw new NotFoundError("Remote host", id);
  return host;
}

export function remoteHeaders(host: Pick<RemoteHost, "token" | "headers">): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of host.headers) headers[header.name] = header.value;
  if (host.token) headers.Authorization = `Bearer ${host.token}`;
  return headers;
}

export async function remoteFetch(
  host: RemoteHost,
  path: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  try {
    return await fetch(`${host.url}/api${path}`, {
      ...init,
      redirect: "error",
      headers: { ...remoteHeaders(host), ...(init.headers as Record<string, string> | undefined) },
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ValidationError(
      error instanceof Error && error.name === "TimeoutError"
        ? `${host.label} did not answer in time`
        : `Could not reach ${host.label} at ${host.url}`,
    );
  }
}

export async function remoteJson<T>(
  host: RemoteHost,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await remoteFetch(host, path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ValidationError(
      typeof body?.error === "string"
        ? `${host.label}: ${body.error}`
        : `${host.label} answered HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export function parseRemoteTarget(value: string | null | undefined) {
  const match = value?.match(/^orc:([a-z0-9][a-z0-9-]{0,63})(?:\/(.+))?$/);
  return match?.[1] ? { id: match[1], host: match[2] ?? null } : null;
}

export async function startRemoteChat(
  target: { id: string; host: string | null },
  body: Record<string, unknown>,
): Promise<{
  host_id: string;
  host_label: string;
  url: string;
  thread_id: string;
  run_id: string;
  open_url: string;
}> {
  const host = findRemoteHost(target.id);
  const workspace = { ...(body.workspace as Record<string, unknown>), host: target.host };
  const { projectId: _local, threadId: _thread, ...rest } = body;
  const controller = new AbortController();
  const response = await remoteFetch(
    host,
    "/chat/stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ ...rest, workspace }),
      signal: controller.signal,
    },
    60_000,
  );
  try {
    if (!response.ok || !response.body) {
      const error = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new ValidationError(
        typeof error?.error === "string"
          ? `${host.label}: ${error.error}`
          : `${host.label} answered HTTP ${response.status}`,
      );
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const event = JSON.parse(line.slice(5).trim()) as {
          type?: string;
          thread?: { id?: string };
          runId?: string;
        };
        if (event.type === "thread" && event.thread?.id) {
          return {
            host_id: host.id,
            host_label: host.label,
            url: host.url,
            thread_id: event.thread.id,
            run_id: event.runId ?? "",
            open_url: `${host.url}/chat?chatThread=${encodeURIComponent(event.thread.id)}`,
          };
        }
      }
    }
    throw new ValidationError(`${host.label} did not start the chat`);
  } finally {
    controller.abort();
  }
}
