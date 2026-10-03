import type { Terminal } from "ghostty-web";

type OutputTerminal = Pick<Terminal, "buffer" | "viewportY" | "write" | "scrollToLine">;

export function writeTerminalOutput(term: OutputTerminal, data: Uint8Array): void {
  const viewport = term.viewportY;
  const buffer = term.buffer.active;
  const length = buffer.length;
  const preserve = buffer.type === "normal" && viewport > 0;

  term.write(data);

  // Ghostty resets the viewport on every write, including Claude's cursor redraws.
  // Its scrollToLine argument is an offset from the bottom despite the API comment.
  if (preserve && term.buffer.active.type === "normal") {
    term.scrollToLine(viewport + Math.max(0, term.buffer.active.length - length));
  }
}
