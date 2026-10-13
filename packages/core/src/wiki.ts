import { z } from "zod";

export const WIKI_PAGE_KINDS = ["lesson", "procedure", "decision", "concept"] as const;
export const WikiPageKindSchema = z.enum(WIKI_PAGE_KINDS);
export type WikiPageKind = z.infer<typeof WikiPageKindSchema>;

const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase-kebab-case")
  .max(100);

export const WikiWriteSchema = z.object({
  project_id: z.string().min(1).nullable(),
  slug: slugSchema,
  kind: WikiPageKindSchema,
  title: z.string().trim().min(1).max(200),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe("One line shown in the wiki index and search results"),
  content: z.string().trim().min(1).max(50000),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  sources: z
    .array(z.string().trim().min(1).max(500))
    .max(50)
    .default([])
    .describe("Where this came from: session/task IDs, files, commits, URLs"),
  note: z.string().trim().min(1).max(1000).describe("What changed in this revision and why"),
  expected_revision: z
    .number()
    .int()
    .min(0)
    .describe("Current revision of the page (0 to create). Mismatch means someone else edited it."),
  author: z.string().trim().min(1).max(200).optional(),
  session_id: z.string().trim().min(1).max(200).optional().describe("Session that produced it"),
});
export type WikiWrite = z.input<typeof WikiWriteSchema>;

export type WikiPage = {
  slug: string;
  project_id: string | null;
  kind: WikiPageKind;
  revision: number;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  sources: string[];
  author: string;
  updated_at: number;
};
export type WikiRevision = WikiPage & { note: string; session_id: string | null };
export type WikiIndexEntry = Pick<
  WikiPage,
  "slug" | "project_id" | "kind" | "title" | "summary" | "revision" | "tags" | "updated_at"
>;
export type WikiChange = Pick<
  WikiRevision,
  | "slug"
  | "project_id"
  | "title"
  | "kind"
  | "revision"
  | "note"
  | "author"
  | "session_id"
  | "updated_at"
>;
export type WikiSearchHit = WikiIndexEntry & { snippet: string; score: number };

export const SkillUpdateSchema = z.object({
  project_id: z.string().min(1).nullable(),
  skill_name: slugSchema,
  content: z
    .string()
    .min(1)
    .max(100000)
    .describe("Full new SKILL.md including frontmatter (name must stay the same)"),
  reason: z.string().trim().min(1).max(2000),
  expected_content: z
    .string()
    .max(100000)
    .describe("Current full SKILL.md; a mismatch rejects a stale edit"),
  session_id: z.string().min(1).max(200).optional(),
  wiki_pages: z.array(slugSchema).max(20).default([]),
  author: z.string().trim().min(1).max(200).optional(),
});
export type SkillUpdate = z.input<typeof SkillUpdateSchema>;

export type SkillActivation = {
  id: string;
  skill_name: string;
  raw: string;
  previous_raw: string;
  active: number;
  action: string;
  reason: string;
  created_at: number;
};

export const WikiScopeSchema = z.object({
  project_id: z.string().min(1).max(200).optional(),
  scope: z.literal("global").optional(),
});
export type WikiScope = z.infer<typeof WikiScopeSchema>;

export const WikiPageSchema = z.object({
  slug: slugSchema,
  project_id: z.string().nullable(),
  kind: WikiPageKindSchema,
  revision: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  sources: z.array(z.string()),
  author: z.string(),
  updated_at: z.number(),
});
export const WikiIndexEntrySchema = WikiPageSchema.pick({
  slug: true,
  project_id: true,
  kind: true,
  revision: true,
  title: true,
  summary: true,
  tags: true,
  updated_at: true,
});
export const WikiRevisionSchema = WikiPageSchema.extend({
  note: z.string(),
  session_id: z.string().nullable(),
});
export const WikiChangeSchema = WikiRevisionSchema.omit({
  summary: true,
  content: true,
  tags: true,
  sources: true,
});
export const WikiSearchHitSchema = WikiIndexEntrySchema.extend({
  snippet: z.string(),
  score: z.number(),
});
