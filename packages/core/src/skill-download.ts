import { z } from "zod";

export const SKILL_DOWNLOAD_TTL_MS = 10 * 60_000;
// A 1024-character UTF-8 path can exceed 4096 characters once its claim is base64url encoded.
export const MAX_SKILL_DOWNLOAD_TOKEN_CHARS = 8192;
export const SKILL_DOWNLOAD_PATH_PATTERN =
  /^\/api\/skills\/download\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

export const SkillDownloadSchema = z.object({
  download_url: z.string().url(),
  filename: z.string(),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.string().datetime(),
});
export type SkillDownload = z.infer<typeof SkillDownloadSchema>;
