// Click-to-move-cursor, as in Warp: a click on the cursor's own row sends the arrow keys that
// walk the shell's cursor to the clicked column. ghostty-web does not report mouse events to
// applications, so this and the wheel reports below are the only mouse input a program receives.

export interface CellGrid {
  /** Pixel box of the rendered cells. */
  left: number;
  top: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

export interface Cell {
  col: number;
  row: number;
}

export function cellAt(grid: CellGrid, x: number, y: number): Cell | null {
  if (grid.cols < 1 || grid.rows < 1 || grid.width <= 0 || grid.height <= 0) return null;
  const col = Math.floor(((x - grid.left) / grid.width) * grid.cols);
  const row = Math.floor(((y - grid.top) / grid.height) * grid.rows);
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
  return { col, row };
}

const MAX_STEPS = 500;

/** Arrow keys that move a cursor from one column to another, honouring application cursor mode. */
export function cursorMoveKeys(from: number, to: number, applicationCursor: boolean): string {
  const delta = Math.max(-MAX_STEPS, Math.min(MAX_STEPS, to - from));
  if (delta === 0) return "";
  const arrow = `\x1b${applicationCursor ? "O" : "["}${delta > 0 ? "C" : "D"}`;
  return arrow.repeat(Math.abs(delta));
}

export interface ClickState {
  alternateScreen: boolean;
  scrolledBack: boolean;
  hasSelection: boolean;
  /** The terminal already had focus when the press started; a focusing click must not move anything. */
  wasFocused: boolean;
  button: number;
  detail: number;
  modified: boolean;
  /** The pointer travelled between press and release, so this was a drag, not a click. */
  dragged: boolean;
}

export function isPlainClick(state: ClickState): boolean {
  return (
    !state.alternateScreen &&
    !state.scrolledBack &&
    !state.hasSelection &&
    state.wasFocused &&
    state.button === 0 &&
    state.detail === 1 &&
    !state.modified &&
    !state.dragged
  );
}

/** Wheel distance ghostty counts as one step, so a ~100px mouse notch scrolls three. */
export const WHEEL_STEP_PX = 33;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export type WheelTarget = "report" | "arrows" | "scrollback";

/** Where a wheel goes, as in xterm: reported to a tracking program, arrows in a full-screen one. */
export function wheelTarget(state: {
  mouseTracking: boolean;
  alternateScreen: boolean;
  alternateScroll: boolean;
}): WheelTarget {
  if (state.mouseTracking) return "report";
  if (state.alternateScreen && state.alternateScroll) return "arrows";
  return "scrollback";
}

/** The report for one wheel step over a zero-based cell, in SGR or legacy X10 encoding. */
export function wheelReport(up: boolean, cell: Cell, sgr: boolean): string {
  const button = up ? 64 : 65;
  if (sgr) return `\x1b[<${button};${cell.col + 1};${cell.row + 1}M`;
  // X10 sends each value as one byte offset by 32, so cells past 223 cannot be reported.
  if (cell.col > 222 || cell.row > 222) return "";
  return `\x1b[M${String.fromCharCode(32 + button, 33 + cell.col, 33 + cell.row)}`;
}

/**
 * Turns wheel deltas into whole steps. A touch swipe moves a few pixels per event, so the
 * remainder is carried; reversing direction drops it.
 */
export function createWheelSteps(): (deltaY: number, deltaMode: number, rows: number) => number {
  let pending = 0;
  return (deltaY, deltaMode, rows) => {
    const steps =
      deltaMode === DOM_DELTA_LINE
        ? deltaY
        : deltaMode === DOM_DELTA_PAGE
          ? deltaY * rows
          : deltaY / WHEEL_STEP_PX;
    if (Math.sign(steps) !== Math.sign(pending)) pending = 0;
    pending += steps;
    const whole = Math.trunc(pending);
    pending -= whole;
    return whole;
  };
}
