import { expect, test } from "bun:test";
import { writeTerminalOutput } from "../../src/lib/terminal-output";

function terminal(viewport: number, type: "normal" | "alternate" = "normal", growth = 0) {
  const term = {
    viewportY: viewport,
    buffer: { active: { type, length: 200 } },
    restored: [] as number[],
    write(_data: Uint8Array): void {
      term.viewportY = 0;
      term.buffer.active.length += growth;
    },
    scrollToLine(line: number): void {
      term.viewportY = line;
      term.restored.push(line);
    },
  };
  return term;
}

test("should preserve scrollback during Claude redraws", () => {
  const term = terminal(30.5);
  writeTerminalOutput(term, new Uint8Array());
  expect(term.viewportY).toBe(30.5);
});

test("should keep the same history visible when new lines arrive", () => {
  const term = terminal(30, "normal", 3);
  writeTerminalOutput(term, new Uint8Array());
  expect(term.viewportY).toBe(33);
});

test("should follow output at the bottom and leave alternate screens alone", () => {
  for (const term of [terminal(0), terminal(30, "alternate")]) {
    writeTerminalOutput(term, new Uint8Array());
    expect(term.restored).toEqual([]);
  }
});
