import { createRoute, z } from "@hono/zod-openapi";
import { WikiScopeSchema } from "@orc/core/wiki";
import { AuditLog } from "@orc/db/audit";
import { getSqlite } from "@orc/db/client";
import { createRouter } from "../lib/router.js";
import { resolveWikiProject } from "./wiki.js";

const app = createRouter();
const AuditEntrySchema = z
  .object({
    id: z.string(),
    created_at: z.number(),
    action: z.string(),
    entity_type: z.string(),
    project_id: z.string().nullable(),
    actor: z.string().nullable(),
    session_id: z.string().nullable(),
    subject_ids: z.array(z.string()),
    result_ids: z.array(z.string()),
    note: z.string().nullable(),
    snapshot: z.unknown().nullable(),
  })
  .openapi("AuditEntry");
app.openapi(
  createRoute({
    method: "get",
    path: "/audit",
    tags: ["Audit"],
    summary: "Read the central knowledge audit log",
    request: {
      query: WikiScopeSchema.extend({
        entity_type: z.enum(["memory", "wiki", "skill", "digest"]).optional(),
        session_id: z.string().min(1).max(200).optional(),
        since: z.coerce.number().int().min(0).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    },
    responses: {
      200: {
        description: "Audit entries including preserved prior rows",
        content: {
          "application/json": { schema: z.object({ entries: z.array(AuditEntrySchema) }) },
        },
      },
    },
  }),
  (c) => {
    const input = c.req.valid("query");
    return c.json({
      entries: new AuditLog(getSqlite()).list({
        projectId: resolveWikiProject(input),
        entityType: input.entity_type,
        sessionId: input.session_id,
        since: input.since,
        limit: input.limit,
      }),
    });
  },
);

export { app as auditRouter };
