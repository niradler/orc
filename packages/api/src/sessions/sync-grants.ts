import { createHash, randomBytes } from "node:crypto";
import { NotFoundError, UnauthorizedError, ValidationError } from "@orc/core/errors";
import { getSqlite } from "@orc/db/client";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
type Project = { id: string; name: string; git_remote_url: string | null };

export function mintSessionSync(origin: string, names?: string[], now = Date.now()) {
  const db = getSqlite();
  const projects = names
    ? names.map((name) => {
        const project = db
          .query<Project, [string]>(
            "SELECT id, name, git_remote_url FROM projects WHERE lower(name) = lower(?)",
          )
          .get(name);
        if (!project) throw new NotFoundError("Project", name);
        return project;
      })
    : db.query<Project, []>("SELECT id, name, git_remote_url FROM projects ORDER BY name").all();
  if (!projects.length)
    throw new ValidationError("Create or select a project before syncing sessions");
  const token = randomBytes(32).toString("base64url");
  const expires = now + 60 * 60 * 1000;
  db.run("INSERT INTO session_sync_grants (token_hash, project_ids, expires_at) VALUES (?, ?, ?)", [
    hash(token),
    JSON.stringify([...new Set(projects.map((p) => p.id))]),
    expires,
  ]);
  return {
    sync_url: new URL(`/api/session-sync/${token}`, origin).toString(),
    expires_at: new Date(expires).toISOString(),
    projects,
  };
}

export function authorizeSessionSync(token: string, projectName?: string, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedError();
  const grant = getSqlite()
    .query<{ project_ids: string; expires_at: number }, [string]>(
      "SELECT * FROM session_sync_grants WHERE token_hash = ?",
    )
    .get(hash(token));
  if (!grant || grant.expires_at <= now)
    throw new UnauthorizedError("Session sync capability expired or invalid; request a new one");
  const ids: string[] = JSON.parse(grant.project_ids);
  const projects = getSqlite()
    .query<Project, string[]>(
      `SELECT id, name, git_remote_url FROM projects WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY name`,
    )
    .all(...ids);
  if (projectName && !projects.some((p) => p.name.toLowerCase() === projectName.toLowerCase()))
    throw new UnauthorizedError("Session sync capability does not cover this project");
  return projects;
}
