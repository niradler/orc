import { expect, test } from "bun:test";
import {
  WORKSPACE_SECTIONS,
  workspaceDestination,
  workspacePage,
  workspaceSection,
} from "../../src/lib/workspace-navigation";

test("nested deep links select the specific page and keep primary groups stable", () => {
  expect(WORKSPACE_SECTIONS[0].id).toBe("activity");
  expect(WORKSPACE_SECTIONS[0].path).toBe("/activity");
  expect(workspacePage("/activity")?.label).toBe("Activity");
  expect(workspaceSection("/packages/agents/example")?.id).toBe("library");
  expect(workspacePage("/packages/agents/example")?.id).toBe("agents");
  expect(workspacePage("/packages/item/example")?.id).toBe("packages");
  expect(workspaceSection("/tasks/example")?.id).toBe("tasks");
  expect(workspaceSection("/sessions/example")?.id).toBe("activity");
  expect(workspaceSection("/knowledge/memories/example")?.id).toBe("knowledge");
  expect(workspacePage("/knowledge/base")?.label).toBe("Knowledge base");
  expect(workspacePage("/knowledge/memories/example")?.label).toBe("Memories");
  expect(workspaceSection("/knowledge/base")?.pages.map((page) => page.label)).toEqual([
    "Knowledge base",
    "Memories",
  ]);
  expect(
    workspaceDestination(
      "/knowledge/base?view=collections",
      "example",
      "?chat=open&q=other-feature",
    ),
  ).toBe("/knowledge/base?view=collections&project=example&chat=open");
  expect(workspaceSection("/tasks-unrelated")).toBeUndefined();
});
