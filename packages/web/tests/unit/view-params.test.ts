import { expect, test } from "bun:test";
import { withViewParam } from "../../src/lib/view-params";

test("view selection preserves resource scope and unrelated tabs without modifying original parameters", () => {
  const previous = new URLSearchParams(
    "project=p&tab=pages&page=decision&scope=global&editorMode=split",
  );
  const next = withViewParam(previous, "sidePanel", "open", "closed");
  expect(next.get("page")).toBe("decision");
  expect(next.get("editorMode")).toBe("split");
  expect(next.get("sidePanel")).toBe("open");
  expect(previous.has("sidePanel")).toBe(false);
  expect(withViewParam(next, "sidePanel", "closed", "closed").has("sidePanel")).toBe(false);
});
