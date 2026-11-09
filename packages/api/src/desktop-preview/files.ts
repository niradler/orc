import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreviewFile } from "@orc/core/desktop-preview";
import { ValidationError } from "@orc/core/errors";
import { type ExecHost, hostRuntime } from "@orc/core/exec-host";
import { saveCheckoutFile } from "../git/files.js";
import { gitStatus } from "../git/panel.js";

const IMAGE_LIMIT = 8 * 1024 * 1024;
const TEXT_LIMIT = 1024 * 1024;
const EDIT_LIMIT = 200_000;
const REMOTE_READ = `import os,sys,json,stat,base64
m=json.load(sys.stdin)
root=os.path.realpath(m['root']);target=os.path.realpath(os.path.join(root,m['path']))
try:
 if os.path.commonpath([root,target])!=root or '.git' in os.path.relpath(target,root).split(os.sep): raise ValueError('Path leaves the workspace')
 fd=os.open(target,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode) or info.st_size>m['limit']: raise ValueError('Only regular files up to 8 MiB can be previewed')
  with os.fdopen(fd,'rb',closefd=False) as f: data=f.read(m['limit']+1)
  if len(data)>m['limit']: raise ValueError('File exceeds the preview limit')
  print(json.dumps({'root':root,'path':target,'data':base64.b64encode(data).decode()}))
 finally: os.close(fd)
except (OSError,ValueError):
 print(json.dumps({'error':'File is unavailable, outside the workspace, or too large'}))
`;

export async function previewPath(
  host: ExecHost,
  cwd: string,
  target: string,
): Promise<{ root: string; path: string }> {
  const root = cwd;
  let input = target;
  if (/^file:/i.test(input)) {
    try {
      const url = new URL(input);
      if (host.kind === "local") input = fileURLToPath(url);
      else {
        if (url.hostname && url.hostname !== "localhost") throw new Error("Remote file authority");
        input = decodeURIComponent(url.pathname);
      }
    } catch {
      throw new ValidationError("Invalid file URL for this session host");
    }
  }
  const paths = host.kind === "ssh" ? posix : { isAbsolute, relative, resolve };
  let canonicalRoot = root,
    absolute = paths.resolve(root, input);
  if (host.kind === "local") {
    try {
      canonicalRoot = await realpath(root);
      absolute = await realpath(absolute);
    } catch {
      throw new ValidationError("File is unavailable");
    }
  }
  const path = paths.relative(canonicalRoot, absolute);
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.includes("\0") ||
    path.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git")
  )
    throw new ValidationError("Choose a file inside this session's workspace");
  return { root: canonicalRoot, path };
}

function imageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const prefix = new TextDecoder().decode(bytes.subarray(0, 12));
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8) === "WEBP") return "image/webp";
  if (prefix.startsWith("BM")) return "image/bmp";
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
  return null;
}

export async function readPreviewData(
  host: ExecHost,
  cwd: string,
  target: string,
  limit = IMAGE_LIMIT,
): Promise<{ root: string; path: string; bytes: Uint8Array }> {
  const scoped = await previewPath(host, cwd, target);
  let root = scoped.root,
    path: string,
    bytes: Uint8Array;
  if (host.kind === "local") {
    root = await realpath(root);
    try {
      path = await realpath(resolve(root, scoped.path));
    } catch {
      throw new ValidationError("File is unavailable");
    }
    const inside = relative(root, path);
    if (
      inside.startsWith("..") ||
      isAbsolute(inside) ||
      inside.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")
    )
      throw new ValidationError("Path leaves the workspace");
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > limit)
        throw new ValidationError("Only regular files up to 8 MiB can be previewed");
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > limit) throw new ValidationError("File exceeds the preview limit");
      bytes = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
  } else {
    const runtime = hostRuntime(host);
    const python = (await runtime.binary("python3")) ?? (await runtime.binary("python"));
    if (!python) throw new ValidationError("Remote previews require Python 3 on the session host");
    const result = await runtime.exec([python, "-c", REMOTE_READ], {
      input: JSON.stringify({ ...scoped, limit }),
      timeoutMs: 15000,
    });
    if (result.code !== 0) throw new ValidationError("Remote file could not be read");
    const data = JSON.parse(result.stdout) as {
      error?: string;
      root: string;
      path: string;
      data: string;
    };
    if (data.error) throw new ValidationError(data.error);
    root = data.root;
    path = data.path;
    bytes = Buffer.from(data.data, "base64");
  }
  return { root, path, bytes };
}

export async function readPreviewFile(
  host: ExecHost,
  cwd: string,
  target: string,
): Promise<PreviewFile> {
  const { root, path, bytes } = await readPreviewData(host, cwd, target);
  const mime = imageMime(bytes);
  if (mime)
    return {
      kind: "image",
      path,
      root,
      host: host.kind === "ssh" ? host.alias : null,
      content: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
      editable: false,
    };
  if (
    bytes.length > TEXT_LIMIT ||
    bytes.some((byte) => byte === 0 || (byte < 32 && ![9, 10, 12, 13, 27].includes(byte)))
  )
    throw new ValidationError("Preview supports images or UTF-8 text up to 1 MiB");
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ValidationError("Only UTF-8 text files can be previewed");
  }
  return {
    kind: "text",
    path,
    root,
    host: host.kind === "ssh" ? host.alias : null,
    content,
    editable: bytes.length <= EDIT_LIMIT,
  };
}

export async function savePreviewFile(
  host: ExecHost,
  cwd: string,
  target: string,
  content: string,
  original: string,
): Promise<void> {
  const file = await readPreviewFile(host, cwd, target);
  if (file.kind !== "text" || !file.editable)
    throw new ValidationError("Only UTF-8 text up to 200 KB can be edited");
  const root = (await gitStatus(host, file.root)).root ?? file.root;
  const path = (host.kind === "ssh" ? posix.relative : relative)(root, file.path);
  await saveCheckoutFile(host, root, path, content, original);
}
