import { expect, test } from "bun:test";
import { previewToolContent } from "../preview-tools.js";

test("should return bounded browser screenshots as MCP images without base64 text duplication", () => {
  const value = JSON.stringify({
    id: "request",
    session_id: "session",
    status: "completed",
    result: { type: "image", mimeType: "image/jpeg", data: "aGVsbG8=" },
  });
  const content = previewToolContent("preview_browser_screenshot", value);
  expect(content).toHaveLength(2);
  expect(content[0]?.text).not.toContain("aGVsbG8=");
  expect(content[1]?.type).toBe("image");
  expect(previewToolContent("some_other_tool", value)[0]?.text).toBe(value);
});
