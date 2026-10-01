// Click-to-move-cursor, as in Warp: a click on the cursor's own row sends the arrow keys that
// walk the shell's cursor to the clicked column. ghostty-web does not report mouse events to
// applications, so this is the only mouse input a program ever receives.

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
