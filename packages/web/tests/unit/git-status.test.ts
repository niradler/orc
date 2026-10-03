import { expect, test } from "bun:test";
import { fileChangeState } from "../../src/lib/git-status";

test("the unified view retains staged-only, untracked, deleted, renamed and partially staged file states", () => {
  expect(fileChangeState({ index: "M", working: " ", original: null })).toMatchObject({
    staged: true,
    working: false,
    label: "Modified",
  });
  expect(fileChangeState({ index: "M", working: "M", original: null })).toMatchObject({
    staged: true,
    working: true,
  });
  expect(fileChangeState({ index: "?", working: "?", original: null })).toMatchObject({
    staged: false,
    working: true,
    label: "Untracked",
  });
  expect(fileChangeState({ index: " ", working: "D", original: null }).label).toBe("Deleted");
  expect(fileChangeState({ index: "R", working: "M", original: "before.txt" }).label).toBe(
    "Renamed",
  );
});
test("all unmerged status pairs require resolution before committing", () => {
  for (const pair of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"])
    expect(
      fileChangeState({ index: pair[0] ?? "", working: pair[1] ?? "", original: null }),
    ).toMatchObject({ conflict: true, staged: false, working: true, label: "Conflict" });
});
