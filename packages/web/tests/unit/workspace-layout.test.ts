import { expect, test } from "bun:test";
import {
  closePane,
  type Layout,
  leaves,
  readLayout,
  updateLayout,
} from "../../src/lib/workspace-layout";

const layout: Layout = {
  id: "root",
  direction: "row",
  ratio: 60,
  first: { id: "terminal", kind: "terminal", terminalId: "one" },
  second: {
    id: "nested",
    direction: "column",
    ratio: 50,
    first: { id: "git", kind: "git", terminalId: "one" },
    second: { id: "files", kind: "files", terminalId: "one" },
  },
};
test("closing a nested pane preserves the sibling and outer split ratio", () => {
  const closed = closePane(layout, "git");
  expect(leaves(closed).map((pane) => pane.id)).toEqual(["terminal", "files"]);
  expect(closed).toMatchObject({ ratio: 60, second: { id: "files" } });
  expect(closePane(closed, "files")).toEqual(layout.first);
});
test("updates affect the selected pane without replacing the other terminal", () => {
  const updated = updateLayout(layout, "files", (node) =>
    "kind" in node ? { ...node, kind: "git" } : node,
  );
  expect(leaves(updated).map((pane) => pane.kind)).toEqual(["terminal", "git", "git"]);
  expect(leaves(updated)[0]).toEqual(layout.first);
});
test("restoring a layout clamps ratios and rejects duplicate PTY mounts and invalid data", () => {
  expect(readLayout({ ...layout, ratio: 200 })).toMatchObject({ ratio: 80 });
  expect(readLayout({ ...layout, ratio: Number.NaN })).toBeNull();
  expect(
    readLayout({ ...layout, second: { id: "duplicate", kind: "terminal", terminalId: "one" } }),
  ).toBeNull();
  expect(readLayout({ id: "invalid", kind: "unknown", terminalId: "one" })).toBeNull();
});
