import { expect, test } from "bun:test";
import { resolveGestureIntent } from "../../src/hooks/useMobilePanelGestures";

test("a horizontal swipe activates only along its direction with a clear horizontal intent", () => {
  expect(resolveGestureIntent({ deltaX: -20, deltaY: 2, axis: "horizontal", direction: -1 })).toBe(
    "activate",
  );
  expect(resolveGestureIntent({ deltaX: 20, deltaY: 2, axis: "horizontal", direction: 1 })).toBe(
    "activate",
  );
  // Wrong direction fails instead of waiting.
  expect(resolveGestureIntent({ deltaX: 20, deltaY: 0, axis: "horizontal", direction: -1 })).toBe(
    "fail",
  );
  // Small moves keep waiting.
  expect(resolveGestureIntent({ deltaX: -8, deltaY: 0, axis: "horizontal", direction: -1 })).toBe(
    "wait",
  );
});

test("a perpendicular scroll wins over the panel gesture", () => {
  expect(resolveGestureIntent({ deltaX: -18, deltaY: 24, axis: "horizontal", direction: -1 })).toBe(
    "fail",
  );
  // Below the activation distance the gesture keeps waiting.
  expect(resolveGestureIntent({ deltaX: -12, deltaY: 5, axis: "horizontal", direction: -1 })).toBe(
    "wait",
  );
});

test("the terminal pull-down activates on a clear downward drag and fails on upward or sideways motion", () => {
  expect(resolveGestureIntent({ deltaX: 2, deltaY: 20, axis: "vertical", direction: 1 })).toBe(
    "activate",
  );
  expect(resolveGestureIntent({ deltaX: 0, deltaY: -20, axis: "vertical", direction: 1 })).toBe(
    "fail",
  );
  expect(resolveGestureIntent({ deltaX: 26, deltaY: 18, axis: "vertical", direction: 1 })).toBe(
    "fail",
  );
  expect(resolveGestureIntent({ deltaX: 0, deltaY: 8, axis: "vertical", direction: 1 })).toBe(
    "wait",
  );
});

test("closing swipes use the reversed direction", () => {
  // Sessions closes to the right, inspector to the left, terminal upward.
  expect(resolveGestureIntent({ deltaX: 24, deltaY: 1, axis: "horizontal", direction: 1 })).toBe(
    "activate",
  );
  expect(resolveGestureIntent({ deltaX: -24, deltaY: 1, axis: "horizontal", direction: -1 })).toBe(
    "activate",
  );
  expect(resolveGestureIntent({ deltaX: 1, deltaY: -24, axis: "vertical", direction: -1 })).toBe(
    "activate",
  );
});
