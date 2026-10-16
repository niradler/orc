import { type ExecHost, hostSpawn } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";

const logger = createLogger("api:remote-watch");

// SSH execution hosts already use Python for file/SQLite operations. inotify blocks until
// a filesystem change; it does not repeatedly scan the remote checkout.
export const REMOTE_WATCH = String.raw`
import ctypes, json, os, select, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
fd = libc.inotify_init1(os.O_CLOEXEC)
if fd < 0: raise OSError(ctypes.get_errno(), 'inotify_init1')
roots = [os.path.abspath(os.path.expanduser(p)) for p in json.loads(sys.argv[1])]
watches = {}
ignored = {'node_modules', '.cache', 'dist', '.next'}
mask = 0x2 | 0x4 | 0x8 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800
def add_tree(path):
    if not os.path.isdir(path) or os.path.islink(path): return
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in ignored and not os.path.islink(os.path.join(root,d)) and not (os.path.basename(root)=='.git' and d in {'objects','logs'})]
        wd = libc.inotify_add_watch(fd, os.fsencode(root), mask)
        if wd < 0: raise OSError(ctypes.get_errno(), 'inotify_add_watch')
        watches[wd] = root
for root in roots:
    parent = root
    while not os.path.isdir(parent): parent = os.path.dirname(parent)
    if parent == root: add_tree(root)
    else:
        wd = libc.inotify_add_watch(fd, os.fsencode(parent), mask)
        if wd < 0: raise OSError(ctypes.get_errno(), 'inotify_add_watch')
        watches[wd] = parent
print('ready', flush=True)
while True:
    readable, _, _ = select.select([fd, sys.stdin], [], [])
    if sys.stdin in readable and not os.read(sys.stdin.fileno(), 1): break
    if fd not in readable: continue
    data = os.read(fd, 262144)
    offset = 0
    changed = False
    while offset < len(data):
        wd, flags, cookie, size = struct.unpack_from('iIII', data, offset)
        name = os.fsdecode(data[offset+16:offset+16+size].split(b'\0',1)[0])
        offset += 16 + size
        if flags & 0x4000: raise RuntimeError('inotify queue overflow')
        base = watches.get(wd)
        if base is None: continue
        path = os.path.join(base, name)
        if name.endswith('.lock') or name in ignored: continue
        if not any(path == r or path.startswith(r+os.sep) or r.startswith(path+os.sep) for r in roots): continue
        if flags & 0x40000000 and flags & (0x100 | 0x80): add_tree(path)
        changed = True
    if changed: print('change', flush=True)
`;

export function watchRemotePaths(
  host: ExecHost,
  paths: string[],
  onChange: () => void,
): () => void {
  let stopped = false;
  let stopProcess: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = async (): Promise<void> => {
    try {
      const child = await hostSpawn(
        host,
        ["python3", "-u", "-c", REMOTE_WATCH, JSON.stringify(paths)],
        { stdin: "pipe", passEnv: [] },
      );
      stopProcess = () => {
        if (child.proc.stdin && typeof child.proc.stdin !== "number") void child.proc.stdin.end();
        child.kill();
      };
      if (stopped) {
        stopProcess();
        return;
      }
      const stderr = new Response(child.proc.stderr as ReadableStream<Uint8Array>).text();
      const reader = (child.proc.stdout as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!stopped) {
          const next = await reader.read();
          if (next.done) break;
          buffer += decoder.decode(next.value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line === "change" || line === "ready") onChange();
            newline = buffer.indexOf("\n");
          }
        }
      } finally {
        reader.releaseLock();
      }
      const code = await child.proc.exited;
      const error = await stderr;
      if (!stopped && code !== 0)
        logger.error("Remote change watcher exited", { code, error: error.slice(-2000) });
    } catch (error) {
      if (!stopped) logger.error("Remote change watcher failed", error);
    } finally {
      stopProcess?.();
      stopProcess = undefined;
    }
    if (!stopped) {
      retry = setTimeout(() => {
        void connect();
      }, 10_000);
      retry.unref();
    }
  };
  void connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    stopProcess?.();
  };
}
