import { expect, test } from "bun:test";
import { stopOwnedProcess } from "../../scripts/stop-process";

test("E2E shutdown releases an owned child without requiring a process group", async () => {
  const child = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000); console.log('ready')"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const reader = child.stdout.getReader();
    const output = await reader.read();
    expect(new TextDecoder().decode(output.value)).toContain("ready");
    reader.releaseLock();
    await stopOwnedProcess(child, 1000);
    expect(child.exitCode).not.toBeNull();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test.skipIf(process.platform === "win32")(
  "E2E shutdown bounds a child that ignores SIGTERM",
  async () => {
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('ready')",
      ],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    try {
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      await stopOwnedProcess(child, 100);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
);
