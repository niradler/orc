import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { closeSync, existsSync, openSync } from "node:fs";

/** Probe a shared lock without waiting or changing the lock file. */
export function hasWriter(path: string): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === "win32") return hasWindowsWriter(path);
  const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location";
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
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
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "ptr"], returns: "i32" },
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
