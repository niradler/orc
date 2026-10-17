import { createRoute, z } from "@hono/zod-openapi";
import { loadConfig, updateGlobalConfig } from "@orc/core/config";
import { ForbiddenError, NotFoundError, ValidationError } from "@orc/core/errors";
import {
  KB_CALL_SOURCES,
  KB_SCOPES,
  type KbCallContext,
  type KbCallSource,
  KbCreateSchema,
  KbDocumentCreateSchema,
  KbDocumentUpdateSchema,
  KbEvidenceSchema,
  KbSearchSchema,
  KbUpdateSchema,
} from "@orc/core/kb";
import { encryptSecret } from "@orc/core/secrets";
import { getKnowledgeService, parseCitation } from "@orc/knowledge";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createRouter } from "../lib/router.js";

const app = createRouter();
const svc = getKnowledgeService;

const tooLarge = (c: Context, max: number) =>
  c.json({ error: `File exceeds ${max} bytes`, code: "TOO_LARGE" }, 413);

// Counts the bytes actually streamed (chunked bodies carry no Content-Length), so an oversized
// upload is cut off before the multipart parser buffers it. The slack covers the form framing.
app.use("/kb/bases/:id/upload", (c, next) => {
  const max = loadConfig().knowledge.max_upload_bytes;
  return bodyLimit({ maxSize: max + 64 * 1024, onError: (c) => tooLarge(c, max) })(c, next);
});

/**
 * Transport context. The source comes from the caller's transport header (the web UI sends `ui`,
 * the CLI `cli`); everything else is `api`. The source decides what the call may edit; the actor
 * name and session are attribution only.
 */
export function kbContext(c: Context): KbCallContext {
  const header = c.req.header("x-orc-source")?.toLowerCase();
  const source: KbCallSource = (KB_CALL_SOURCES as readonly string[]).includes(header ?? "")
    ? (header as KbCallSource)
    : "api";
  const sessionId = c.req.header("x-orc-session-id")?.slice(0, 200);
  const name = c.req.header("x-orc-actor-name")?.slice(0, 80);
  const project = c.req.header("x-orc-project-id") ?? c.req.query("project_id");
  return {
    source,
    actor: {
      ...(name ? { name } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    },
    ...(project ? { project_id: project } : {}),
  };
}

const Json = z.any().openapi({ type: "object" });
const ok = (description: string) => ({
  200: { description, content: { "application/json": { schema: Json } } },
});
const idParam = z.object({ id: z.string().min(1).max(100) });
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { "application/json": { schema } }, required: true },
});
const tags = ["Knowledge"];

// --- Knowledge bases -------------------------------------------------------------------------

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/bases",
    tags,
    summary: "List knowledge bases (default: active project's plus global)",
    request: {
      query: z.object({
        scope: z.enum(KB_SCOPES).default("default"),
        project_id: z.string().optional(),
      }),
    },
    responses: ok("Knowledge bases"),
  }),
  async (c) =>
    c.json({
      knowledge_bases: (await svc()).listKbs(kbContext(c), c.req.valid("query").scope),
    }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/bases",
    tags,
    summary: "Create a knowledge base in a project or deliberately global (project_id null)",
    request: json(KbCreateSchema),
    responses: { 201: ok("Created")[200] },
  }),
  async (c) => c.json((await svc()).createKb(kbContext(c), c.req.valid("json")), 201),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/bases/{id}",
    tags,
    summary: "Get a knowledge base",
    request: { params: idParam },
    responses: ok("Knowledge base"),
  }),
  async (c) => c.json((await svc()).getKb(c.req.valid("param").id)),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/kb/bases/{id}",
    tags,
    summary: "Update knowledge base settings (scope cannot change)",
    request: { params: idParam, ...json(KbUpdateSchema) },
    responses: ok("Updated"),
  }),
  async (c) =>
    c.json((await svc()).updateKb(kbContext(c), c.req.valid("param").id, c.req.valid("json"))),
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/kb/bases/{id}",
    tags,
    summary: "Delete a knowledge base, its managed files and index entries",
    request: { params: idParam },
    responses: { 204: { description: "Deleted" } },
  }),
  async (c) => {
    (await svc()).deleteKb(kbContext(c), c.req.valid("param").id);
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/bases/{id}/documents",
    tags,
    summary: "List documents with folders, labels and read counts",
    request: {
      params: idParam,
      query: z.object({ folder: z.string().max(500).optional(), label: z.string().optional() }),
    },
    responses: ok("Documents"),
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(
      (await svc()).listDocuments(c.req.valid("param").id, {
        ...(q.folder ? { folder: q.folder } : {}),
        ...(q.label ? { label: q.label } : {}),
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/bases/{id}/documents",
    tags,
    summary: "Create a Markdown document",
    request: { params: idParam, ...json(KbDocumentCreateSchema) },
    responses: { 201: ok("Created")[200] },
  }),
  async (c) =>
    c.json(
      (await svc()).createDocument(kbContext(c), c.req.valid("param").id, c.req.valid("json")),
      201,
    ),
);

const UploadFormSchema = z.object({
  file: z.any().openapi({ type: "string", format: "binary" }),
  title: z.string().optional(),
  path: z.string().optional(),
  labels: z.string().optional().openapi({ description: "Comma-separated" }),
  description: z.string().optional(),
  document_id: z.string().optional().openapi({ description: "Replace this upload's file" }),
  expected_revision: z.string().optional(),
  note: z.string().optional(),
});

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/bases/{id}/upload",
    tags,
    summary: "Upload a file (Markdown/text become documents; others are parsed in the background)",
    request: {
      params: idParam,
      body: { content: { "multipart/form-data": { schema: UploadFormSchema } }, required: true },
    },
    responses: { 201: ok("Uploaded")[200], 413: { description: "File too large" } },
  }),
  async (c) => {
    const max = loadConfig().knowledge.max_upload_bytes;
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new ValidationError("Missing file field");
    if (file.size > max) return tooLarge(c, max);
    const text = (k: string) => {
      const v = form[k];
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const labels = text("labels")
      ?.split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const rev = text("expected_revision");
    const fields = {
      title: text("title"),
      path: text("path"),
      description: text("description"),
      document_id: text("document_id"),
      note: text("note"),
    };
    const doc = (await svc()).upload(kbContext(c), c.req.valid("param").id, {
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
      ...(labels ? { labels } : {}),
      ...(rev ? { expected_revision: Number(rev) } : {}),
    });
    return c.json(doc, 201);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/bases/{id}/usage",
    tags,
    summary: "Read statistics for a knowledge base, by source and kind",
    request: { params: idParam },
    responses: ok("Usage"),
  }),
  async (c) => c.json((await svc()).kbUsage(c.req.valid("param").id)),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/bases/{id}/maintenance",
    tags,
    summary: "Stale derived documents, failed files, unresolved links",
    request: { params: idParam },
    responses: ok("Maintenance queue"),
  }),
  async (c) => c.json((await svc()).maintenanceQueue(c.req.valid("param").id)),
);

// --- Registered folders ----------------------------------------------------------------------

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/bases/{id}/sources",
    tags,
    summary: "List registered folders",
    request: { params: idParam },
    responses: ok("Sources"),
  }),
  async (c) => c.json({ sources: (await svc()).listSources(c.req.valid("param").id) }),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/bases/{id}/sources",
    tags,
    summary: "Register a local folder; its files are copied in and followed until edited",
    request: {
      params: idParam,
      ...json(
        z.object({
          root_path: z.string().min(1).max(1000),
          pattern: z.string().max(300).optional(),
        }),
      ),
    },
    responses: { 201: ok("Registered")[200] },
  }),
  async (c) => {
    const body = c.req.valid("json");
    return c.json(
      (await svc()).addSource(kbContext(c), c.req.valid("param").id, {
        root_path: body.root_path,
        ...(body.pattern ? { pattern: body.pattern } : {}),
      }),
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/sources/{id}/scan",
    tags,
    summary: "Rescan a registered folder now",
    request: { params: idParam },
    responses: ok("Scan result"),
  }),
  async (c) => c.json((await svc()).scanSource(c.req.valid("param").id)),
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/kb/sources/{id}",
    tags,
    summary: "Unregister a folder (its files are not touched)",
    request: { params: idParam },
    responses: { 204: { description: "Removed" } },
  }),
  async (c) => {
    (await svc()).removeSource(kbContext(c), c.req.valid("param").id);
    return c.body(null, 204);
  },
);

// --- Documents -------------------------------------------------------------------------------

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/documents/{id}",
    tags,
    summary: "Read a document (whole, one heading's section, or one passage)",
    request: {
      params: idParam,
      query: z.object({
        ordinal: z.coerce.number().int().min(0).optional(),
        heading: z.string().max(300).optional(),
        record: z.enum(["true", "false"]).optional().openapi({
          description: "false for refreshes that should not count as a read",
        }),
      }),
    },
    responses: ok("Document"),
  }),
  async (c) => {
    const q = c.req.valid("query");
    return c.json(
      (await svc()).getDocument(kbContext(c), c.req.valid("param").id, {
        ...(q.ordinal !== undefined ? { ordinal: q.ordinal } : {}),
        ...(q.heading ? { heading: q.heading } : {}),
        record: q.record !== "false",
      }),
    );
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/kb/documents/{id}",
    tags,
    summary: "Update a document; expected_revision guards against overwriting newer edits",
    request: { params: idParam, ...json(KbDocumentUpdateSchema) },
    responses: ok("Updated"),
  }),
  async (c) =>
    c.json(
      (await svc()).updateDocument(kbContext(c), c.req.valid("param").id, c.req.valid("json")),
    ),
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/kb/documents/{id}",
    tags,
    summary: "Delete a document and its stored files",
    request: { params: idParam },
    responses: { 204: { description: "Deleted" } },
  }),
  async (c) => {
    (await svc()).deleteDocument(kbContext(c), c.req.valid("param").id);
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/documents/{id}/revisions",
    tags,
    summary: "Revision history",
    request: { params: idParam },
    responses: ok("Revisions"),
  }),
  async (c) => c.json({ revisions: (await svc()).revisions(c.req.valid("param").id) }),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/documents/{id}/revisions/{revision}",
    tags,
    summary: "One revision with its content",
    request: {
      params: idParam.extend({ revision: z.coerce.number().int().min(1) }),
    },
    responses: ok("Revision"),
  }),
  async (c) => {
    const p = c.req.valid("param");
    return c.json((await svc()).revisionContent(p.id, p.revision));
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/documents/{id}/original",
    tags,
    summary: "Download the uploaded original file",
    request: {
      params: idParam,
      query: z.object({ revision: z.coerce.number().int().min(1).optional() }),
    },
    responses: { 200: { description: "File bytes" } },
  }),
  async (c) => {
    const original = (await svc()).original(
      kbContext(c),
      c.req.valid("param").id,
      c.req.valid("query").revision,
    );
    const file = Bun.file(original.path);
    if (!(await file.exists())) throw new NotFoundError("Original file", c.req.valid("param").id);
    return new Response(file, {
      headers: {
        "Content-Type": original.media_type,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(original.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/documents/{id}/reparse",
    tags,
    summary: "Re-extract with the currently selected parser",
    request: { params: idParam },
    responses: ok("Queued"),
  }),
  async (c) => c.json((await svc()).reparse(kbContext(c), c.req.valid("param").id)),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/documents/{id}/usage",
    tags,
    summary: "Read statistics for a document, by source and kind",
    request: { params: idParam },
    responses: ok("Usage"),
  }),
  async (c) => c.json((await svc()).documentUsage(c.req.valid("param").id)),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/citations/{handle}",
    tags,
    summary: "Resolve a citation handle (kb:<doc>@<rev>#<n>) to its passage",
    request: { params: z.object({ handle: z.string().min(1).max(200) }) },
    responses: ok("Passage"),
  }),
  async (c) => {
    const cite = parseCitation(c.req.valid("param").handle);
    if (!cite) throw new ValidationError("Citation must look like kb:<document>@<revision>#<n>");
    return c.json(
      (await svc()).readCitation(kbContext(c), cite.document_id, cite.revision, cite.ordinal),
    );
  },
);

// --- Retrieval -------------------------------------------------------------------------------

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/search",
    tags,
    summary: "Search documents (exact + full-text + vector, fused)",
    request: json(KbSearchSchema),
    responses: ok("Results"),
  }),
  async (c) => c.json(await (await svc()).search(kbContext(c), c.req.valid("json"))),
);

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/evidence",
    tags,
    summary: "Budgeted evidence pack with citations, for agents",
    request: json(KbEvidenceSchema),
    responses: ok("Evidence"),
  }),
  async (c) => c.json(await (await svc()).evidence(kbContext(c), c.req.valid("json"))),
);

// --- Status and settings ---------------------------------------------------------------------

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/status",
    tags,
    summary: "Knowledge status: counts, jobs, embeddings, parsers",
    responses: ok("Status"),
  }),
  async (c) => c.json((await svc()).status()),
);

const EmbeddingSettingsSchema = z
  .object({
    provider: z.enum(["none", "ollama", "openai"]),
    base_url: z
      .string()
      .url()
      .max(500)
      .refine((u) => /^https?:$/.test(new URL(u).protocol), "Use an http or https URL")
      .refine((u) => {
        const url = new URL(u);
        return !url.username && !url.password;
      }, "Do not put credentials in the URL; set the API key instead")
      .nullable(),
    model: z.string().max(200).nullable(),
    dimensions: z.number().int().min(8).max(8192).nullable(),
    /** A string sets the key (stored encrypted), null clears it, absent keeps it. Never returned. */
    api_key: z.string().max(500).nullable(),
    batch_size: z.number().int().min(1).max(512),
    timeout_secs: z.number().int().min(1).max(600),
  })
  .partial()
  .strict();

const KbSettingsSchema = z
  .object({
    parser: z.string().min(1).max(40),
    docling_enabled: z.boolean(),
    parser_timeout_secs: z.number().int().min(5).max(3600),
    max_upload_bytes: z.number().int().min(1024),
    usage_retention_days: z.number().int().min(1).max(3650),
    embedding: EmbeddingSettingsSchema,
  })
  .partial()
  .strict();

function publicSettings() {
  const k = loadConfig().knowledge;
  const { api_key, ...embedding } = k.embedding;
  return {
    root: k.root,
    parser: k.parser,
    docling_enabled: k.docling_enabled,
    parser_timeout_secs: k.parser_timeout_secs,
    max_upload_bytes: k.max_upload_bytes,
    usage_retention_days: k.usage_retention_days,
    embedding: { ...embedding, api_key_set: !!api_key },
    /** Environment variables override saved settings. */
    env_overrides: Object.keys(process.env).filter((k) => k.startsWith("ORC_KNOWLEDGE_")),
  };
}

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/settings",
    tags,
    summary: "Knowledge settings (API keys are never returned)",
    responses: ok("Settings"),
  }),
  (c) => c.json(publicSettings()),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/kb/settings",
    tags,
    summary: "Update parser and embedding settings; a new embedding profile re-embeds",
    request: json(KbSettingsSchema),
    responses: ok("Settings"),
  }),
  async (c) => {
    if (kbContext(c).source === "mcp")
      throw new ForbiddenError("Knowledge settings cannot be changed over MCP");
    const patch = c.req.valid("json");
    const service = await svc();
    if (
      patch.parser &&
      patch.parser !== "auto" &&
      !service.parsers().some((p) => p.id === patch.parser)
    )
      throw new ValidationError(`Unknown parser: ${patch.parser}`);
    updateGlobalConfig((raw) => {
      const k = (raw.knowledge ?? {}) as Record<string, unknown>;
      const { embedding, ...rest } = patch;
      Object.assign(k, rest);
      if (embedding) {
        const e = (k.embedding ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(embedding)) {
          if (value === null) delete e[key];
          else e[key] = key === "api_key" ? encryptSecret(value as string) : value;
        }
        k.embedding = e;
      }
      raw.knowledge = k;
    });
    // Queue embeddings for a changed profile and retry work that a setting may now unblock.
    service.reconcile();
    service.engine.kick();
    return c.json(publicSettings());
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/kb/parsers",
    tags,
    summary: "Available parsers, what they add and the Docling install state",
    responses: ok("Parsers"),
  }),
  async (c) => {
    const service = await svc();
    return c.json({ parsers: service.parsers(), docling: service.docling });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/kb/parsers/docling/install",
    tags,
    summary: "Install the optional Docling parser into the knowledge root (background)",
    responses: { 202: ok("Install started")[200] },
  }),
  async (c) => c.json((await svc()).installDocling(kbContext(c)), 202),
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/kb/parsers/docling",
    tags,
    summary: "Remove the installed Docling parser",
    responses: { 204: { description: "Removed" } },
  }),
  async (c) => {
    (await svc()).uninstallDocling(kbContext(c));
    return c.body(null, 204);
  },
);

export { app as knowledgeRouter };
