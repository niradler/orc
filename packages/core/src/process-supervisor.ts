import { type ChildProcess, spawn } from "node:child_process";

export const RESTART_EXIT_CODE = 75;
const CHILD_MARKER = "ORC_SUPERVISED_SERVER";
const standalone = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");

export async function superviseServer(): Promise<boolean> {
  if (process.env[CHILD_MARKER] === "1" && process.connected) {
    process.once("disconnect", () => {
      if (!process.emit("SIGTERM")) process.exit(0);
    });
    return true;
  }
  let child: ChildProcess | undefined;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    if (child?.connected)
      child.send({ type: "orc-shutdown" }, (error) => {
        if (error) child?.kill("SIGTERM");
      });
    else child?.kill("SIGTERM");
    killTimer = setTimeout(() => child?.kill("SIGKILL"), 10000);
    killTimer.unref();
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  if (process.platform === "win32") signals.push("SIGBREAK");
  for (const signal of signals) process.on(signal, stop);
  try {
    while (true) {
      child = spawn(
        process.execPath,
        [...process.execArgv, ...process.argv.slice(standalone ? 2 : 1)],
        {
          env: { ...process.env, [CHILD_MARKER]: "1" },
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          windowsHide: true,
        },
      );
      const code = await new Promise<number>((resolve, reject) => {
        child?.once("error", reject);
        child?.once("exit", (value) => resolve(value ?? 1));
      });
      if (stopping || code !== RESTART_EXIT_CODE) {
        process.exitCode = stopping ? 0 : code;
        return false;
      }
    }
  } finally {
    clearTimeout(killTimer);
    for (const signal of signals) process.off(signal, stop);
  }
}
