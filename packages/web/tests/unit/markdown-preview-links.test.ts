import { describe, expect, test } from "bun:test";
import { BrowserActionSchema, PreviewOpenSchema, previewLink } from "@orc/core/desktop-preview";
import { previewFileDestination, remarkPreviewFiles } from "../../src/lib/markdown-preview-links";

describe("desktop Markdown destinations", () => {
  test("should preserve Windows/file/relative destinations as inert internal anchors", () => {
    for (const path of [
      "C:/Projects/orc/example.ts:10",
      "file:///C:/Projects/My%20File.md",
      "./notes.md#L4",
      "/home/nir/code.ts",
    ]) {
      const link = { type: "link", url: path, children: [{ type: "text", value: "Open" }] };
      remarkPreviewFiles()({ type: "root", children: [link] });
      expect(link.url.startsWith("#orc-preview-file=")).toBe(true);
      expect(previewFileDestination(link.url)).toBe(path);
    }
    const link = { type: "link", url: "https://example.com", children: [] };
    remarkPreviewFiles()({ type: "root", children: [link] });
    expect(link.url).toBe("https://example.com");
  });
  test("should leave scripts, internal routes, anchors and code literal", () => {
    for (const path of ["javascript:alert(1)", "data:text/html,test", "#heading", "/tasks/123"]) {
      const link = { type: "link", url: path };
      remarkPreviewFiles()({ type: "root", children: [link] });
      expect(link.url).toBe(path);
    }
    expect(previewFileDestination("#orc-preview-file=%xx")).toBeNull();
    expect(previewLink("javascript:alert(1)")).toBeNull();
    expect(previewLink("C:/Projects/orc/code.ts:12:3")).toEqual({
      kind: "file",
      target: "C:/Projects/orc/code.ts",
      line: 12,
    });
    expect(previewLink("notes.md#section")).toEqual({ kind: "file", target: "notes.md" });
  });
  test("should deny privileged navigation and unbounded browser commands", () => {
    expect(
      PreviewOpenSchema.safeParse({
        session_id: "session",
        kind: "url",
        target: "file:///etc/passwd",
      }).success,
    ).toBe(false);
    expect(
      BrowserActionSchema.safeParse({ action: "evaluate", script: "process.exit()" }).success,
    ).toBe(false);
    expect(
      BrowserActionSchema.safeParse({ action: "type", selector: "#name", text: "x".repeat(10001) })
        .success,
    ).toBe(false);
  });
});
