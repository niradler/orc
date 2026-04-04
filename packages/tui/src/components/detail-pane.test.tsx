import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { DetailPane } from "./detail-pane.js";

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

test("detail pane renders metadata and content sections", async () => {
  setup = await testRender(
    <DetailPane
      title="Task: polish tui"
      fields={[
        { label: "Status", value: "doing" },
        { label: "Priority", value: "high" },
      ]}
      body={"Improve shell chrome\nImprove forms\nImprove scrolling"}
    />,
    { width: 74, height: 28 },
  );

  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Task: polish tui");
  expect(frame).toContain("Details");
  expect(frame).toContain("Content");
  expect(frame).toMatchSnapshot();
});

test("detail pane keeps compact hint readable on narrow terminals", async () => {
  setup = await testRender(
    <DetailPane
      title="Task: narrow"
      fields={[
        { label: "Status", value: "doing" },
        { label: "Priority", value: "high" },
      ]}
      body={"A\nB\nC"}
    />,
    { width: 62, height: 18 },
  );

  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Task: narrow");
  expect(frame).toContain("Esc back");
});
