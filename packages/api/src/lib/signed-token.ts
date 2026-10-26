import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { UnauthorizedError } from "@orc/core/errors";
import type { z } from "zod";

/**
 * Signs a JSON claim into `payload.signature` URL tokens. The process-local key deliberately
 * invalidates every token after an API restart. Any malformed, forged or expired token is a 401.
 */
export class TokenSigner<Claim extends { expires: number }> {
  private readonly key = randomBytes(32);

  constructor(
    private readonly schema: z.ZodType<Claim>,
    private readonly maxChars: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns null when the token would exceed the URL limit. */
  sign(claim: Claim): string | null {
    const payload = Buffer.from(JSON.stringify(this.schema.parse(claim))).toString("base64url");
    const token = `${payload}.${this.signature(payload)}`;
    return token.length > this.maxChars ? null : token;
  }

  verify(token: string): Claim {
    if (token.length > this.maxChars) throw new UnauthorizedError();
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) throw new UnauthorizedError();
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(this.signature(payload)))
    )
      throw new UnauthorizedError();
    let claim: Claim;
    try {
      claim = this.schema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    } catch {
      throw new UnauthorizedError();
    }
    if (claim.expires <= this.now()) throw new UnauthorizedError();
    return claim;
  }

  expiresAt(ttlMs: number): number {
    return this.now() + ttlMs;
  }

  private signature(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }
}
