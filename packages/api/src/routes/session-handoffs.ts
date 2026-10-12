import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { UnauthorizedError, ValidationError } from "@orc/core/errors";
import {
  HANDOFF_ID_PATTERN,
  MAX_HANDOFF_BYTES,
  SessionBundleSchema,
  SessionHandoffInputSchema,
  SessionHandoffSchema,
  SessionHandoffUploadSchema,
} from "@orc/core/session-handoff";
import { getHandoffService, handoffDto, requireHandoffAuth } from "../handoffs/service.js";

const app = new OpenAPIHono();
const params = z.object({ id: z.string().regex(HANDOFF_ID_PATTERN) });
const response = {
  description: "Session handoff",
  content: { "application/json": { schema: SessionHandoffSchema } },
};

// Bound the actual stream before OpenAPI's JSON validator buffers or parses it.
app.use("/session-handoffs/:id/upload", async (c, next) => {
  if (c.req.method !== "PUT") return next();
  const id = c.req.param("id");
  const token = c.req.query("token") ?? "";
  if (!id || !HANDOFF_ID_PATTERN.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new UnauthorizedError();
  await getHandoffService().authorizeUpload(id, token);
  if (!c.req.header("Content-Type")?.toLowerCase().startsWith("application/json"))
    throw new ValidationError("Upload requires application/json");
  if (Number(c.req.header("Content-Length") ?? "0") > MAX_HANDOFF_BYTES)
    throw new ValidationError("Session bundle exceeds upload size limit");
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ValidationError("Session bundle is missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_HANDOFF_BYTES) {
        await reader.cancel();
        throw new ValidationError("Session bundle exceeds upload size limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  c.req.raw = new Request(c.req.raw, { body: Buffer.concat(chunks) });
  return next();
});

app.openapi(
  createRoute({
    method: "post",
    path: "/session-handoffs",
    tags: ["Sessions"],
    summary: "Request a temporary upload link after committing and pushing the handoff branch",
    request: { body: { content: { "application/json": { schema: SessionHandoffInputSchema } } } },
    responses: {
      201: {
        description: "Upload capability",
        content: { "application/json": { schema: SessionHandoffUploadSchema } },
      },
    },
  }),
  async (c) => {
    const { row, token } = await getHandoffService().create(c.req.valid("json"));
    const url = new URL(`/api/session-handoffs/${row.id}/upload`, c.req.url);
    url.searchParams.set("token", token);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        ...handoffDto(row),
        upload_url: url.toString(),
        upload_method: "PUT" as const,
        max_bytes: MAX_HANDOFF_BYTES,
      },
      201,
    );
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/session-handoffs/{id}",
    tags: ["Sessions"],
    summary: "Inspect a handoff without exposing its upload capability",
    request: { params },
    responses: { 200: response },
  }),
  async (c) => {
    requireHandoffAuth();
    c.header("Cache-Control", "no-store");
    return c.json(handoffDto(await getHandoffService().get(c.req.valid("param").id)), 200);
  },
);

app.openapi(
  createRoute({
    method: "put",
    path: "/session-handoffs/{id}/upload",
    tags: ["Sessions"],
    summary: "Upload a native session bundle using a single-use temporary capability",
    request: {
      params,
      query: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      body: { content: { "application/json": { schema: SessionBundleSchema } } },
    },
    responses: { 200: response },
  }),
  async (c) => {
    const { token } = c.req.valid("query");
    if (!token) throw new UnauthorizedError();
    const row = await getHandoffService().upload(
      c.req.valid("param").id,
      token,
      c.req.valid("json"),
    );
    c.header("Cache-Control", "no-store");
    return c.json(handoffDto(row), 200);
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/session-handoffs/{id}/prepare",
    tags: ["Sessions"],
    summary: "Retry preparation of an uploaded handoff; ready handoffs are returned unchanged",
    request: { params },
    responses: { 200: response },
  }),
  async (c) => {
    requireHandoffAuth();
    return c.json(handoffDto(await getHandoffService().prepare(c.req.valid("param").id)), 200);
  },
);

export { app as sessionHandoffsRouter };
