import { expect, test } from "bun:test";
import { chatUiCatalog, parseChatUiSpec } from "@orc/core/chat-ui";
import { chatUiGallery } from "../fixtures/chat-ui-gallery";

test("should provide a valid example of every catalog component", () => {
  const spec = chatUiGallery({ task: "t1", job: "j1", project: "p1", pad: "s1", session: "s1" });
  expect(Object.keys(chatUiCatalog.data.components).sort()).toEqual([
    "Button",
    "Callout",
    "Chart",
    "Html",
    "Job",
    "KeyValue",
    "Metric",
    "Progress",
    "Scratchpad",
    "SessionList",
    "SessionUsage",
    "Sparkline",
    "Stack",
    "Table",
    "Task",
    "TaskList",
  ]);
  expect(Object.keys(chatUiCatalog.data.components).length).toBeLessThanOrEqual(20);
  expect(parseChatUiSpec(JSON.stringify(spec)).ok).toBe(true);
  expect([...new Set(Object.values(spec.elements).map((element) => element.type))].sort()).toEqual(
    Object.keys(chatUiCatalog.data.components).sort(),
  );
});
