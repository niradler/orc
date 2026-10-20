import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConflictError, NotFoundError, UnauthorizedError } from "@orc/core/errors";
import { SKILL_DOWNLOAD_TTL_MS, type SkillDownload } from "@orc/core/skill-download";
import { validateSkillPath } from "@orc/core/skill-files";
import type { SkillRefContent } from "@orc/core/skill-service";
import { getSqlite } from "@orc/db/client";
import { SkillHistory } from "@orc/db/skill-history";
import { z } from "zod";

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
  private readonly key = randomBytes(32);
  constructor(private readonly now: () => number = Date.now) {}

  mint(name: string, ref: string, projectId: string | null, origin: string): SkillDownload {
    const bytes = fileBytes(name, ref, projectId);
    const claim = ClaimSchema.parse({
      name,
      ref,
      project_id: projectId,
      sha256: hash(bytes),
      expires: this.now() + SKILL_DOWNLOAD_TTL_MS,
    });
    const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
    const token = `${payload}.${this.sign(payload)}`;
    return {
      download_url: new URL(`/api/skills/download/${token}`, origin).toString(),
      filename: ref.split("/").at(-1) as string,
      size_bytes: bytes.length,
      sha256: claim.sha256,
      expires_at: new Date(claim.expires).toISOString(),
    };
  }

  read(token: string): { bytes: Buffer; filename: string } {
    if (token.length > 4096) throw new UnauthorizedError();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) throw new UnauthorizedError();
    const expected = this.sign(payload);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      throw new UnauthorizedError();
    let claim: z.infer<typeof ClaimSchema>;
    try {
      claim = ClaimSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    } catch {
      throw new UnauthorizedError();
    }
    if (claim.expires <= this.now()) throw new UnauthorizedError();
    const bytes = fileBytes(claim.name, claim.ref, claim.project_id);
    if (hash(bytes) !== claim.sha256)
      throw new ConflictError("Skill file changed; request a fresh download URL");
    return { bytes, filename: claim.ref.split("/").at(-1) as string };
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }
}

export const skillDownloads = new SkillDownloads();
