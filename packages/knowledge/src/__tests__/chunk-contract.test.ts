import { expect, test } from "bun:test";
import { CHUNK_MAX_CHARS, chunkBlocks } from "../chunker.js";
import { chunkBlocks as legacyChunks } from "../chunker-v1.js";

test("explicit legacy segmentation preserves historical passage boundaries exactly", () => {
  const blocks = [
    { kind: "paragraph" as const, heading_path: [], text: "A very long sentence. ".repeat(220) },
  ];
  expect(chunkBlocks(blocks, 1)).toEqual(legacyChunks(blocks));
  expect(chunkBlocks(blocks, 2)).not.toEqual(legacyChunks(blocks));
});

test("oversized two-row tables retain their content in bounded passages", () => {
  const chunks = chunkBlocks([
    {
      kind: "table",
      heading_path: ["Inventory"],
      text: "",
      rows: [["Header"], ["importantcell ".repeat(400)]],
    },
  ]);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map((c) => c.text).join(" ")).toContain("importantcell");
  expect(chunks.every((c) => c.text.length <= CHUNK_MAX_CHARS)).toBe(true);
});

test("oversized table rows and code account for rendered headers and fences", () => {
  for (const block of [
    {
      kind: "table" as const,
      heading_path: [],
      text: "",
      rows: [["Header"], ["x".repeat(3000)], ["last"]],
    },
    { kind: "code" as const, heading_path: [], text: "x".repeat(CHUNK_MAX_CHARS) },
  ]) {
    expect(chunkBlocks([block]).every((c) => c.text.length <= CHUNK_MAX_CHARS)).toBe(true);
  }
});

test("passages keep page and sheet references attached only to their own content", () => {
  const chunks = chunkBlocks([
    { kind: "paragraph", heading_path: [], text: "page one", locator: { page: 1 } },
    { kind: "paragraph", heading_path: [], text: "page two", locator: { page: 2 } },
    { kind: "paragraph", heading_path: [], text: "another sheet", locator: { sheet: "Sheet B" } },
  ]);
  expect(chunks.map((c) => [c.text, c.locator])).toEqual([
    ["page one", { page: 1 }],
    ["page two", { page: 2 }],
    ["another sheet", { sheet: "Sheet B" }],
  ]);
});

test("splitting preserves Unicode characters within each serialized passage", () => {
  const chunks = chunkBlocks([
    { kind: "paragraph", heading_path: [], text: `A${"😀".repeat(2000)}` },
  ]);
  for (const chunk of chunks)
    expect(new TextDecoder().decode(new TextEncoder().encode(chunk.text))).toBe(chunk.text);
});
