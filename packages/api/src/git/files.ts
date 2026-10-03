import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ValidationError } from "@orc/core/errors";
import { gitStatus } from "./panel.js";

const LIMIT = 200_000;
export async function checkoutFiles(cwd: string, path: string) {
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
    const binary = bytes.includes(0);
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
