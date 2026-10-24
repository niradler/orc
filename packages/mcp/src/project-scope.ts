import { NotFoundError, ValidationError } from "@orc/core/errors";
import { getSqlite } from "@orc/db/client";

export type McpProject = { id: string; name: string };

export function parseMcpProjects(project?: string, projects?: string): string[] | undefined {
  if (project !== undefined && projects !== undefined)
    throw new ValidationError("Use project or projects, not both");
  if (project === undefined && projects === undefined) return undefined;
  const names = projects === undefined ? [project ?? ""] : projects.split(",");
  return normalizeMcpProjects(names);
}

export function normalizeMcpProjects(names: readonly string[]): string[] {
  if (names.length > 50) throw new ValidationError("Select at most 50 projects");
  const unique = new Map<string, string>();
  for (const value of names) {
    const name = value.trim();
    if (!name || name.length > 200)
      throw new ValidationError("Projects must be readable names of 1-200 characters");
    if (!unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
  }
  return [...unique.values()];
}

export function resolveMcpProjects(names: readonly string[]): McpProject[] {
  return names.map((name) => {
    const row = getSqlite()
      .query<McpProject, [string]>("SELECT id,name FROM projects WHERE name=? COLLATE NOCASE")
      .get(name);
    if (!row) throw new NotFoundError("Project", name);
    return row;
  });
}
