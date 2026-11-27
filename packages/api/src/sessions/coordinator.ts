import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { chatBackendFor } from "@orc/agent-runtime";
import type { ChatSettings, ChatThread } from "@orc/core/chat";
import {
  execHostFor,
  hostAlias,
  hostHome,
  resolveExecHost,
  resolveProjectHost,
} from "@orc/core/exec-host";
import { providerChatDefaults } from "@orc/core/provider-service";
import { AuditLog } from "@orc/db/audit";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";

export const DEFAULT_COORDINATOR_CLIENT = "mcp";

/** Stable key for the client name from `?client=` or X-ORC-Actor-Name; unnamed clients share one coordinator. */
export function coordinatorClientName(raw: string | undefined | null): string {
  const cleaned = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || DEFAULT_COORDINATOR_CLIENT;
}

/**
 * Deterministic UUID so stateless MCP requests reuse one coordinator per client name
 * without a lookup table. The installation's database isolates installations.
 */
export function coordinatorSessionId(client: string): string {
  const bytes = createHash("sha256")
    .update(`orc-mcp-coordinator:${coordinatorClientName(client)}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Children inherit the coordinator thread's config at spawn time while `session_start`
 * reports live Settings defaults, so the creation-time snapshot would otherwise disagree
 * with the reported values forever after a defaults change. Treat the coordinator's chat
 * settings as a view of the current defaults and rewrite them only when they diverge.
 */
function refreshCoordinatorDefaults(
  store: ChatStore,
  existing: ChatThread,
  defaults: ChatSettings,
): ChatThread {
  // Key order is deterministic on both sides (schema parse, then JSON round-trip
  // through the thread store), so an equality check avoids a write on every request.
  if (JSON.stringify(existing.config) === JSON.stringify(defaults)) return existing;
  store.save({ ...existing, config: defaults, backend: chatBackendFor(defaults.agent) });
  return store.get(existing.id) ?? existing;
}

/** Where a coordinator with no project scope lives: the Settings execution host and its home. */
export type CoordinatorBase = { host: string | null; cwd: string };

/**
 * The installation's default execution target, mirroring a new chat with no host
 * or folder of its own. Never the container's own filesystem when Settings points
 * ORC at an SSH host — `host: null` means "local" to `session_start` children.
 */
export async function defaultCoordinatorBase(): Promise<CoordinatorBase> {
  const host = resolveExecHost();
  return {
    host: hostAlias(host),
    cwd: host.kind === "ssh" ? await hostHome(host) : homedir(),
  };
}

function activeProjectTarget(
  sqlite: ReturnType<typeof getSqlite>,
  projectId: string,
): { scope: string | null; host: string | null } | null {
  return sqlite
    .query<{ scope: string | null; host: string | null }, [string]>(
      "SELECT scope, host FROM projects WHERE id = ? AND status = 'active'",
    )
    .get(projectId);
}

/**
 * The lightweight root session an authenticated MCP connection gets when it has no
 * `?session=` binding. A real chat thread, so spawn/stop/message ownership works through
 * the existing lineage rules. Children inherit its chat settings, host and folder, so its
 * config is kept in sync with the live Settings defaults on every use and its host is
 * re-anchored when the installation's default execution host changes; manual edits to a
 * coordinator's own chat settings do not persist across requests.
 */
export async function ensureCoordinatorSession(
  input: {
    client?: string | undefined;
    projects?: readonly { id: string; name: string }[] | undefined;
  },
  base: () => Promise<CoordinatorBase> = defaultCoordinatorBase,
): Promise<ChatThread> {
  const client = coordinatorClientName(input.client);
  const id = coordinatorSessionId(client);
  const sqlite = getSqlite();
  const store = new ChatStore(sqlite);
  const defaults = providerChatDefaults(
    undefined,
    undefined,
    process.env.ORC_E2E_CHAT_MOCK === "1",
  );
  const existing = store.get(id);
  if (existing) {
    const refreshed = refreshCoordinatorDefaults(store, existing, defaults);
    const target = refreshed.projectId ? activeProjectTarget(sqlite, refreshed.projectId) : null;
    const alias = resolveProjectHost(target?.host);
    if (refreshed.host === alias) return refreshed;
    // Threads created before the anchor followed Settings (or before the
    // installation moved hosts) hold a stale local folder such as the
    // container's /data; spawned children would inherit it and run there.
    try {
      const anchored = target?.scope
        ? { host: alias, cwd: target.scope }
        : target?.host
          ? { host: alias, cwd: await hostHome(execHostFor(alias)) }
          : await base();
      store.save({ ...refreshed, host: anchored.host, cwd: anchored.cwd });
      return store.get(id) ?? refreshed;
    } catch {
      // The configured host is unreachable right now. Keep the old anchor and
      // retry on the next request instead of failing every MCP call.
      return refreshed;
    }
  }
  const project = input.projects?.length === 1 ? input.projects[0] : undefined;
  const target = project ? activeProjectTarget(sqlite, project.id) : null;
  const targetHost = resolveProjectHost(target?.host);
  const anchor = target?.scope
    ? { host: targetHost, cwd: target.scope }
    : target?.host
      ? { host: targetHost, cwd: await hostHome(execHostFor(targetHost)) }
      : await base();
  const thread: ChatThread = {
    id,
    title: `MCP coordinator (${client})`,
    config: defaults,
    backend: chatBackendFor(defaults.agent),
    runtimeId: null,
    cwd: anchor.cwd,
    host: anchor.host,
    sourceId: null,
    messages: [],
    ...(project ? { projectId: project.id } : {}),
    updatedAt: Date.now(),
  };
  // Insert-if-absent: concurrent stateless requests converge on one coordinator
  // instead of clobbering a thread another request already created.
  const inserted = sqlite
    .query(
      "INSERT INTO chat_threads (id, title, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    )
    .run(thread.id, thread.title, thread.updatedAt, JSON.stringify(thread));
  const saved = store.get(id);
  if (!saved) throw new Error("Coordinator session could not be created");
  if (inserted.changes > 0) {
    new AuditLog(sqlite).record({
      action: "session.coordinator",
      subject_ids: [id],
      result_ids: [id],
      project_id: project?.id ?? null,
      actor: client,
      session_id: id,
      note: "Authenticated MCP connection without a session binding",
      snapshot: { client, transport: "mcp-http" },
    });
  }
  return saved;
}
