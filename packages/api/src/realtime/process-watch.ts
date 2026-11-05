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

const WINDOWS_POLL_MS = 1_000;

export function localProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pollLocalProcessExit(pid: number, onExit: () => void): () => void {
  const timer = setInterval(() => {
    if (localProcessAlive(pid)) return;
    clearInterval(timer);
    onExit();
  }, WINDOWS_POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function watchProcessExit(host: ExecHost, pid: number, onExit: () => void): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError("Invalid process id");
  // Windows has no pidfd/kqueue and a watcher process per session would open a console window.
  if (host.kind === "local" && process.platform === "win32")
    return pollLocalProcessExit(pid, onExit);
  let stopped = false;
  let stop: (() => void) | undefined;
  const run = async (): Promise<void> => {
    try {
      const command = ["python3", "-u", "-c", WAIT_PROCESS, String(pid)];
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
