import { NotFoundError } from "@orc/core/errors";
import type { ScopeQuery } from "@orc/core/scope";
import { getSqlite } from "@orc/db/client";

/** The project a scope query names, or null for global (scope "global" or no project). */
export function resolveScopeProject(input: ScopeQuery): string | null {
  if (input.scope === "global" || !input.project_id) return null;
  if (!getSqlite().query("SELECT id FROM projects WHERE id = ?").get(input.project_id))
    throw new NotFoundError("Project", input.project_id);
  return input.project_id;
}
