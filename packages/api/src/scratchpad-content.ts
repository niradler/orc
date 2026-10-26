import { ValidationError } from "@orc/core/errors";
import {
  MAX_SCRATCHPAD_TOKEN_CHARS,
  SCRATCHPAD_CONTENT_URL_TTL_MS,
  type Scratchpad,
  type ScratchpadContentUrl,
  scratchpadFilename,
} from "@orc/core/scratchpad";
import { z } from "zod";
import { TokenSigner } from "./lib/signed-token.js";

const ClaimSchema = z
  .object({
    id: z.string().min(1).max(64),
    mode: z.enum(["download", "upload"]),
    /** Upload: the revision the write must still find, so a replayed or stale upload is a 409. */
    revision: z.number().int().min(1),
    author: z.string().min(1).max(200),
    expires: z.number().int(),
  })
  .strict();
export type ScratchpadContentClaim = z.infer<typeof ClaimSchema>;
export type ScratchpadContentMode = ScratchpadContentClaim["mode"];

/**
 * Signed URLs that move a pad's file without the API secret, so an agent can stream large
 * content with curl instead of through tool-call arguments.
 */
export class ScratchpadContentUrls {
  private readonly signer: TokenSigner<ScratchpadContentClaim>;
  constructor(now: () => number = Date.now) {
    this.signer = new TokenSigner(ClaimSchema, MAX_SCRATCHPAD_TOKEN_CHARS, now);
  }

  mint(
    pad: Scratchpad,
    mode: ScratchpadContentMode,
    origin: string,
    author: string,
  ): ScratchpadContentUrl {
    const claim: ScratchpadContentClaim = {
      id: pad.id,
      mode,
      revision: pad.revision,
      author,
      expires: this.signer.expiresAt(SCRATCHPAD_CONTENT_URL_TTL_MS),
    };
    const token = this.signer.sign(claim);
    if (!token) throw new ValidationError("Scratchpad writer exceeds the content URL limit");
    const url = new URL(`/api/scratchpads/content/${token}`, origin).toString();
    return {
      ...(mode === "download" ? { download_url: url } : { upload_url: url }),
      filename: scratchpadFilename(pad.title, pad.kind),
      revision: pad.revision,
      expires_at: new Date(claim.expires).toISOString(),
    };
  }

  /** Throws 401 unless the token is genuine, unexpired and minted for `mode`. */
  verify(token: string, mode: ScratchpadContentMode): ScratchpadContentClaim {
    const claim = this.signer.verify(token);
    if (claim.mode !== mode)
      throw new ValidationError(`This content URL is for ${claim.mode}, not ${mode}`);
    return claim;
  }
}

export const scratchpadContentUrls = new ScratchpadContentUrls();
