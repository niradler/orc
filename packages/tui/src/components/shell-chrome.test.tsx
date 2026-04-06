import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { StatusBar } from "./status-bar.js";

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

function ShellChromePreview() {
  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexGrow={1} />
      <StatusBar
        route="tasks"
        state={{
          mode: "browse",
          title: "Tasks",
          countLabel: "12 visible tasks",
          filterQuery: "",
          filterActive: false,
          navigationLocked: false,
          selectionLabel: "◉ doing • Polish ORC TUI",
          detailId: null,
          statusMessage: null,
        }}
        connected
        project="orc"
      />
    </box>
  );
}

test("shell chrome renders tab bar and API status", async () => {
  setup = await testRender(<ShellChromePreview />, { width: 84, height: 18 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Tasks");
  expect(frame).toContain("Skills");
  expect(frame).toContain("●");
  expect(frame).toMatchSnapshot();
});

test("shell chrome stays readable on narrow terminals", async () => {
  setup = await testRender(<ShellChromePreview />, { width: 58, height: 18 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("Tasks");
});
