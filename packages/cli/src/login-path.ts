import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, isAbsolute } from "node:path";

const MARK = "__ORC_PATH__";

export function mergePaths(login: string, current: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...login.split(delimiter), ...current.split(delimiter)]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(delimiter);
}

export function loginShellPath(): string | null {
  if (process.platform === "win32") return null;
  const shell = [
    process.env.SHELL,
    userInfo().shell,
    process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
    "/bin/sh",
  ].find(
    (candidate): candidate is string =>
      !!candidate && isAbsolute(candidate) && existsSync(candidate),
  );
  if (!shell) return null;
  try {
    const proc = Bun.spawnSync([shell, "-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      stdin: "ignore",
      stderr: "ignore",
      timeout: 8000,
    });
    return new RegExp(`${MARK}(.*)${MARK}`, "s").exec(proc.stdout.toString())?.[1] || null;
  } catch {
    return null;
  }
}

export function inheritLoginShellPath(): void {
  const login = loginShellPath();
  if (login) process.env.PATH = mergePaths(login, process.env.PATH ?? "");
}
