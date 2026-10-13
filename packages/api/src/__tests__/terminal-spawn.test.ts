import { expect, test } from "bun:test";
import { spawnPty } from "../terminals/spawn.js";

test("late writes and resize requests are harmless after a real PTY closes", async () => {
  for (const stopped of [false, true]) {
    const pty = spawnPty(
      [process.execPath, "-e", stopped ? "setTimeout(() => {}, 10000)" : "process.exit(0)"],
      {
        cwd: undefined,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        cols: 80,
        rows: 24,
        onData: () => {},
      },
    );
    if (stopped) pty.kill();
    await pty.exited;
    expect(() => pty.write("\x1b]11;rgb:0909/0e0e/1a1a\x07")).not.toThrow();
    expect(() => pty.resize(100, 30)).not.toThrow();
  }
}, 15000);
