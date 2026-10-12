import { statSync } from "node:fs";
import { basename } from "node:path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { getDb } from "@orc/db/client";
import { projects } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import type { SessionStatus } from "./types.js";

export const LIVE_CHAT_ID = "__live-sessions__";
export const RECENT_WRITE_MS = 30_000;

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function statusFromMtime(mtimeMs: number): SessionStatus {
  return Date.now() - mtimeMs < RECENT_WRITE_MS ? "running" : "stopped";
}

export function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const projectByCwd = new Map<string, string | null>();

export async function projectIdFor(
  cwd: string | null | undefined,
  runtime: HostRuntime = hostRuntime(LOCAL_HOST),
): Promise<string | null> {
  if (!cwd) return null;
  const key = `${runtime.host.kind === "ssh" ? runtime.host.alias : "local"}:${cwd}`;
  const cached = projectByCwd.get(key);
  if (cached !== undefined) return cached;
  let id: string | null = null;
  try {
    const result = await runtime.exec(["git", "-C", cwd, "remote", "get-url", "origin"], {
      timeoutMs: 30_000,
    });
    const url = result.code === 0 ? result.stdout.trim() : "";
    if (url) {
      const name = basename(url).replace(/\.git$/, "");
      const row = await getDb().query.projects.findFirst({
        where: eq(projects.name, name),
      });
      id = row?.id ?? null;
    }
  } catch {
    id = null;
  }
  projectByCwd.set(key, id);
  return id;
}
