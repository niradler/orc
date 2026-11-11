import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import { type ExecHost, execHostFor } from "@orc/core/exec-host";
import { ChatStore } from "@orc/db/chat";
import { getDb, getSqlite } from "@orc/db/client";
import { gateway_sessions } from "@orc/db/schema";
import { eq, or } from "drizzle-orm";

export async function previewSession(
  id: string,
): Promise<{ id: string; cwd: string; host: ExecHost; projectId: string | null }> {
  const store = new ChatStore(getSqlite());
  const thread = store.get(id);
  if (thread)
    return {
      id: thread.id,
      cwd: thread.cwd,
      host: execHostFor(thread.host),
      projectId: thread.projectId ?? null,
    };
  const rows = await getDb().query.gateway_sessions.findMany({
    where: or(eq(gateway_sessions.id, id), eq(gateway_sessions.runtime_session_id, id)),
    limit: 2,
  });
  if (rows.length > 1)
    throw new ConflictError("Session identifier is ambiguous. Use its ORC session ID.");
  const row = rows[0];
  if (!row) throw new NotFoundError("Session", id);
  if (!row.cwd) throw new ValidationError("This session has no workspace folder");
  const linked = row.runtime_session_id
    ? store.byRuntime(row.backend, row.execution_host ?? null, row.runtime_session_id)[0]
    : undefined;
  return {
    id: linked?.id ?? row.id,
    cwd: row.cwd,
    host: execHostFor(row.execution_host ?? null),
    projectId: row.project_id ?? null,
  };
}
