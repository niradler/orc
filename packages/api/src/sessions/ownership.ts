import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, existsSync, openSync } from "node:fs";
import { join, posix } from "node:path";
import type { HostRuntime } from "@orc/core/exec-host";

const REMOTE_WRITER_PROBE = `
import fcntl, json, os, sys
data = json.load(sys.stdin)
out = {}
initial = os.stat(data['directory'])
for session_id in data['ids']:
    path = os.path.join(data['directory'], session_id + '.lock')
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except FileNotFoundError:
        out[session_id] = False
        continue
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            out[session_id] = True
        else:
            out[session_id] = False
    finally:
        os.close(fd)
final = os.stat(data['directory'])
if (initial.st_dev, initial.st_ino) != (final.st_dev, final.st_ino):
    raise RuntimeError('Writer-lock directory changed during inspection')
print(json.dumps(out))
`;

/** Probe all remote locks in one SSH call; failure must not mark an owned session stopped. */
export async function remoteWriters(
  runtime: HostRuntime,
  directory: string,
  ids: string[],
): Promise<Map<string, boolean>> {
  if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id)))
    throw new Error("Invalid Codex session identity in writer-lock probe");
  if (!ids.length) return new Map();
  const python = await runtime.binary("python3");
  if (!python) throw new Error("python3 is required for remote Codex writer-lock inspection");
  const result = await runtime.exec([python, "-c", REMOTE_WRITER_PROBE], {
    input: JSON.stringify({ directory, ids }),
    timeoutMs: 30000,
    login: false,
  });
  if (result.code !== 0) throw new Error("Remote Codex writer-lock inspection failed");
  const data: unknown = JSON.parse(result.stdout);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid remote Codex writer-lock result");
  const values = data as Record<string, unknown>;
  if (ids.some((id) => typeof values[id] !== "boolean"))
    throw new Error("Incomplete remote Codex writer-lock result");
  return new Map(ids.map((id) => [id, values[id] as boolean]));
}

export async function codexWriterOwned(runtime: HostRuntime, id: string): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id))
    throw new Error("Invalid Codex session identity in writer-lock probe");
  const paths = runtime.host.kind === "ssh" ? posix : { join };
  const directory = paths.join(await runtime.home(), ".codex", "thread-writer-locks");
  if (!(await runtime.isDirectory(directory))) return false;
  if (runtime.host.kind === "local") return hasWriter(paths.join(directory, `${id}.lock`));
  return (await remoteWriters(runtime, directory, [id])).get(id) === true;
}

/** Probe a shared lock without waiting or changing the lock file. */
export function hasWriter(path: string): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === "win32") return hasWindowsWriter(path);
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
  const musl = `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`;
  const library = dlopen(
    process.platform === "darwin"
      ? "/usr/lib/libSystem.B.dylib"
      : existsSync(musl)
        ? musl
        : "libc.so.6",
    {
      flock: { args: ["i32", "i32"], returns: "i32" },
      [errnoSymbol]: { args: [], returns: "ptr" },
    },
  );
  const descriptor = openSync(path, "r");
  try {
    const result = library.symbols.flock(descriptor, 1 | 4);
    if (result === 0) library.symbols.flock(descriptor, 8);
    else {
      const errnoPointer = library.symbols[errnoSymbol]?.();
      if (!errnoPointer) throw new Error("Unable to read lock probe errno");
      const errno = new DataView(toArrayBuffer(errnoPointer as Pointer, 0, 4)).getInt32(0, true);
      if (errno !== 11 && errno !== 35)
        throw new Error(`Unable to probe writer lock (errno ${errno})`);
    }
    return result !== 0;
  } finally {
    closeSync(descriptor);
    library.close();
  }
}

function hasWindowsWriter(path: string): boolean {
  const library = dlopen("kernel32.dll", {
    CreateFileW: {
      args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"],
      returns: "u64",
    },
    LockFileEx: {
      args: ["u64", "u32", "u32", "u32", "u32", "ptr"],
      returns: "i32",
    },
    UnlockFileEx: { args: ["u64", "u32", "u32", "u32", "ptr"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  const filename = Buffer.from(`${path}\0`, "utf16le");
  const handle = library.symbols.CreateFileW(ptr(filename), 0x80000000, 7, null, 3, 0, 0);
  if (BigInt(handle) === 0xffffffffffffffffn) {
    const error = library.symbols.GetLastError();
    library.close();
    if (error === 2) return false;
    throw new Error(`Unable to open writer lock (Windows error ${error})`);
  }
  try {
    const overlapped = Buffer.alloc(process.arch === "x64" || process.arch === "arm64" ? 32 : 20);
    const acquired = library.symbols.LockFileEx(handle, 1, 0, 1, 0, ptr(overlapped));
    if (acquired) {
      if (!library.symbols.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped))) {
        throw new Error("Unable to release writer-lock probe");
      }
      return false;
    }
    const error = library.symbols.GetLastError();
    if (error === 33) return true;
    throw new Error(`Unable to probe writer lock (Windows error ${error})`);
  } finally {
    library.symbols.CloseHandle(handle);
    library.close();
  }
}
