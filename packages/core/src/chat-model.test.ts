import { describe, expect, test } from "bun:test";
import { ChatModelSchema } from "./chat.js";

describe("ChatModelSchema", () => {
  test("accepts ids with a bracketed variant suffix", () => {
    for (const id of ["opus[1m]", "claude-fable-5-1[1m]", "claude-opus-5-5[1m]"]) {
      expect(ChatModelSchema.safeParse(id).success).toBe(true);
    }
  });

  test("rejects brackets anywhere but a single trailing suffix", () => {
    for (const id of ["[1m]", "opus[1m]x", "opus[1m][2]", "opus[]", "opus[$(x)]", "op[us"]) {
      expect(ChatModelSchema.safeParse(id).success).toBe(false);
    }
  });
});
