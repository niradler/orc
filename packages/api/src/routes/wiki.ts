import { createRoute, z } from "@hono/zod-openapi";
import { NotFoundError } from "@orc/core/errors";
import {
  WikiChangeSchema,
  WikiIndexEntrySchema,
  WikiPageSchema,
  WikiRevisionSchema,
  type WikiScope,
  WikiScopeSchema,
  WikiSearchHitSchema,
  WikiWriteSchema,
} from "@orc/core/wiki";
import { getSqlite } from "@orc/db/client";
import { WikiStore } from "@orc/db/wiki";
import { createRouter } from "../lib/router.js";

const app = createRouter();
const slugParams = WikiWriteSchema.pick({ slug: true });
const limitedScope = WikiScopeSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function resolveWikiProject(input: WikiScope): string | null {
  if (input.scope === "global" || !input.project_id) return null;
  if (!getSqlite().query("SELECT id FROM projects WHERE id = ?").get(input.project_id))
    throw new NotFoundError("Project", input.project_id);
  return input.project_id;
}

app.openapi(
  createRoute({
    method: "get",
    path: "/wiki",
    tags: ["Wiki"],
    summary: "List visible wiki summaries; project pages shadow global slugs",
    request: { query: WikiScopeSchema },
    responses: {
      200: {
        description: "Wiki index",
        content: {
          "application/json": {
            schema: z.object({
              pages: z.array(z.object(WikiIndexEntrySchema.shape).openapi("WikiIndexEntry")),
            }),
          },
        },
      },
    },
  }),
  (c) =>
    c.json({ pages: new WikiStore(getSqlite()).list(resolveWikiProject(c.req.valid("query"))) }),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/wiki/changes",
    tags: ["Wiki"],
    summary: "What ORC learned: recent wiki revisions",
    request: { query: limitedScope },
    responses: {
      200: {
        description: "Recent learning",
        content: {
          "application/json": {
            schema: z.object({
              changes: z.array(z.object(WikiChangeSchema.shape).openapi("WikiChange")),
            }),
          },
        },
      },
    },
  }),
  (c) => {
    const input = c.req.valid("query");
    return c.json({
      changes: new WikiStore(getSqlite()).changes(resolveWikiProject(input), input.limit),
    });
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/wiki/search",
    tags: ["Wiki"],
    summary: "Search visible wiki pages without returning full content",
    request: { query: limitedScope.extend({ q: z.string().trim().min(1).max(2000) }) },
    responses: {
      200: {
        description: "Wiki search",
        content: {
          "application/json": {
            schema: z.object({
              results: z.array(z.object(WikiSearchHitSchema.shape).openapi("WikiSearchHit")),
            }),
          },
        },
      },
    },
  }),
  (c) => {
    const input = c.req.valid("query");
    return c.json({
      results: new WikiStore(getSqlite()).search(input.q, {
        projectId: resolveWikiProject(input),
        limit: input.limit,
      }),
    });
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/wiki",
    tags: ["Wiki"],
    summary: "Write a wiki revision; stale expected_revision returns 409",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object(WikiWriteSchema.shape).strict().openapi("WikiWrite"),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Updated revision",
        content: {
          "application/json": {
            schema: z.object(WikiRevisionSchema.shape).openapi("WikiRevision"),
          },
        },
      },
      201: {
        description: "Created page",
        content: { "application/json": { schema: WikiRevisionSchema } },
      },
      409: { description: "Revision changed; reload before retrying" },
    },
  }),
  (c) => {
    const page = new WikiStore(getSqlite()).write({
      ...c.req.valid("json"),
      author: c.req.valid("json").author ?? "api",
    });
    return c.json(page, page.revision === 1 ? 201 : 200);
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/wiki/{slug}/history",
    tags: ["Wiki"],
    summary: "Read the resolved page's immutable revision history",
    request: { params: slugParams, query: WikiScopeSchema },
    responses: {
      200: {
        description: "Revision history",
        content: {
          "application/json": { schema: z.object({ revisions: z.array(WikiRevisionSchema) }) },
        },
      },
      404: { description: "Page not found" },
    },
  }),
  (c) =>
    c.json({
      revisions: new WikiStore(getSqlite()).history(
        resolveWikiProject(c.req.valid("query")),
        c.req.valid("param").slug,
      ),
    }),
);

app.openapi(
  createRoute({
    method: "get",
    path: "/wiki/{slug}",
    tags: ["Wiki"],
    summary: "Read full wiki content on demand",
    request: { params: slugParams, query: WikiScopeSchema },
    responses: {
      200: {
        description: "Wiki page",
        content: {
          "application/json": { schema: z.object(WikiPageSchema.shape).openapi("WikiPage") },
        },
      },
      404: { description: "Page not found" },
    },
  }),
  (c) =>
    c.json(
      new WikiStore(getSqlite()).get(
        resolveWikiProject(c.req.valid("query")),
        c.req.valid("param").slug,
      ),
    ),
);

export { app as wikiRouter };
