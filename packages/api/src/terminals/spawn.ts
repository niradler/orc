export interface PtyHandle {
  pid: number | null;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  exited: Promise<number | null>;
}

export interface SpawnOptions {
  cwd: string | undefined;
  env: Record<string, string>;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void;
}

export type SpawnPty = (argv: string[], options: SpawnOptions) => PtyHandle;

export const MIN_BUN_VERSION = "1.4.2";
const TASKKILL_TIMEOUT_MS = 3000;

// The child is a session leader (it owns the PTY), so on POSIX its pid is also its process group.
function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    // Synchronous: killing the parent first would orphan the tree before taskkill can walk it.
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: TASKKILL_TIMEOUT_MS,
    });
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGHUP");
    } catch {}
  }
}

export const spawnPty: SpawnPty = (argv, options) => {
  const proc = Bun.spawn(argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data(_terminal, data) {
        options.onData(data);
      },
    },
  });
  const terminal = proc.terminal;
  if (!terminal) {
    try {
      proc.kill();
    } catch {}
    throw new Error(`Bun.spawn did not attach a terminal; Bun >= ${MIN_BUN_VERSION} is required`);
  }
  return {
    pid: proc.pid ?? null,
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: () => {
      if (proc.pid) killProcessTree(proc.pid);
      try {
        proc.kill();
      } catch {}
      terminal.close();
    },
    exited: proc.exited.then(
      (code) => {
        terminal.close();
        return code;
      },
      () => null,
    ),
  };
};
