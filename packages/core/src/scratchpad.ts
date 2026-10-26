import { z } from "zod";
import { ValidationError } from "./errors.js";

// A scratchpad is working material a human or agent keeps and revisits: a markdown doc, an
// Excalidraw diagram or a standalone HTML page. Content is the file itself, so agents round-trip
// it with ordinary file tools (`.md`, `.excalidraw`, `.html`).

export const SCRATCHPAD_KINDS = ["doc", "diagram", "html"] as const;
export const ScratchpadKindSchema = z.enum(SCRATCHPAD_KINDS);
export type ScratchpadKind = z.infer<typeof ScratchpadKindSchema>;

export const SCRATCHPAD_TITLE_MAX = 200;
export const SCRATCHPAD_TAGS_MAX = 20;
/** `.excalidraw` files embed pasted images as data URLs, so the cap is generous. */
export const SCRATCHPAD_CONTENT_MAX_BYTES = 5 * 1024 * 1024;
export const SCRATCHPAD_CONTENT_URL_TTL_MS = 10 * 60_000;
export const MAX_SCRATCHPAD_TOKEN_CHARS = 1024;
export const SCRATCHPAD_CONTENT_PATH_PATTERN =
  /^\/api\/scratchpads\/content\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

export const SCRATCHPAD_FILES: Record<ScratchpadKind, { extension: string; mime: string }> = {
  doc: { extension: ".md", mime: "text/markdown; charset=utf-8" },
  diagram: { extension: ".excalidraw", mime: "application/json; charset=utf-8" },
  html: { extension: ".html", mime: "text/html; charset=utf-8" },
};

export function emptyScratchpadContent(kind: ScratchpadKind): string {
  if (kind !== "diagram") return "";
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "orc",
    elements: [],
    appState: {},
    files: {},
  });
}

const ExcalidrawSceneSchema = z.looseObject({
  type: z.literal("excalidraw"),
  elements: z.array(z.record(z.string(), z.unknown())),
  appState: z.record(z.string(), z.unknown()).optional(),
  files: z.record(z.string(), z.unknown()).optional(),
});

/** Rejects content a kind's editor could not open; size is checked for every kind. */
export function validateScratchpadContent(kind: ScratchpadKind, content: string): void {
  // The dashboard imports this module, so it sticks to web APIs.
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > SCRATCHPAD_CONTENT_MAX_BYTES)
    throw new ValidationError(
      `Scratchpad content is ${bytes} bytes; the limit is ${SCRATCHPAD_CONTENT_MAX_BYTES}`,
    );
  if (kind !== "diagram") return;
  let scene: unknown;
  try {
    scene = JSON.parse(content);
  } catch {
    throw new ValidationError("Diagram content must be an .excalidraw JSON file");
  }
  if (!ExcalidrawSceneSchema.safeParse(scene).success)
    throw new ValidationError(
      'Diagram content must be an .excalidraw file: { "type": "excalidraw", "elements": [...] }',
    );
}

export function scratchpadFilename(title: string, kind: ScratchpadKind): string {
  const base =
    title
      .normalize("NFKD")
      .replace(/[^\w\s.-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 80) || "scratchpad";
  return `${base}${SCRATCHPAD_FILES[kind].extension}`;
}

const TitleSchema = z.string().trim().min(1).max(SCRATCHPAD_TITLE_MAX);
const TagsSchema = z.array(z.string().min(1).max(64)).max(SCRATCHPAD_TAGS_MAX);
const SessionIdSchema = z.string().min(1).max(200);

export const ScratchpadSchema = z.object({
  id: z.string(),
  kind: ScratchpadKindSchema,
  title: z.string(),
  content: z.string(),
  project_id: z.string().nullable(),
  /** Native session id of the agent session the pad came from; the pad outlives it. */
  session_id: z.string().nullable(),
  tags: z.array(z.string()),
  author: z.string(),
  revision: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Scratchpad = z.infer<typeof ScratchpadSchema>;

export const ScratchpadListItemSchema = ScratchpadSchema.omit({ content: true }).extend({
  size_bytes: z.number().int(),
});
export type ScratchpadListItem = z.infer<typeof ScratchpadListItemSchema>;

export const ScratchpadCreateSchema = z
  .object({
    kind: ScratchpadKindSchema,
    title: TitleSchema,
    content: z.string().optional(),
    project_id: z.string().min(1).nullable().optional(),
    session_id: SessionIdSchema.nullable().optional(),
    tags: TagsSchema.optional(),
    author: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ScratchpadCreate = z.infer<typeof ScratchpadCreateSchema>;

export const ScratchpadUpdateSchema = z
  .object({
    title: TitleSchema.optional(),
    content: z.string().optional(),
    project_id: z.string().min(1).nullable().optional(),
    session_id: SessionIdSchema.nullable().optional(),
    tags: TagsSchema.optional(),
    author: z.string().min(1).max(200).optional(),
    /** Optimistic concurrency: the write fails with 409 unless the pad is still at this revision. */
    if_revision: z.number().int().min(1).optional(),
  })
  .strict();
export type ScratchpadUpdate = z.infer<typeof ScratchpadUpdateSchema>;

export type ScratchpadListQuery = {
  kind?: ScratchpadKind | undefined;
  /** A project id, or null for pads without a project; omitted lists every pad. */
  project_id?: string | null | undefined;
  session_id?: string | undefined;
  tag?: string | undefined;
  /** Case-insensitive match on title and content. */
  q?: string | undefined;
};

export const ScratchpadContentUrlSchema = z.object({
  /** GET returns the raw file. */
  download_url: z.string().url().optional(),
  /** PUT the raw file as the request body; rejected once the pad moves past `revision`. */
  upload_url: z.string().url().optional(),
  filename: z.string(),
  revision: z.number().int(),
  expires_at: z.string().datetime(),
});
export type ScratchpadContentUrl = z.infer<typeof ScratchpadContentUrlSchema>;
