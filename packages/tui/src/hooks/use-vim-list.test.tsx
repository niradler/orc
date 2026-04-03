import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { useVimList } from "./use-vim-list.js";

let setup: Awaited<ReturnType<typeof testRender>> | null = null;
let latestHandleKey: ReturnType<typeof useVimList>["handleKey"] | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
  latestHandleKey = null;
});

function VimListHarness() {
  const { cursor, handleKey } = useVimList(4, true);
  latestHandleKey = handleKey;

  return <text>{`cursor:${cursor}`}</text>;
}

test("vim list responds to arrow keys and vim keys", async () => {
  setup = await testRender(<VimListHarness />, { width: 30, height: 8 });
  await setup.renderOnce();

  await act(async () => {
    latestHandleKey?.({
      name: "down",
      sequence: "",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      eventType: "press",
      repeated: false,
    });
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("cursor:1");

  await act(async () => {
    latestHandleKey?.({
      name: "j",
      sequence: "j",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      eventType: "press",
      repeated: false,
    });
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("cursor:2");

  await act(async () => {
    latestHandleKey?.({
      name: "k",
      sequence: "k",
      ctrl: false,
      shift: false,
      meta: false,
      option: false,
      eventType: "press",
      repeated: false,
    });
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("cursor:1");
});
