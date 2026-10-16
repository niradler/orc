import { type ExecHost, hostSpawn } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";

const logger = createLogger("api:process-watch");
const WAIT_PROCESS = `
import os, select, sys
pid = int(sys.argv[1])
try:
    if hasattr(os, 'pidfd_open'):
        fd = os.pidfd_open(pid)
        select.select([fd, sys.stdin], [], [])
        os.close(fd)
    elif hasattr(select, 'kqueue'):
        queue = select.kqueue()
        queue.control([select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD, fflags=select.KQ_NOTE_EXIT)], 1)
        queue.close()
    else:
        raise RuntimeError('No native process exit notification support')
except ProcessLookupError:
    pass
`;

export function watchProcessExit(host: ExecHost, pid: number, onExit: () => void): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError("Invalid process id");
  let stopped = false;
  let stop: (() => void) | undefined;
  const run = async (): Promise<void> => {
    try {
      const windows = host.kind === "local" && process.platform === "win32";
      const command = windows
        ? [
            Bun.which("pwsh") ?? "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `try { $targetProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($targetProcess) { $targetProcess.WaitForExit() } } catch { [Console]::Error.WriteLine('Process exit watch failed'); exit 1 }`,
          ]
        : ["python3", "-u", "-c", WAIT_PROCESS, String(pid)];
      const child = await hostSpawn(host, command, {
        passEnv: [],
        stdin: "pipe",
        stdout: "ignore",
      });
      stop = () => {
        if (child.proc.stdin && typeof child.proc.stdin !== "number") void child.proc.stdin.end();
        child.kill();
      };
      if (stopped) {
        stop();
        return;
      }
      const stderr = new Response(child.proc.stderr as ReadableStream<Uint8Array>).text();
      const code = await child.proc.exited;
      const error = await stderr;
      if (!stopped && code === 0) onExit();
      else if (!stopped)
        logger.error("Process exit watcher failed", { code, error: error.slice(-1000) });
    } catch (error) {
      if (!stopped) logger.error("Cannot watch process exit", error);
    }
  };
  void run();
  return () => {
    stopped = true;
    stop?.();
  };
}
