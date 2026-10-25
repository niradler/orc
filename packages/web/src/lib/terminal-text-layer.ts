import type { Terminal as GhosttyTerminal } from "ghostty-web";

/**
 * The terminal draws on a canvas, which a phone cannot select. The text layer lays the
 * visible rows over it as real, transparent text, so a long press gets the platform's own
 * selection: handles, loupe and the Copy / Share toolbar.
 */
export interface TerminalTextLayer {
  element: HTMLDivElement;
  /** Re-lays the visible rows, unless a selection is live on them. */
  sync: () => void;
  /** Re-lays the rows once the screen settles, and not before the finger on them lifts. */
  schedule: () => void;
  /** A touch is down: its target row must stay in the page for the touch to keep reaching it. */
  hold: (touching: boolean) => void;
  dispose: () => void;
  selected: () => boolean;
  clear: () => void;
}

const DEC_ALTERNATE_SCREEN = 1049;
// Output arrives in bursts; laying the rows out once it pauses keeps a busy shell cheap.
const SETTLE_MS = 100;

export function createTerminalTextLayer(
  term: GhosttyTerminal,
  canvasOf: () => HTMLCanvasElement | null,
): TerminalTextLayer {
  const element = document.createElement("div");
  element.dataset.testid = "terminal-text-layer";
  // The canvas already speaks for the screen; the copy is only there to be selected.
  element.setAttribute("aria-hidden", "true");
  element.className = "terminal-text-layer";

  const selection = () => {
    const current = document.getSelection();
    return current && !current.isCollapsed && element.contains(current.anchorNode) ? current : null;
  };
  const measure = document.createElement("canvas").getContext("2d");

  const sync = () => {
    const canvas = canvasOf();
    const host = element.parentElement;
    if (selection() || !canvas || !host) return;
    const box = canvas.getBoundingClientRect();
    const origin = host.getBoundingClientRect();
    const { cols, rows } = term;
    if (!box.width || !cols || !rows) return;
    const cellWidth = box.width / cols;
    const cellHeight = box.height / rows;
    const { fontSize, fontFamily } = term.options;
    let advance = cellWidth;
    if (measure) {
      measure.font = `${fontSize}px ${fontFamily}`;
      advance = measure.measureText("M").width || cellWidth;
    }
    Object.assign(element.style, {
      left: `${box.left - origin.left}px`,
      top: `${box.top - origin.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      fontFamily,
      fontSize: `${fontSize}px`,
      lineHeight: `${cellHeight}px`,
      letterSpacing: `${cellWidth - advance}px`,
    });
    const buffer = term.buffer.active;
    // ghostty's buffer reports no scroll offset; the terminal's own counts rows scrolled back.
    const top = term.getMode(DEC_ALTERNATE_SCREEN)
      ? 0
      : buffer.length - rows - Math.floor(term.viewportY);
    const rowElements: HTMLDivElement[] = [];
    for (let row = 0; row < rows; row++) {
      const line = buffer.getLine(top + row);
      const div = document.createElement("div");
      div.style.height = `${cellHeight}px`;
      if (line?.isWrapped) div.dataset.wrapped = "true";
      let text = "";
      const flush = () => {
        if (text) div.append(text);
        text = "";
      };
      for (let col = 0; line && col < cols; col++) {
        const cell = line.getCell(col);
        const width = cell?.getWidth() ?? 1;
        if (width === 0) continue;
        const chars = cell?.getChars() || " ";
        if (width === 1) {
          text += chars;
          continue;
        }
        // A wide glyph spans two cells; a sized box keeps the columns after it aligned.
        flush();
        const wide = document.createElement("span");
        wide.style.display = "inline-block";
        wide.style.width = `${cellWidth * width}px`;
        wide.style.letterSpacing = "0";
        wide.textContent = chars;
        div.append(wide);
      }
      flush();
      // Trailing blanks are padding, not output; leaving them out keeps copies clean.
      const last = div.lastChild;
      if (last?.nodeType === Node.TEXT_NODE) last.textContent = last.textContent?.trimEnd() ?? "";
      rowElements.push(div);
    }
    element.replaceChildren(...rowElements);
  };

  // A wrapped row continues the line above it, so a copy joins them without a line break.
  element.addEventListener("copy", (event) => {
    const current = selection();
    if (!current || !event.clipboardData) return;
    const range = current.getRangeAt(0);
    const parts: string[] = [];
    for (const row of Array.from(element.children)) {
      if (!range.intersectsNode(row)) continue;
      const part = document.createRange();
      part.selectNodeContents(row);
      if (row.contains(range.startContainer))
        part.setStart(range.startContainer, range.startOffset);
      if (row.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
      if (parts.length && (row as HTMLElement).dataset.wrapped !== "true") parts.push("\n");
      parts.push(part.toString());
    }
    event.clipboardData.setData("text/plain", parts.join(""));
    event.preventDefault();
  });

  let timer = 0;
  let touching = false;
  let pending = false;
  const schedule = () => {
    // A mouse selects on the canvas, so the layer only has to be current for touch.
    if (element.style.pointerEvents === "none") return;
    pending = true;
    if (touching) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (touching || selection()) return;
      pending = false;
      sync();
    }, SETTLE_MS);
  };
  // Rows held back while text was selected are laid out once it is let go.
  const onSelectionChange = () => {
    if (pending && !selection()) schedule();
  };
  document.addEventListener("selectionchange", onSelectionChange);

  return {
    element,
    sync,
    schedule,
    hold: (active) => {
      touching = active;
      if (!active && pending) schedule();
    },
    dispose: () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
    },
    selected: () => selection() !== null,
    clear: () => {
      if (selection()) document.getSelection()?.removeAllRanges();
    },
  };
}
