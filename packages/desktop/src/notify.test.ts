import { describe, expect, test } from "bun:test";
import { parseNotifyRequest, shouldNotifyNatively } from "./notify";

const valid = {
  title: "Fix tests",
  body: "Needs you: claude · Fix tests",
  path: "/activity?notifications=open",
  level: "needs-you" as const,
};

describe("parseNotifyRequest", () => {
  test("accepts an in-app notification", () => {
    expect(parseNotifyRequest(valid)).toEqual(valid);
  });

  test("rejects paths that could leave the app", () => {
    for (const path of ["https://evil.test", "//evil.test", "javascript:alert(1)", "/\\evil", ""])
      expect(parseNotifyRequest({ ...valid, path })).toBeNull();
  });

  test("rejects missing text and unknown levels", () => {
    expect(parseNotifyRequest({ ...valid, title: " " })).toBeNull();
    expect(parseNotifyRequest({ ...valid, body: 3 })).toBeNull();
    expect(parseNotifyRequest({ ...valid, level: "info" })).toBeNull();
    expect(parseNotifyRequest(null)).toBeNull();
  });

  test("clips long text", () => {
    expect(parseNotifyRequest({ ...valid, title: "x".repeat(500) })?.title).toHaveLength(120);
  });

  test("keeps a well-formed notification id", () => {
    expect(parseNotifyRequest({ ...valid, id: "01JABCDE-notification" })?.id).toBe(
      "01JABCDE-notification",
    );
  });

  test("drops malformed notification ids", () => {
    for (const id of ["", "id with space", "x".repeat(65), 7, null, "../escape"])
      expect(parseNotifyRequest({ ...valid, id })).toEqual(valid);
  });
});

describe("shouldNotifyNatively", () => {
  const window = (focused: boolean, minimized: boolean, visible: boolean) => ({
    isFocused: () => focused,
    isMinimized: () => minimized,
    isVisible: () => visible,
  });

  test("stays quiet while the window is in front", () => {
    expect(shouldNotifyNatively(window(true, false, true))).toBe(false);
  });

  test("notifies when unfocused, minimized or hidden to the tray", () => {
    expect(shouldNotifyNatively(window(false, false, true))).toBe(true);
    expect(shouldNotifyNatively(window(true, true, true))).toBe(true);
    expect(shouldNotifyNatively(window(false, false, false))).toBe(true);
  });
});
