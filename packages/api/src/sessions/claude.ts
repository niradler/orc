import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { isAlive, mtimeOf, oneLine } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

export const CLAUDE_REGISTRY_DIR = join(homedir(), ".claude", "sessions");
export const CLAUDE_DESKTOP_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "claude-code-sessions",
);
export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

const RegistryEntry = z.object({
  pid: z.number().int(),
  sessionId: z.string().min(1),
  cwd: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

const DesktopEntry = z.object({
  cliSessionId: z.string().min(1),
  cwd: z.string(),
  title: z.string().optional(),
  createdAt: z.number().optional(),
  lastActivityAt: z.number().optional(),
  isArchived: z.boolean().optional(),
});

export function readRegistryFile(path: string): RegistryEntry | null {
  try {
    return RegistryEntry.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

export function registryRecord(entry: RegistryEntry): SessionRecord {
  const now = Date.now();
  return {
    backend: "claude",
    externalId: entry.sessionId,
    title: entry.name ?? basename(entry.cwd),
    cwd: entry.cwd,
    pid: entry.pid,
    status: !isAlive(entry.pid) ? "stopped" : entry.status === "busy" ? "running" : "idle",
    createdAt: new Date(entry.startedAt ?? now),
    lastActivityAt: new Date(entry.updatedAt ?? now),
  };
}

function indexTranscripts(projectsDir: string): Map<string, string> {
  const byId = new Map<string, string>();
  if (!existsSync(projectsDir)) return byId;
  for (const dir of readdirSync(projectsDir)) {
    let files: string[];
    try {
      files = readdirSync(join(projectsDir, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(".jsonl")) byId.set(file.slice(0, -6), join(projectsDir, dir, file));
    }
  }
  return byId;
}

export async function claudeTokens(path: string): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  let tail = "";
  const decoder = new TextDecoder();
  const take = (line: string) => {
    if (!line.includes('"usage"')) return;
    try {
      const msg = JSON.parse(line)?.message;
      const usage = msg?.usage;
      if (!usage || (msg.id && seen.has(msg.id))) return;
      if (msg.id) seen.add(msg.id);
      total +=
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
    } catch {}
  };
  for await (const chunk of Bun.file(path).stream()) {
    const lines = (tail + decoder.decode(chunk, { stream: true })).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) take(line);
  }
  take(tail);
  return total;
}

export function firstPrompt(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(200_000);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const head = buf.subarray(0, bytes).toString("utf-8");
    for (const line of head.split("\n")) {
      if (!line.includes('"type":"user"')) continue;
      const content = JSON.parse(line)?.message?.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.find((b: { type?: string }) => b.type === "text")?.text
            : null;
      if (text && !text.trimStart().startsWith("<")) return oneLine(text, 400);
    }
  } catch {}
  return null;
}

export function claudeAdapter(
  dirs: { registry?: string; desktop?: string | null; projects?: string | null } = {},
): SessionAdapter {
  const registryDir = dirs.registry ?? CLAUDE_REGISTRY_DIR;
  const desktopDir = dirs.desktop === undefined ? CLAUDE_DESKTOP_DIR : dirs.desktop;
  const projectsDir = dirs.projects === undefined ? CLAUDE_PROJECTS_DIR : dirs.projects;
  const desktopCache = new Map<string, { mtime: number; record: SessionRecord | null }>();

  return {
    backend: "claude",
    minIntervalMs: 30_000,
    async list(known) {
      const transcripts = projectsDir ? indexTranscripts(projectsDir) : new Map<string, string>();
      const records = new Map<string, SessionRecord>();

      if (desktopDir && existsSync(desktopDir)) {
        for (const rel of readdirSync(desktopDir, { recursive: true }) as string[]) {
          if (!basename(rel).startsWith("local_") || !rel.endsWith(".json")) continue;
          const path = join(desktopDir, rel);
          const mtime = statSync(path).mtimeMs;
          let cached = desktopCache.get(path);
          if (cached?.mtime !== mtime) {
            let record: SessionRecord | null = null;
            try {
              const d = DesktopEntry.parse(JSON.parse(readFileSync(path, "utf-8")));
              if (!d.isArchived) {
                const last = new Date(d.lastActivityAt ?? d.createdAt ?? Date.now());
                record = {
                  backend: "claude",
                  externalId: d.cliSessionId,
                  title: d.title ?? basename(d.cwd),
                  cwd: d.cwd,
                  status: "stopped",
                  createdAt: new Date(d.createdAt ?? last.getTime()),
                  lastActivityAt: last,
                };
              }
            } catch {}
            cached = { mtime, record };
            desktopCache.set(path, cached);
          }
          if (cached.record) records.set(cached.record.externalId, { ...cached.record });
        }
      }

      if (existsSync(registryDir)) {
        for (const file of readdirSync(registryDir)) {
          if (!file.endsWith(".json")) continue;
          const entry = readRegistryFile(join(registryDir, file));
          if (!entry) continue;
          const live = registryRecord(entry);
          const base = records.get(entry.sessionId);
          records.set(entry.sessionId, {
            ...base,
            ...live,
            title: base?.title ?? live.title,
            createdAt: base?.createdAt ?? live.createdAt,
          });
        }
      }

      for (const record of records.values()) {
        const path = transcripts.get(record.externalId);
        if (!path) continue;
        record.transcriptPath = path;
        const before = known.get(record.externalId);
        const mtime = mtimeOf(path) ?? 0;
        record.lastActivityAt = new Date(Math.max(record.lastActivityAt.getTime(), mtime));
        if (!before || before.tokensUsed == null || mtime - before.lastActivityMs >= 1000) {
          record.tokens = () => claudeTokens(path);
          record.summary = firstPrompt(path);
        }
      }
      return [...records.values()];
    },
  };
}
