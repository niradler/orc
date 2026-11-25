import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { chatBackendFor } from "@orc/agent-runtime";
import type { ChatThread } from "@orc/core/chat";
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
 * The lightweight root session an authenticated MCP connection gets when it has no
 * `?session=` binding. A real chat thread, so spawn/stop/message ownership works through
 * the existing lineage rules. Children inherit its Settings defaults and folder.
 */
export function ensureCoordinatorSession(input: {
  client?: string | undefined;
  projects?: readonly { id: string; name: string }[] | undefined;
}): ChatThread {
  const client = coordinatorClientName(input.client);
  const id = coordinatorSessionId(client);
  const sqlite = getSqlite();
  const store = new ChatStore(sqlite);
  const existing = store.get(id);
  if (existing) return existing;
  const project = input.projects?.length === 1 ? input.projects[0] : undefined;
  const scope = project
    ? sqlite
        .query<{ scope: string | null }, [string]>(
          "SELECT scope FROM projects WHERE id = ? AND status = 'active'",
        )
        .get(project.id)?.scope
    : null;
  const config = providerChatDefaults(undefined, undefined, process.env.ORC_E2E_CHAT_MOCK === "1");
  const thread: ChatThread = {
    id,
    title: `MCP coordinator (${client})`,
    config,
    backend: chatBackendFor(config.agent),
    runtimeId: null,
    cwd: scope || homedir(),
    host: null,
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
