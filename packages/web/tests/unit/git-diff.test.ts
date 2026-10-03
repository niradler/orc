import { expect, test } from "bun:test";
import { diffLines } from "../../src/lib/git-diff";

test("diff line numbers follow additions, removals and multiple hunks without coloring headers as changes", () => {
  const lines = diffLines(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,2 +2,3 @@\n same\n-old\n+new\n+added\n@@ -10 +11 @@\n-last\n+replacement\n\\ No newline at end of file",
  );
  expect(lines[1]?.kind).toBe("meta");
  expect(lines[2]?.kind).toBe("meta");
  expect(lines[4]).toMatchObject({ text: " same", kind: "context", old: 2, next: 2 });
  expect(lines[5]).toMatchObject({ text: "-old", kind: "remove", old: 3, next: null });
  expect(lines[7]).toMatchObject({ text: "+added", kind: "add", old: null, next: 4 });
  expect(lines[9]?.old).toBe(10);
  expect(lines[10]?.next).toBe(11);
  expect(lines[11]?.kind).toBe("meta");
});
