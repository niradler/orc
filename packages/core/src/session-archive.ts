import { z } from "zod";
import { SessionBundleSchema } from "./session-handoff.js";

export const ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;
export const SESSION_SYNC_PATH_PATTERN =
  /^\/api\/session-sync\/[A-Za-z0-9_-]{43}\/(projects|manifest|upload)$/;
export const SessionSyncInputSchema = z
  .object({ projects: z.array(z.string().trim().min(1).max(100)).min(1).max(100).optional() })
  .strict();
export const ArchiveMetadataSchema = z
  .object({
    cwd: z.string().max(4096).optional(),
    repository: z
      .string()
      .max(2048)
      .refine((v) => {
        try {
          const u = new URL(v);
          return (
            !u.password && !u.search && !u.hash && (!/^https?:$/.test(u.protocol) || !u.username)
          );
        } catch {
          return true;
        }
      }, "Remove repository credentials, query and fragment")
      .optional(),
    branch: z.string().max(1024).optional(),
    commit: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .optional(),
    subdirectory: z.string().max(1024).default(""),
    parent_id: z.string().max(256).optional(),
    agent_version: z.string().max(100).optional(),
    started_at: z.string().datetime({ offset: true }).optional(),
    ended_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export const ArchiveIdentitySchema = z
  .object({
    project: z.string().trim().min(1).max(200),
    source_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    agent: z.enum(["claude", "codex"]),
    session_id: z.uuid(),
  })
  .strict();
export const ArchiveUploadSchema = ArchiveIdentitySchema.extend({
  title: z.string().trim().min(1).max(200),
  metadata: ArchiveMetadataSchema.default({ subdirectory: "" }),
  expected_revision: z.number().int().nonnegative().optional(),
  reindex: z.boolean().optional(),
  bundle: SessionBundleSchema,
}).strict();
export type ArchiveUpload = z.output<typeof ArchiveUploadSchema>;
export type ArchiveUploadInput = z.input<typeof ArchiveUploadSchema>;
export type ArchiveMetadata = z.output<typeof ArchiveMetadataSchema>;
export const ArchiveSearchSchema = z
  .object({
    q: z.string().trim().max(2000).default(""),
    project_id: z.string().max(100).optional(),
    project_ids: z
      .string()
      .max(10000)
      .refine((value) => {
        const ids = value.split(",").map((id) => id.trim());
        return ids.length <= 50 && ids.every((id) => id.length > 0 && id.length <= 100);
      }, "Use 1-50 comma-separated project IDs of 1-100 characters")
      .optional(),
    agent: z.enum(["claude", "codex"]).optional(),
    mode: z.enum(["auto", "lexical", "semantic", "hybrid"]).default("auto"),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
  })
  .strict();
export type ArchiveSearch = z.output<typeof ArchiveSearchSchema>;
export type ArchiveSession = {
  id: string;
  project_id: string | null;
  source_id: string;
  agent: "claude" | "codex";
  native_id: string;
  title: string;
  metadata: ArchiveMetadata;
  revision: number;
  content_hash: string;
  index_revision: number;
  embedding_error: string | null;
  created_at: string;
  updated_at: string;
};
export type ArchivePassage = {
  citation: string;
  ordinal: number;
  text: string;
  snippet: string;
  turn: number;
  file: string;
};
export type ArchiveSearchResult = {
  sessions: (ArchiveSession & { score: number; passages: ArchivePassage[] })[];
  mode: "lexical" | "hybrid" | "semantic";
  degraded?: string;
  pending_chunks: number;
  offset: number;
  has_more: boolean;
};
