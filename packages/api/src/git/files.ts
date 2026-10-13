import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ConflictError, ValidationError } from "@orc/core/errors";
import {
  type ExecHost,
  hostExec,
  remoteTempPath,
  removeHostFile,
  type SshExecHost,
  writeHostFile,
} from "@orc/core/exec-host";
import { gitStatus } from "./panel.js";

const LIMIT = 200_000;

interface CheckoutEntry {
  name: string;
  path: string;
  directory: boolean;
}

interface CheckoutView {
  root: string;
  path: string;
  entries: CheckoutEntry[] | null;
  content: string | null;
  binary: boolean;
  truncated: boolean;
}

function assertCheckoutPath(path: string): void {
  if (
    isAbsolute(path) ||
    path.startsWith("/") ||
    path.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git") ||
    path.includes("\0")
  )
    throw new ValidationError("Choose a path inside this checkout");
}

function decodeText(bytes: Uint8Array, partial: boolean): string | null {
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: partial,
    });
  } catch {
    return null;
  }
  return Buffer.from(bytes).toString("utf8");
}

function sortEntries(entries: CheckoutEntry[]): CheckoutEntry[] {
  return entries.sort(
    (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
  );
}

async function checkoutRoot(host: ExecHost, cwd: string): Promise<string> {
  return (await gitStatus(host, cwd)).root ?? cwd;
}

async function resolveCheckoutPath(
  root: string,
  path: string,
): Promise<{ root: string; canonical: string; inside: string }> {
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, path);
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    throw new ValidationError("File or folder no longer exists");
  }
  const inside = relative(canonicalRoot, canonical);
  if (
    inside.startsWith("..") ||
    isAbsolute(inside) ||
    inside.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")
  )
    throw new ValidationError("Path leaves this checkout");
  return { root: canonicalRoot, canonical, inside };
}

export async function checkoutFiles(
  host: ExecHost,
  cwd: string,
  path: string,
): Promise<CheckoutView> {
  assertCheckoutPath(path);
  const root = await checkoutRoot(host, cwd);
  if (host.kind === "ssh") return remoteCheckoutFiles(host, root, path);
  const { root: canonicalRoot, canonical, inside } = await resolveCheckoutPath(root, path);
  const info = await lstat(canonical);
  if (info.isDirectory()) {
    const entries = sortEntries(
      (await readdir(canonical, { withFileTypes: true }))
        .filter((entry) => entry.name.toLowerCase() !== ".git" && !entry.isSymbolicLink())
        .map((entry) => ({
          name: entry.name,
          path: relative(canonicalRoot, join(canonical, entry.name)).replace(/\\/g, "/"),
          directory: entry.isDirectory(),
        })),
    );
    return {
      root: canonicalRoot,
      path: inside.replace(/\\/g, "/"),
      entries: entries.slice(0, 500),
      content: null,
      binary: false,
      truncated: entries.length > 500,
    };
  }
  if (!info.isFile()) throw new ValidationError("Only regular files can be previewed");
  const handle = await open(canonical, "r");
  try {
    const buffer = Buffer.alloc(LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, LIMIT, 0);
    const content = decodeText(buffer.subarray(0, bytesRead), info.size > LIMIT);
    return {
      root: canonicalRoot,
      path: inside.replace(/\\/g, "/"),
      entries: null,
      content,
      binary: content === null,
      truncated: info.size > LIMIT,
    };
  } finally {
    await handle.close();
  }
}

const REMOTE_READ = `
cd -P -- "$1" 2>/dev/null || { echo missing; exit 0; }
root=$(pwd -P); t=$root; [ -n "$2" ] && t=$root/$2
[ -L "$t" ] && { echo link; exit 0; }
if [ -d "$t" ]; then
  c=$(cd -P -- "$t" && pwd -P) || { echo missing; exit 0; }
  case "$c/" in "$root"/*) ;; *) echo escape; exit 0 ;; esac
  printf 'dir\\n%s\\n%s\\n' "$root" "\${c#"$root"}"
  cd -- "$t" || exit 0
  for f in * .[!.]* ..?*; do
    [ -L "$f" ] && continue
    if [ -d "$f" ]; then printf 'd/%s\\n' "$f"; elif [ -e "$f" ]; then printf 'f/%s\\n' "$f"; fi
  done
elif [ -f "$t" ]; then
  d=$(cd -P -- "$(dirname -- "$t")" && pwd -P) || { echo missing; exit 0; }
  case "$d/" in "$root"/*) ;; *) echo escape; exit 0 ;; esac
  printf 'file\\n%s\\n%s\\n%s\\n' "$root" "\${d#"$root"}/\${t##*/}" "$(wc -c < "$t" | tr -d ' ')"
  head -c "$3" < "$t"
elif [ -e "$t" ]; then echo special
else echo missing
fi
`;

function remoteFailure(status: string): Error {
  if (status === "escape" || status === "link")
    return new ValidationError("Path leaves this checkout");
  if (status === "special") return new ValidationError("Only regular files can be previewed");
  return new ValidationError("File or folder no longer exists");
}

function takeLines(bytes: Uint8Array, count: number): { lines: string[]; rest: Uint8Array } {
  const lines: string[] = [];
  let start = 0;
  while (lines.length < count) {
    const end = bytes.indexOf(10, start);
    if (end < 0) break;
    lines.push(Buffer.from(bytes.subarray(start, end)).toString("utf8"));
    start = end + 1;
  }
  return { lines, rest: bytes.subarray(start) };
}

async function remoteCheckoutFiles(
  host: SshExecHost,
  root: string,
  path: string,
): Promise<CheckoutView> {
  const result = await hostExec(
    host,
    ["/bin/sh", "-c", REMOTE_READ, "sh", root, path, String(LIMIT)],
    {
      login: false,
      timeoutMs: 30_000,
    },
  );
  if (result.code !== 0) throw new ValidationError(result.stderr.trim() || "Cannot read checkout");
  const bytes = result.bytes ?? new Uint8Array();
  const [kind] = takeLines(bytes, 1).lines;
  if (kind === "dir") {
    const { lines } = takeLines(bytes, Number.POSITIVE_INFINITY);
    const [, canonicalRoot = root, inside = ""] = lines;
    const prefix = inside.replace(/^\//, "");
    const entries = sortEntries(
      lines
        .slice(3)
        .filter((line) => line.length > 2 && line.slice(2).toLowerCase() !== ".git")
        .map((line) => ({
          name: line.slice(2),
          path: prefix ? `${prefix}/${line.slice(2)}` : line.slice(2),
          directory: line.startsWith("d/"),
        })),
    );
    return {
      root: canonicalRoot,
      path: prefix,
      entries: entries.slice(0, 500),
      content: null,
      binary: false,
      truncated: entries.length > 500,
    };
  }
  if (kind === "file") {
    const { lines, rest } = takeLines(bytes, 4);
    const [, canonicalRoot = root, inside = path, size = "0"] = lines;
    const truncated = Number(size) > LIMIT;
    const content = decodeText(rest, truncated);
    return {
      root: canonicalRoot,
      path: inside.replace(/^\//, ""),
      entries: null,
      content,
      binary: content === null,
      truncated,
    };
  }
  throw remoteFailure(kind ?? "missing");
}

const saving = new Set<string>();

function assertEditable(content: string, original: string): void {
  if (
    Buffer.byteLength(content, "utf8") > LIMIT ||
    Buffer.byteLength(original, "utf8") > LIMIT ||
    content.includes("\0")
  )
    throw new ValidationError("Only UTF-8 text files up to 200 KB can be edited");
}

export async function saveCheckoutFile(
  host: ExecHost,
  cwd: string,
  path: string,
  content: string,
  original: string,
): Promise<void> {
  assertEditable(content, original);
  assertCheckoutPath(path);
  const root = await checkoutRoot(host, cwd);
  if (host.kind === "ssh") {
    await remoteSaveCheckoutFile(host, root, path, content, original);
    return;
  }
  const { canonical } = await resolveCheckoutPath(root, path);
  const info = await lstat(canonical);
  if (!info.isFile() || info.size > LIMIT || info.nlink !== 1)
    throw new ValidationError("Only regular text files up to 200 KB can be edited");
  if (saving.has(canonical)) throw new ConflictError("This file is being saved. Try again.");
  saving.add(canonical);
  try {
    const handle = await open(canonical, "r+");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > LIMIT || info.nlink !== 1)
        throw new ValidationError("Only regular text files up to 200 KB can be edited");
      const bytes = Buffer.alloc(info.size);
      let read = 0;
      while (read < bytes.length) {
        const result = await handle.read(bytes, read, bytes.length - read, read);
        if (result.bytesRead === 0)
          throw new ConflictError("File changed while reading. Reload it before saving.");
        read += result.bytesRead;
      }
      let current: string;
      try {
        current = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        throw new ValidationError("Only UTF-8 text files can be edited");
      }
      if (bytes.includes(0)) throw new ValidationError("Binary files cannot be edited");
      if (current !== original)
        throw new ConflictError("File changed on disk. Reload it before saving.");
      const next = Buffer.from(content, "utf8");
      let written = 0;
      while (written < next.length) {
        const result = await handle.write(next, written, next.length - written, written);
        if (result.bytesWritten === 0) throw new Error("File write made no progress");
        written += result.bytesWritten;
      }
      await handle.truncate(next.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } finally {
    saving.delete(canonical);
  }
}

const REMOTE_SAVE = `
n=$3; trap 'rm -f "$n"' EXIT
cd -P -- "$1" 2>/dev/null || { echo missing; exit 0; }
root=$(pwd -P); t=$root/$2
{ [ -f "$t" ] && [ ! -L "$t" ]; } || { echo type; exit 0; }
d=$(cd -P -- "$(dirname -- "$t")" && pwd -P) || { echo missing; exit 0; }
case "$d/" in "$root"/*) ;; *) echo escape; exit 0 ;; esac
[ -n "$(find "$t" -prune -links 1)" ] || { echo type; exit 0; }
[ "$(wc -c < "$t" | tr -d ' ')" -le "$4" ] || { echo type; exit 0; }
cmp -s - "$t" || { echo changed; exit 0; }
cat "$n" > "$t" && echo ok
`;

async function remoteSaveCheckoutFile(
  host: SshExecHost,
  root: string,
  path: string,
  content: string,
  original: string,
): Promise<void> {
  const key = `${host.alias}:${root}/${path}`;
  if (saving.has(key)) throw new ConflictError("This file is being saved. Try again.");
  saving.add(key);
  const staged = remoteTempPath(".edit");
  try {
    await writeHostFile(host, staged, content);
    const result = await hostExec(
      host,
      ["/bin/sh", "-c", REMOTE_SAVE, "sh", root, path, staged, String(LIMIT)],
      { input: original, login: false, timeoutMs: 30_000 },
    );
    const status = result.stdout.trim();
    if (status === "ok") return;
    if (status === "changed")
      throw new ConflictError("File changed on disk. Reload it before saving.");
    if (status === "type")
      throw new ValidationError("Only regular text files up to 200 KB can be edited");
    throw remoteFailure(status || "missing");
  } finally {
    saving.delete(key);
    await removeHostFile(host, staged);
  }
}
