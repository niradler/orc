import { expect, test } from "bun:test";
import {
  type ComposerBox,
  composerHandoff,
  composerHandoffTransform,
} from "../../src/lib/composer-handoff";

const box = (left: number, top: number, width: number, height: number): ComposerBox => ({
  left,
  top,
  width,
  height,
});

test("should invert a move from below to above", () => {
  // The hero sits above the docked footer: the docked box must start lifted up.
  const handoff = composerHandoff(box(48, 300, 720, 140), box(48, 700, 720, 60));
  expect(handoff).toEqual({ dx: 0, dy: -400, scaleX: 1, scaleY: 140 / 60 });
  expect(handoff && composerHandoffTransform(handoff)).toBe(
    "translate(0px, -400px) scale(1, 2.3333333333333335)",
  );
});

test("should invert a move from above to below", () => {
  const handoff = composerHandoff(box(120, 700, 400, 60), box(80, 300, 800, 140));
  expect(handoff).toEqual({ dx: 40, dy: 400, scaleX: 0.5, scaleY: 60 / 140 });
});

test("should skip an unchanged box", () => {
  expect(composerHandoff(box(48, 700, 720, 60), box(48, 700, 720, 60))).toBeNull();
  // Sub-pixel rounding is not a move.
  expect(composerHandoff(box(48, 700, 720, 60), box(48.4, 700.4, 720, 60))).toBeNull();
});

test("should translate only when a reference box has no size", () => {
  const handoff = composerHandoff(box(10, 20, 0, 0), box(10, 100, 320, 60));
  expect(handoff).toEqual({ dx: 0, dy: -80, scaleX: 1, scaleY: 1 });
  expect(handoff && composerHandoffTransform(handoff)).toBe("translate(0px, -80px) scale(1, 1)");
});
