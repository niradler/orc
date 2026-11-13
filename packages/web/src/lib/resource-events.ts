import { CHANGE_RESOURCES, type ChangeResource } from "@orc/core/changes";
import type { QueryClient } from "@tanstack/react-query";

type ResourceConnection = "connecting" | "connected" | "disconnected";
let connection: ResourceConnection = "connecting";
const connectionListeners = new Set<() => void>();
export function getResourceConnection(): ResourceConnection {
  return connection;
}
export function subscribeResourceConnection(listener: () => void): () => void {
  connectionListeners.add(listener);
  return () => {
    connectionListeners.delete(listener);
  };
}
export function setResourceConnection(next: ResourceConnection): void {
  if (connection === next) return;
  connection = next;
  for (const listener of connectionListeners) listener();
}

const QUERY_ROOTS: Record<ChangeResource, string[]> = {
  notifications: ["notifications"],
  tasks: [
    "sessions",
    "session",
    "palette-live-sessions",
    "tasks",
    "task",
    "task-comments",
    "project-comments",
    "task-links",
    "task-flow",
    "project-summary",
    "github",
    "palette-search",
  ],
  sessions: [
    "sessions",
    "session",
    "palette-live-sessions",
    "project-summary",
    "chat-threads",
    "chat-resume-sessions",
    "chat-resume-archive",
  ],
  "session-messages": ["sessions"],
  // Usage is indexed in the background; the page refreshes when the ledger changes
  // and on every event-stream reconnect instead of on a timer.
  usage: ["usage-report"],
  jobs: [
    "jobs",
    "job",
    "webhooks",
    "job-runs",
    "job-run-logs",
    "kb-digest",
    "project-summary",
    "palette-search",
  ],
  webhooks: ["webhooks", "webhook-deliveries", "jobs", "job"],
  projects: ["projects", "project", "project-summary", "palette-search"],
  memories: ["memories", "memory", "memory-history", "project-summary", "palette-search"],
  scratchpads: ["scratchpads", "scratchpad"],
  knowledge: ["kb", "kb-digest", "palette-documents"],
  skills: [
    "skills",
    "skill",
    "skill-history",
    "skill-origin",
    "skill-visibility",
    "package-skill-picker",
    "setup-components",
  ],
  "skill-usage": ["skills", "package-skill-picker"],
  // Only lists rank by reads; refreshing an open memory would count another read.
  "memory-usage": ["memories"],
  agents: ["agents", "agent", "agent-packages", "setup-components"],
  flows: ["flows", "flow"],
  rules: ["rules"],
  "human-requests": ["human-requests", "chat-waiting", "chat-threads", "chat-resume-sessions"],
  settings: ["settings"],
  ssh: ["ssh", "backends", "terminals", "worktrees", "sessions", "session", "git", "github"],
  terminals: ["terminals", "worktrees"],
  git: ["git", "worktrees", "github"],
  files: ["checkout-files"],
  backends: ["backends"],
  packages: [
    "packages",
    "package",
    "package-tools",
    "package-file",
    "package-catalog",
    "setup-components",
    "agent-packages",
  ],
  health: ["health"],
  github: ["github", "git"],
  audit: ["knowledge-audit", "skill-history"],
  workspaces: ["workspaces", "terminals", "project-summary"],
};

// A running session publishes `sessions` changes about every 100 ms; one trailing refresh
// per window keeps that from re-reading every mounted list for each transcript write.
const COALESCE_MS = 350;

interface PendingRefresh {
  roots: Set<string>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const pendingRefreshes = new WeakMap<QueryClient, PendingRefresh>();

function flushPending(client: QueryClient, pending: PendingRefresh): void {
  clearTimeout(pending.timer);
  pendingRefreshes.delete(client);
  refreshQueries(client, (root) => pending.roots.has(root)).then(pending.resolve, pending.reject);
}

export function invalidateResources(
  client: QueryClient,
  resources: ChangeResource[],
): Promise<void> {
  const roots = resources.flatMap((resource) => QUERY_ROOTS[resource]);
  if (roots.length === 0) return Promise.resolve();
  let pending = pendingRefreshes.get(client);
  if (!pending) {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const created: PendingRefresh = { roots: new Set(), promise, resolve, reject };
    created.timer = setTimeout(() => flushPending(client, created), COALESCE_MS);
    pendingRefreshes.set(client, created);
    pending = created;
  }
  for (const root of roots) pending.roots.add(root);
  return pending.promise;
}

/** Runs queued invalidations now instead of waiting for the coalescing window. */
export function flushResourceChanges(client: QueryClient): Promise<void> {
  const pending = pendingRefreshes.get(client);
  if (!pending) return Promise.resolve();
  flushPending(client, pending);
  return pending.promise;
}

export async function refreshQueries(
  client: QueryClient,
  matches: (root: string) => boolean = () => true,
): Promise<void> {
  const queries = client
    .getQueryCache()
    .findAll({ predicate: (query) => matches(String(query.queryKey[0])) });
  await Promise.all(
    queries.map(async (query) => {
      // An event may arrive after the server captured an initial snapshot but before it
      // reaches this tab. Wait for that read before invalidating so it cannot erase the event.
      if (query.state.fetchStatus === "fetching") await query.promise?.catch(() => {});
      if (client.getQueryCache().get(query.queryHash) !== query) return;
      await client.invalidateQueries(
        { queryKey: query.queryKey, exact: true },
        { cancelRefetch: false },
      );
    }),
  );
}

export class EventFrames {
  private buffer = "";
  constructor(private readonly receive: (event: string, data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 65_536) throw new Error("Resource event exceeds maximum size");
    let match = /\r?\n\r?\n/.exec(this.buffer);
    while (match?.index !== undefined) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trimStart();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length) this.receive(event, data.join("\n"));
      match = /\r?\n\r?\n/.exec(this.buffer);
    }
  }
}

export function parseResources(data: string): ChangeResource[] {
  const value: unknown = JSON.parse(data);
  if (
    !value ||
    typeof value !== "object" ||
    !("resources" in value) ||
    !Array.isArray(value.resources)
  )
    throw new Error("Invalid resource event");
  return value.resources.filter(
    (resource): resource is ChangeResource =>
      typeof resource === "string" && (CHANGE_RESOURCES as readonly string[]).includes(resource),
  );
}

export async function consumeResourceEvents(
  response: Response,
  signal: AbortSignal,
  receive: (event: string, data: string) => void,
  onActivity?: () => void,
): Promise<void> {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("text/event-stream") ||
    !response.body
  )
    throw new Error("Resource stream unavailable");
  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  const frames = new EventFrames(receive);
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity?.();
      frames.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
