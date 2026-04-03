import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { Header } from "./header.js";
import { StatusBar } from "./status-bar.js";

let setup: Awaited<ReturnType<typeof testRender>> | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

function ShellChromePreview() {
  return (
    <box flexDirection="column" width="100%" height="100%">
      <Header route="tasks" project="orc" detailId="01HXYZABCDEF" connected />
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
        <box
          backgroundColor="#1c2533"
          border
          borderColor="#6d8cff"
          paddingLeft={1}
          paddingRight={1}
        >
          <text>{"2. Tasks"}</text>
        </box>
        <box
          backgroundColor="#16202b"
          border
          borderColor="#233244"
          paddingLeft={1}
          paddingRight={1}
        >
          <text>{"3. Jobs"}</text>
        </box>
      </box>
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
      />
    </box>
  );
}

test("shell chrome renders branded ORC layout", async () => {
  setup = await testRender(<ShellChromePreview />, { width: 84, height: 18 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("ORC");
  expect(frame).toContain("orchestration terminal");
  expect(frame).toContain("API online");
  expect(frame).toMatchSnapshot();
});

test("shell chrome stays readable on narrow terminals", async () => {
  setup = await testRender(<ShellChromePreview />, { width: 58, height: 18 });
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  expect(frame).toContain("ORC");
  expect(frame).toContain("Tasks");
});
