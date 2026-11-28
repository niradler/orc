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
  expect(workspaceSection("/chat")?.id).toBe("chat");
  expect(workspacePage("/chat")?.label).toBe("Chat");
  expect(workspaceSection("/jobs/example")?.id).toBe("activity");
  expect(workspaceSection("/webhooks")?.id).toBe("activity");
  expect(workspacePage("/webhooks")?.label).toBe("Webhooks");
  expect(workspaceSection("/knowledge/memories/example")?.id).toBe("knowledge");
  expect(workspacePage("/knowledge/base")?.label).toBe("Knowledge base");
  expect(workspacePage("/knowledge/memories/example")?.label).toBe("Memories");
  expect(workspaceSection("/knowledge/scratchpads/example")?.id).toBe("knowledge");
  expect(workspacePage("/knowledge/scratchpads/example")?.label).toBe("Scratchpads");
  expect(workspaceSection("/knowledge/base")?.pages.map((page) => page.label)).toEqual([
    "Knowledge base",
    "Memories",
    "Scratchpads",
  ]);
  // The old Library route is gone; pads live under Knowledge now.
  expect(workspaceSection("/scratchpad")).toBeUndefined();
  expect(
    workspaceDestination(
      "/knowledge/base?view=collections",
      "example",
      "?chat=open&q=other-feature",
    ),
  ).toBe("/knowledge/base?view=collections&project=example&chat=open");
  expect(workspaceDestination("/tasks", "example", "?chat=open&chatThread=thread-1")).toBe(
    "/tasks?project=example&chat=open&chatThread=thread-1",
  );
  expect(
    workspaceDestination("/chat", "example", "?chat=open&chatThread=side-1", "/activity"),
  ).toBe("/chat?project=example&chat=open&sideChatThread=side-1");
  expect(
    workspaceDestination(
      "/tasks",
      "example",
      "?chat=open&chatThread=page-1&sideChatThread=side-1",
      "/chat",
    ),
  ).toBe("/tasks?project=example&chat=open&chatThread=side-1");
  expect(workspaceDestination("/tasks", "example", "?chat=open&chatThread=page-1", "/chat")).toBe(
    "/tasks?project=example&chat=open",
  );
  expect(workspaceDestination("/tasks", "example", "?chatThread=thread-1")).toBe(
    "/tasks?project=example",
  );
  expect(workspaceSection("/tasks-unrelated")).toBeUndefined();
});
