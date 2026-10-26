import { createRoute, z } from "@hono/zod-openapi";
import {
  MAX_SCRATCHPAD_TOKEN_CHARS,
  SCRATCHPAD_CONTENT_MAX_BYTES,
  SCRATCHPAD_FILES,
  ScratchpadContentUrlSchema,
  ScratchpadCreateSchema,
  ScratchpadKindSchema,
  ScratchpadListItemSchema,
  ScratchpadSchema,
  ScratchpadUpdateSchema,
  scratchpadFilename,
} from "@orc/core/scratchpad";
import { getSqlite } from "@orc/db/client";
import { ScratchpadStore } from "@orc/db/scratchpads";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { clientOrigin } from "../lib/client-origin.js";
import { createRouter } from "../lib/router.js";
import { scratchpadContentUrls } from "../scratchpad-content.js";

const app = createRouter();
const API_AUTHOR = "api";

const tooLarge = (c: Context, max: number) =>
  c.json({ error: `Request exceeds ${max} bytes`, code: "TOO_LARGE" }, 413);
// Raw uploads are capped at the content limit; JSON bodies get headroom for string escaping.
const RAW_MAX = SCRATCHPAD_CONTENT_MAX_BYTES;
const JSON_MAX = SCRATCHPAD_CONTENT_MAX_BYTES * 2 + 64 * 1024;
app.use(
  "/scratchpads/content/*",
  bodyLimit({ maxSize: RAW_MAX, onError: (c) => tooLarge(c, RAW_MAX) }),
);
app.use("/scratchpads", bodyLimit({ maxSize: JSON_MAX, onError: (c) => tooLarge(c, JSON_MAX) }));
app.use("/scratchpads/*", bodyLimit({ maxSize: JSON_MAX, onError: (c) => tooLarge(c, JSON_MAX) }));

const Pad = ScratchpadSchema;
const PadListItem = ScratchpadListItemSchema;
const IdParam = z.object({ id: z.string().min(1).max(64) });
const TokenParam = z.object({ token: z.string().max(MAX_SCRATCHPAD_TOKEN_CHARS) });

const store = (): ScratchpadStore => new ScratchpadStore(getSqlite());

app.openapi(
  createRoute({
    method: "get",
    path: "/scratchpads",
    tags: ["Scratchpads"],
    summary: "List scratchpads, most recently updated first (without content)",
    request: {
      query: z.object({
        kind: ScratchpadKindSchema.optional(),
        project_id: z.string().min(1).optional(),
        unassigned: z
          .enum(["true", "false"])
          .optional()
          .openapi({ description: "true lists only pads without a project" }),
        session_id: z.string().min(1).optional(),
        tag: z.string().min(1).optional(),
        q: z.string().optional().openapi({ description: "Search title and content" }),
        limit: z.coerce.number().int().min(1).max(500).optional().default(100),
      }),
    },
    responses: {
      200: {
        description: "Scratchpads",
        content: {
          "application/json": {
            schema: z.object({ scratchpads: z.array(PadListItem), total: z.number().int() }),
          },
        },
      },
    },
  }),
  (c) => {
    const { limit, unassigned, project_id, ...query } = c.req.valid("query");
    const pads = store().list({
      ...query,
      project_id: unassigned === "true" ? null : project_id,
    });
    return c.json({ scratchpads: pads.slice(0, limit), total: pads.length });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/scratchpads",
    tags: ["Scratchpads"],
    summary: "Create a scratchpad (doc = markdown, diagram = .excalidraw JSON, html = page)",
    request: {
      body: {
        content: {
          "application/json": { schema: ScratchpadCreateSchema },
        },
      },
    },
    responses: {
      201: { description: "Created", content: { "application/json": { schema: Pad } } },
      400: { description: "Validation error" },
      404: { description: "Project not found" },
      413: { description: "Request too large" },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    return c.json(store().create({ ...input, author: input.author ?? API_AUTHOR }), 201);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/scratchpads/{id}",
    tags: ["Scratchpads"],
    summary: "Read a scratchpad with its content",
    request: { params: IdParam },
    responses: {
      200: { description: "Scratchpad", content: { "application/json": { schema: Pad } } },
      404: { description: "Scratchpad not found" },
    },
  }),
  (c) => c.json(store().get(c.req.valid("param").id)),
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/scratchpads/{id}",
    tags: ["Scratchpads"],
    summary: "Update a scratchpad; pass if_revision to refuse overwriting someone else's change",
    request: {
      params: IdParam,
      body: {
        content: {
          "application/json": { schema: ScratchpadUpdateSchema },
        },
      },
    },
    responses: {
      200: { description: "Updated", content: { "application/json": { schema: Pad } } },
      400: { description: "Validation error" },
      404: { description: "Scratchpad or project not found" },
      409: { description: "The scratchpad moved past if_revision" },
      413: { description: "Request too large" },
    },
  }),
  (c) => {
    const input = c.req.valid("json");
    return c.json(
      store().update(c.req.valid("param").id, { ...input, author: input.author ?? API_AUTHOR }),
    );
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/scratchpads/{id}",
    tags: ["Scratchpads"],
    summary: "Delete a scratchpad",
    request: { params: IdParam },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Scratchpad not found" },
    },
  }),
  (c) => {
    store().remove(c.req.valid("param").id);
    return c.body(null, 204);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/scratchpads/{id}/content-url",
    tags: ["Scratchpads"],
    summary: "Mint a short-lived URL to GET or PUT the raw file without the API secret",
    request: {
      params: IdParam,
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                mode: z.enum(["download", "upload"]),
                author: z
                  .string()
                  .min(1)
                  .max(200)
                  .optional()
                  .openapi({ description: "Recorded as the author of an upload" }),
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Content capability; keep its URL private",
        content: {
          "application/json": {
            schema: ScratchpadContentUrlSchema,
          },
        },
      },
      404: { description: "Scratchpad not found" },
    },
  }),
  (c) => {
    const { mode, author } = c.req.valid("json");
    const pad = store().get(c.req.valid("param").id);
    c.header("Cache-Control", "no-store");
    return c.json(
      scratchpadContentUrls.mint(pad, mode, clientOrigin(c.req.raw), author ?? API_AUTHOR),
    );
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/scratchpads/content/{token}",
    tags: ["Scratchpads"],
    summary: "Download a scratchpad's current file using a signed URL",
    request: { params: TokenParam },
    responses: {
      200: {
        description: "The file; X-Scratchpad-Revision names its revision",
        content: {
          "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
        },
      },
      401: { description: "Invalid or expired URL" },
      404: { description: "Scratchpad deleted" },
    },
  }),
  (c) => {
    const claim = scratchpadContentUrls.verify(c.req.valid("param").token, "download");
    const pad = store().get(claim.id);
    const filename = scratchpadFilename(pad.title, pad.kind);
    c.header("Content-Type", SCRATCHPAD_FILES[pad.kind].mime);
    c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    c.header("X-Scratchpad-Revision", String(pad.revision));
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    // An html pad must never run on the API origin, even if opened directly.
    c.header("Content-Security-Policy", "sandbox");
    return c.body(pad.content);
  },
);

app.openapi(
  createRoute({
    method: "put",
    path: "/scratchpads/content/{token}",
    tags: ["Scratchpads"],
    summary: "Replace a scratchpad's file with the raw request body using a signed URL",
    request: { params: TokenParam },
    responses: {
      200: {
        description: "Stored",
        content: {
          "application/json": {
            schema: z.object({
              id: z.string(),
              revision: z.number().int(),
              size_bytes: z.number().int(),
              updated_at: z.number().int(),
            }),
          },
        },
      },
      400: { description: "Content the pad's kind cannot open" },
      401: { description: "Invalid or expired URL" },
      404: { description: "Scratchpad deleted" },
      409: { description: "The scratchpad changed since the URL was minted" },
      413: { description: "File too large" },
    },
  }),
  async (c) => {
    const claim = scratchpadContentUrls.verify(c.req.valid("param").token, "upload");
    const content = await c.req.text();
    const pad = store().update(claim.id, {
      content,
      if_revision: claim.revision,
      author: claim.author,
    });
    return c.json({
      id: pad.id,
      revision: pad.revision,
      size_bytes: Buffer.byteLength(pad.content, "utf8"),
      updated_at: pad.updated_at,
    });
  },
);

export { app as scratchpadsRouter };
