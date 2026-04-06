import { afterEach, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { KeyEvent } from "../types.js";
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

function keyEvent(name: string, sequence = ""): KeyEvent {
  return {
    name,
    sequence,
    number: false,
    raw: sequence,
    source: "raw",
    ctrl: false,
    shift: false,
    meta: false,
    option: false,
    eventType: "press",
    repeated: false,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
    clone() {
      return keyEvent(name, sequence);
    },
  } as unknown as KeyEvent;
}

test("vim list responds to arrow keys", async () => {
  setup = await testRender(<VimListHarness />, { width: 30, height: 8 });
  await setup.renderOnce();

  await act(async () => {
    latestHandleKey?.(keyEvent("down"));
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("cursor:1");

  await act(async () => {
    latestHandleKey?.(keyEvent("down"));
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("cursor:2");

  await act(async () => {
    latestHandleKey?.(keyEvent("up"));
  });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("cursor:1");
});
