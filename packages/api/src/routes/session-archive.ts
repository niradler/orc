import { createRoute, z } from "@hono/zod-openapi";
import { changes } from "@orc/core/changes";
import { ValidationError } from "@orc/core/errors";
import {
  ARCHIVE_MAX_BYTES,
  ArchiveIdentitySchema,
  ArchiveSearchSchema,
  ArchiveUploadSchema,
  SessionSyncInputSchema,
} from "@orc/core/session-archive";
import { SessionHandoffInputSchema } from "@orc/core/session-handoff";
import { getSqlite } from "@orc/db/client";
import type { MiddlewareHandler } from "hono";
import { getHandoffService, handoffDto } from "../handoffs/service.js";
import { createRouter } from "../lib/router.js";
import { getSessionArchive } from "../sessions/archive.js";
import { indexDiscoveredSessions } from "../sessions/archive-local.js";
import { authorizeSessionSync, mintSessionSync } from "../sessions/sync-grants.js";
import { readTranscriptBytes } from "../sessions/transcript.js";

const app = createRouter();
const tags = ["Session archive"];
const params = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const ok = {
  200: {
    description: "Session archive result",
    content: { "application/json": { schema: z.any().openapi({ type: "object" }) } },
  },
};
const revision = z.coerce.number().int().min(1).optional();

app.use("/sessions/archive/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  return next();
});
const boundedBody: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST" || !c.req.raw.body) return next();
  const max = c.req.path.endsWith("/upload") ? ARCHIVE_MAX_BYTES : 256 * 1024;
  const tooLarge = () => c.json({ error: `Request exceeds ${max} bytes`, code: "TOO_LARGE" }, 413);
  if (Number(c.req.header("content-length") ?? 0) > max) return tooLarge();
  const reader = c.req.raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, 60_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw new ValidationError("Upload timed out; retry the snapshot");
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  c.req.raw = new Request(c.req.raw, { body: Buffer.concat(chunks) });
  return next();
};
app.use("/sessions/archive/*", boundedBody);
app.use("/session-sync/:token/*", async (c, next) => {
  authorizeSessionSync(c.req.param("token") ?? "");
  c.header("Cache-Control", "no-store");
  return next();
});
app.use("/session-sync/:token/*", boundedBody);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/archive/sync",
    tags,
    summary:
      "Mint a one-hour, project-scoped upload capability for a connected agent's local helper",
    request: json(SessionSyncInputSchema),
    responses: ok,
  }),
  (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(mintSessionSync(c.req.url, c.req.valid("json").projects));
  },
);

const tokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
app.openapi(
  createRoute({
    method: "get",
    path: "/session-sync/{token}/projects",
    tags,
    summary: "List only the projects covered by a sync capability",
    request: { params: tokenParams },
    responses: ok,
  }),
  (c) => c.json({ projects: authorizeSessionSync(c.req.valid("param").token) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/session-sync/{token}/upload",
    tags,
    summary: "Upload through a temporary project-scoped sync capability",
    request: { params: tokenParams, ...json(ArchiveUploadSchema) },
    responses: { ...ok, 409: ok[200] },
  }),
  async (c) => {
    const upload = c.req.valid("json");
    authorizeSessionSync(c.req.valid("param").token, upload.project);
    const result = await (await getSessionArchive()).ingest(upload);
    if (result.outcome === "conflict")
      return c.json(
        {
          ...result,
          error: `Conflicting revision ${result.conflict_revision} retained; current history is unchanged`,
          code: "SESSION_CONFLICT",
        },
        409,
      );
    return c.json(result, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/session-sync/{token}/manifest",
    tags,
    summary: "Compare origins within the capability's projects",
    request: {
      params: tokenParams,
      ...json(z.object({ sessions: z.array(ArchiveIdentitySchema).min(1).max(100) }).strict()),
    },
    responses: ok,
  }),
  (c) => {
    const token = c.req.valid("param").token;
    const db = getSqlite();
    return c.json({
      sessions: c.req.valid("json").sessions.map((identity) => {
        const project = authorizeSessionSync(token, identity.project).find(
          (p) => p.name.toLowerCase() === identity.project.toLowerCase(),
        );
        if (!project) throw new ValidationError("Unknown project");
        const row = db
          .query<
            { id: string; project_id: string | null; revision: number; content_hash: string },
            string[]
          >(
            "SELECT id, project_id, revision, content_hash FROM session_archives WHERE source_id = ? AND agent = ? AND native_id = ?",
          )
          .get(identity.source_id, identity.agent, identity.session_id);
        if (row && row.project_id !== project.id)
          throw new ValidationError("Origin belongs to another project");
        return { ...identity, archive: row ?? null };
      }),
    });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/archive/upload",
    tags,
    summary: "Archive one native snapshot idempotently; an existing project is required",
    request: json(ArchiveUploadSchema),
    responses: { ...ok, 409: ok[200] },
  }),
  async (c) => {
    const result = await (await getSessionArchive()).ingest(c.req.valid("json"));
    if (result.outcome === "conflict")
      return c.json(
        {
          ...result,
          error: `Session histories diverged; incoming revision ${result.conflict_revision} was retained without replacing current history`,
          code: "SESSION_CONFLICT",
        },
        409,
      );
    return c.json(result, 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/archive/manifest",
    tags,
    summary: "Look up up to 100 origin identities before synchronizing",
    request: json(z.object({ sessions: z.array(ArchiveIdentitySchema).min(1).max(100) }).strict()),
    responses: ok,
  }),
  (c) => {
    const db = getSqlite();
    return c.json({
      sessions: c.req.valid("json").sessions.map((identity) => {
        const project = db
          .query<{ id: string }, [string]>("SELECT id FROM projects WHERE lower(name) = lower(?)")
          .get(identity.project);
        if (!project) throw new ValidationError("Select an existing project before uploading");
        const row = db
          .query<
            { id: string; project_id: string | null; revision: number; content_hash: string },
            string[]
          >(
            "SELECT id, project_id, revision, content_hash FROM session_archives WHERE source_id = ? AND agent = ? AND native_id = ?",
          )
          .get(identity.source_id, identity.agent, identity.session_id);
        if (row && row.project_id !== project.id)
          throw new ValidationError("Origin belongs to another project");
        return { ...identity, archive: row ?? null };
      }),
    });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/archive",
    tags,
    summary: "Search archived session passages with optional hybrid retrieval",
    request: { query: ArchiveSearchSchema },
    responses: ok,
  }),
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await (await getSessionArchive()).search(c.req.valid("query")));
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/archive/index",
    tags,
    summary: "Index discovered Claude/Codex sessions assigned to projects",
    request: json(z.object({ project_id: z.string().max(100).optional() }).strict()),
    responses: ok,
  }),
  async (c) => {
    const result = await indexDiscoveredSessions(c.req.valid("json").project_id);
    (await getSessionArchive()).kick();
    return c.json(result);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/archive/{id}",
    tags,
    summary: "Inspect archive metadata and immutable revisions",
    request: { params },
    responses: ok,
  }),
  async (c) => {
    const svc = await getSessionArchive();
    const { id } = c.req.valid("param");
    return c.json({
      session: svc.get(id),
      revisions: svc.history(id),
      handoffs: getSqlite()
        .query("SELECT revision, handoff_id FROM session_archive_handoffs WHERE archive_id = ?")
        .all(id),
    });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/archive/{id}/transcript",
    tags,
    summary: "Read a pinned archive revision as a page of conversation turns",
    request: {
      params,
      query: z.object({
        revision,
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        q: z.string().max(2000).optional(),
      }),
    },
    responses: ok,
  }),
  async (c) => {
    const svc = await getSessionArchive();
    const { id } = c.req.valid("param");
    const query = c.req.valid("query");
    const bundle = svc.bundle(id, query.revision);
    const main = bundle.bundle.files.find((f) => f.path === "session.jsonl");
    return c.json(
      await readTranscriptBytes(
        new TextEncoder().encode(main?.content ?? ""),
        bundle.agent,
        `${id}@${query.revision ?? svc.get(id).revision}`,
        query,
      ),
    );
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/archive/{id}/passage",
    tags,
    summary: "Resolve a revision-pinned session passage citation",
    request: {
      params,
      query: z.object({
        revision: z.coerce.number().int().min(1),
        ordinal: z.coerce.number().int().min(0),
      }),
    },
    responses: ok,
  }),
  async (c) => {
    const { revision, ordinal } = c.req.valid("query");
    return c.json(
      await (await getSessionArchive()).citation(c.req.valid("param").id, revision, ordinal),
    );
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/sessions/archive/{id}/export",
    tags,
    summary: "Export the original native session bundle without credentials/config",
    request: { params, query: z.object({ revision }) },
    responses: ok,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    c.header("Content-Disposition", `attachment; filename="session-${id}.json"`);
    return c.json((await getSessionArchive()).bundle(id, c.req.valid("query").revision).bundle);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/sessions/archive/{id}/resume",
    tags,
    summary: "Prepare an archived revision for native resume through existing handoff safeguards",
    request: {
      params,
      ...json(
        z
          .object({
            revision: z.number().int().min(1).optional(),
            repository: z.string().max(2048).optional(),
            branch: z.string().max(1024).optional(),
            commit: z.string().max(40).optional(),
            subdirectory: z.string().max(1024).optional(),
          })
          .strict(),
      ),
    },
    responses: ok,
  }),
  async (c) => {
    const svc = await getSessionArchive();
    const id = c.req.valid("param").id;
    const input = c.req.valid("json");
    const session = svc.get(id);
    const upload = svc.bundle(id, input.revision);
    const project = getSqlite()
      .query<{ name: string }, [string | null]>("SELECT name FROM projects WHERE id = ?")
      .get(session.project_id);
    if (!project)
      throw new ValidationError(
        "Assign the archived session to an existing project before resuming",
      );
    const request = SessionHandoffInputSchema.parse({
      project: project.name,
      agent: upload.agent,
      session_id: upload.session_id,
      source_cwd: upload.metadata.cwd ?? "/",
      repository: input.repository ?? upload.metadata.repository,
      branch: input.branch ?? upload.metadata.branch,
      commit: input.commit ?? upload.metadata.commit,
      subdirectory: input.subdirectory ?? upload.metadata.subdirectory,
      title: upload.title.slice(0, 120),
    });
    const handoffs = getHandoffService();
    const { row, token } = await handoffs.create(request);
    getSqlite().run(
      "INSERT INTO session_archive_handoffs (archive_id, revision, handoff_id) VALUES (?, ?, ?)",
      [id, input.revision ?? session.revision, row.id],
    );
    const ready = await handoffs.upload(row.id, token, upload.bundle);
    changes.publish("sessions");
    return c.json({
      ...handoffDto(ready),
      archive_id: id,
      archive_revision: input.revision ?? session.revision,
    });
  },
);

export { app as sessionArchiveRouter };
