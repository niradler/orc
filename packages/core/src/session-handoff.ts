import { z } from "zod";
import { ID_LEN } from "./id-format.js";

export const HANDOFF_ID_PATTERN = new RegExp(`^[a-z0-9]{${ID_LEN}}$`);
export const HANDOFF_UPLOAD_PATH_PATTERN = new RegExp(
  `^/api/session-handoffs/[a-z0-9]{${ID_LEN}}/upload$`,
);

export const MAX_HANDOFF_BYTES = 64 * 1024 * 1024;
export const HANDOFF_TTL_MS = 15 * 60 * 1000;

export const SessionHandoffInputSchema = z
  .object({
    project: z.string().trim().min(1).max(200),
    agent: z.enum(["claude", "codex"]),
    session_id: z.uuid(),
    source_cwd: z.string().min(1).max(4096),
    subdirectory: z
      .string()
      .max(4096)
      .default("")
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !/[\\:]/.test(value) &&
          !value.includes("\0") &&
          value.split("/").every((part) => part !== ".." && part !== "."),
        "Expected a relative repository subdirectory",
      ),
    repository: z.string().trim().min(1).max(2048),
    remote: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
      .default("origin"),
    branch: z.string().min(1).max(1024),
    commit: z
      .string()
      .regex(/^[a-fA-F0-9]{40}$/)
      .transform((value) => value.toLowerCase()),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const SessionBundleSchema = z
  .object({
    version: z.literal(1),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            content: z.string().min(1).max(MAX_HANDOFF_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(128),
  })
  .strict();

export const SessionHandoffSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable(),
  agent: z.enum(["claude", "codex"]),
  source_session_id: z.string(),
  session_id: z.string(),
  host: z.string().nullable(),
  branch: z.string(),
  commit: z.string(),
  status: z.enum(["pending", "uploading", "uploaded", "preparing", "ready", "resumed", "error"]),
  cwd: z.string().nullable(),
  live_session_id: z.string().nullable(),
  error: z.string().nullable(),
  expires_at: z.string(),
});

export const SessionHandoffUploadSchema = SessionHandoffSchema.extend({
  upload_url: z.string(),
  upload_method: z.literal("PUT"),
  max_bytes: z.number(),
});

export type SessionHandoffInput = z.input<typeof SessionHandoffInputSchema>;
export type SessionHandoffRequest = z.output<typeof SessionHandoffInputSchema>;
export type SessionBundle = z.infer<typeof SessionBundleSchema>;
export type SessionHandoff = z.infer<typeof SessionHandoffSchema>;
export type SessionHandoffUpload = z.infer<typeof SessionHandoffUploadSchema>;
