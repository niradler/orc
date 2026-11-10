import { createLogger } from "@orc/core/logger";
import { type AuditInput, AuditLog } from "@orc/db/audit";
import { getSqlite } from "@orc/db/client";
import type { Context } from "hono";

const logger = createLogger("api:audit");
const SENSITIVE_FIELDS = new Set(["env_vars", "environment", "settings", "command", "action"]);

/** Human UI, MCP/agent session or CLI, from the identity headers every client already sends. */
export function auditActor(c: Context): { actor: string; session_id: string | null } {
  const name = c.req.header("x-orc-actor-name")?.slice(0, 80);
  const source = c.req.header("x-orc-source")?.slice(0, 40);
  return {
    actor: name || (source === "ui" ? "web-ui" : source || "api"),
    session_id: c.req.header("x-orc-session-id")?.slice(0, 200) ?? null,
  };
}

/** The mutation already succeeded, so a failed audit write is logged instead of failing the request. */
export function recordAudit(c: Context, input: Omit<AuditInput, "actor" | "session_id">): void {
  try {
    new AuditLog(getSqlite()).record({ ...auditActor(c), ...input });
  } catch (error) {
    logger.warn("audit write failed", { action: input.action, error: String(error) });
  }
}

/** Names of changed fields; values only for non-sensitive scalars, never commands or secrets. */
export function diffSummary(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  after: Record<string, unknown>,
): { changed: string[]; values: Record<string, { before: unknown; after: unknown }> } {
  const changed: string[] = [];
  const values: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(patch)) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    changed.push(key);
    const next = after[key];
    const scalar = next === null || ["string", "number", "boolean"].includes(typeof next);
    if (scalar && !SENSITIVE_FIELDS.has(key))
      values[key] = {
        before: typeof before[key] === "string" ? String(before[key]).slice(0, 200) : before[key],
        after: typeof next === "string" ? next.slice(0, 200) : next,
      };
  }
  return { changed, values };
}
