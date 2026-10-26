import { describe, expect, test } from "bun:test";
import {
  emptyScratchpadContent,
  ScratchpadCreateSchema,
  ScratchpadUpdateSchema,
  scratchpadFilename,
  validateScratchpadContent,
} from "./scratchpad.js";

describe("scratchpad schemas", () => {
  test("should accept the three kinds and reject others", () => {
    for (const kind of ["doc", "diagram", "html"])
      expect(ScratchpadCreateSchema.safeParse({ kind, title: "t" }).success).toBe(true);
    expect(ScratchpadCreateSchema.safeParse({ kind: "note", title: "t" }).success).toBe(false);
    expect(ScratchpadCreateSchema.safeParse({ kind: "doc", title: "  " }).success).toBe(false);
    expect(ScratchpadUpdateSchema.safeParse({ revision: 2 }).success).toBe(false);
  });

  test("should give every kind content its editor opens", () => {
    for (const kind of ["doc", "diagram", "html"] as const)
      expect(() => validateScratchpadContent(kind, emptyScratchpadContent(kind))).not.toThrow();
    expect(() => validateScratchpadContent("html", "<not json>")).not.toThrow();
  });

  test("should derive a safe filename with the kind's extension", () => {
    expect(scratchpadFilename("Arch: API / DB v2", "diagram")).toBe("arch-api-db-v2.excalidraw");
    expect(scratchpadFilename("???", "doc")).toBe("scratchpad.md");
    expect(scratchpadFilename("Ünïcode chart", "html")).toBe("unicode-chart.html");
  });
});
