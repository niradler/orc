import { expect, test } from "bun:test";
import { canHandleCommandInput, canSwitchRoutes } from "./navigation.js";

test("route switching is blocked while a focused interaction is active", () => {
  expect(canSwitchRoutes(false, false)).toBe(true);
  expect(canSwitchRoutes(true, false)).toBe(false);
  expect(canSwitchRoutes(false, true)).toBe(false);
});

test("command palette opens only when navigation is not locked unless already active", () => {
  expect(canHandleCommandInput(false, false)).toBe(true);
  expect(canHandleCommandInput(false, true)).toBe(false);
  expect(canHandleCommandInput(true, true)).toBe(true);
});
