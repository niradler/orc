import { statSync } from "node:fs";
import { basename } from "node:path";
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

export async function projectIdFor(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null;
  const cached = projectByCwd.get(cwd);
  if (cached !== undefined) return cached;
  let id: string | null = null;
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const url = (await new Response(proc.stdout).text()).trim();
    if (url) {
      const name = basename(url).replace(/\.git$/, "");
      const row = await getDb().query.projects.findFirst({ where: eq(projects.name, name) });
      id = row?.id ?? null;
    }
  } catch {
    id = null;
  }
  projectByCwd.set(cwd, id);
  return id;
}
