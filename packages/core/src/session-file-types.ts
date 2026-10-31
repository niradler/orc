import { z } from "zod";

export const UPLOAD_MAX_BYTES = 20_000_000;
export const UPLOAD_MAX_FILES = 10;
export const SessionFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  description: z.string().max(1000).optional(),
});
export type SessionFile = z.infer<typeof SessionFileSchema>;
export type UploadFile = { name: string; mimeType: string; data: Uint8Array; description?: string };
export const UploadDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (path) => !Array.from(path).some((character) => character.charCodeAt(0) < 32),
    "Invalid upload directory",
  );
