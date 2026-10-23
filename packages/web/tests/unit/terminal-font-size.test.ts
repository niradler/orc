import { expect, test } from "bun:test";
import { clampTerminalFontSize } from "../../src/lib/terminal-font-size";

test("terminal zoom stays readable and bounded for pinch and saved preferences", () => {
  expect(clampTerminalFontSize(14.6)).toBe(15);
  expect(clampTerminalFontSize(-200)).toBe(10);
  expect(clampTerminalFontSize(1000)).toBe(32);
  expect(clampTerminalFontSize(Number.NaN)).toBe(13);
  expect(clampTerminalFontSize(Number.POSITIVE_INFINITY)).toBe(13);
});
