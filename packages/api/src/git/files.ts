import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { gitStatus } from "./panel.js";

const LIMIT = 200_000;
async function resolveCheckoutPath(
  cwd: string,
  path: string,
): Promise<{ root: string; canonical: string; inside: string }> {
  const root = await realpath((await gitStatus(cwd)).root ?? cwd);
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git") ||
    path.includes("\0")
  )
    throw new ValidationError("Choose a path inside this checkout");
  const target = resolve(root, path);
  let canonical: string;
  try {
    canonical = await realpath(target);
  } catch {
    throw new ValidationError("File or folder no longer exists");
  }
  const inside = relative(root, canonical);
  if (
    inside.startsWith("..") ||
    isAbsolute(inside) ||
    inside.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")
  )
    throw new ValidationError("Path leaves this checkout");
  return { root, canonical, inside };
}

export async function checkoutFiles(cwd: string, path: string) {
  const { root, canonical, inside } = await resolveCheckoutPath(cwd, path);
  const info = await lstat(canonical);
  if (info.isDirectory()) {
    const entries = (await readdir(canonical, { withFileTypes: true }))
      .filter((entry) => entry.name.toLowerCase() !== ".git" && !entry.isSymbolicLink())
      .map((entry) => ({
        name: entry.name,
        path: relative(root, join(canonical, entry.name)).replace(/\\/g, "/"),
        directory: entry.isDirectory(),
      }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return {
      root,
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
    const bytes = buffer.subarray(0, bytesRead);
    let binary = bytes.includes(0);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: info.size > LIMIT });
    } catch {
      binary = true;
    }
    return {
      root,
      path: inside.replace(/\\/g, "/"),
      entries: null,
      content: binary ? null : bytes.toString("utf8"),
      binary,
      truncated: info.size > LIMIT,
    };
  } finally {
    await handle.close();
  }
}

const saving = new Set<string>();

export async function saveCheckoutFile(
  cwd: string,
  path: string,
  content: string,
  original: string,
): Promise<void> {
  if (
    Buffer.byteLength(content, "utf8") > LIMIT ||
    Buffer.byteLength(original, "utf8") > LIMIT ||
    content.includes("\0")
  )
    throw new ValidationError("Only UTF-8 text files up to 200 KB can be edited");
  const { canonical } = await resolveCheckoutPath(cwd, path);
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
        current = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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
