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

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    Bun.spawn(["taskkill", "/F", "/T", "/PID", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  try {
    process.kill(pid, "SIGHUP");
  } catch {}
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
  if (!terminal) throw new Error("Bun.spawn did not attach a terminal; Bun >= 1.4.2 is required");
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
