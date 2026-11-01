import { expect, test } from "bun:test";
import { chatUiHref, when } from "../../src/components/chat-ui/primitives";

test("should format Unix-second entity timestamps like their ISO equivalents", () => {
  const iso = "2026-11-01T08:00:00.000Z";
  expect(when(Date.parse(iso) / 1000)).toBe(when(iso));
  expect(when(null)).toBe("—");
  expect(when("invalid")).toBe("—");
});

test("should preserve link fragments and the docked conversation", () => {
  expect(chatUiHref("/tasks/t1?tab=log#comment", "?chat=open&chatThread=thread1")).toBe(
    "/tasks/t1?tab=log&chat=open&chatThread=thread1#comment",
  );
});
