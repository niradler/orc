import { createHash } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "@orc/core/errors";
import {
  MAX_SKILL_DOWNLOAD_TOKEN_CHARS,
  SKILL_DOWNLOAD_TTL_MS,
  type SkillDownload,
} from "@orc/core/skill-download";
import { validateSkillPath } from "@orc/core/skill-files";
import type { SkillRefContent } from "@orc/core/skill-service";
import { getSqlite } from "@orc/db/client";
import { SkillHistory } from "@orc/db/skill-history";
import { z } from "zod";
import { TokenSigner } from "./lib/signed-token.js";

const ClaimSchema = z
  .object({
    name: z.string().min(1).max(64),
    ref: z.string().min(1).max(1024),
    project_id: z.string().nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    expires: z.number().int(),
  })
  .strict();

function fileBytes(name: string, ref: string, projectId: string | null): Buffer {
  validateSkillPath(ref);
  const file = new SkillHistory(getSqlite()).read(name, projectId, ref) as SkillRefContent | null;
  if (!file) throw new NotFoundError("Skill file", ref);
  return Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8");
}

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Process-local key deliberately invalidates capabilities after an API restart. */
export class SkillDownloads {
  private readonly signer: TokenSigner<z.infer<typeof ClaimSchema>>;
  constructor(now: () => number = Date.now) {
    this.signer = new TokenSigner(ClaimSchema, MAX_SKILL_DOWNLOAD_TOKEN_CHARS, now);
  }

  mint(name: string, ref: string, projectId: string | null, origin: string): SkillDownload {
    const bytes = fileBytes(name, ref, projectId);
    const claim = {
      name,
      ref,
      project_id: projectId,
      sha256: hash(bytes),
      expires: this.signer.expiresAt(SKILL_DOWNLOAD_TTL_MS),
    };
    const token = this.signer.sign(claim);
    if (!token) throw new ValidationError("Skill file scope exceeds the download URL limit");
    return {
      download_url: new URL(`/api/skills/download/${token}`, origin).toString(),
      filename: ref.split("/").at(-1) as string,
      size_bytes: bytes.length,
      sha256: claim.sha256,
      expires_at: new Date(claim.expires).toISOString(),
    };
  }

  read(token: string): { bytes: Buffer; filename: string } {
    const claim = this.signer.verify(token);
    const bytes = fileBytes(claim.name, claim.ref, claim.project_id);
    if (hash(bytes) !== claim.sha256)
      throw new ConflictError("Skill file changed; request a fresh download URL");
    return { bytes, filename: claim.ref.split("/").at(-1) as string };
  }
}

export const skillDownloads = new SkillDownloads();
