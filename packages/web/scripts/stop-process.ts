type OwnedProcess = Pick<Bun.Subprocess, "pid" | "kill" | "exited" | "exitCode" | "signalCode">;

/** Stop the direct source API child; it was not spawned into a process group. */
export async function stopOwnedProcess(child: OwnedProcess, graceMs = 10000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(child.pid)], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: graceMs,
    });
  } else child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  try {
    await child.exited;
  } finally {
    clearTimeout(timer);
  }
}
