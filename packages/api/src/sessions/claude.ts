import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { z } from "zod";
import { isAlive, oneLine } from "./common.js";
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

export async function claudeTokens(path: string): Promise<number> {
  return claudeTokensFromText(await Bun.file(path).text());
}

function claudeTokensFromText(content: string): number {
  const seen = new Set<string>();
  let total = 0;
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
  for (const line of content.split("\n")) take(line);
  return total;
}

export function firstPrompt(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(200_000);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    return firstPromptFromText(buf.subarray(0, bytes).toString("utf-8"));
  } catch {}
  return null;
}

function firstPromptFromText(content: string): string | null {
  for (const line of content.slice(0, 200_000).split("\n")) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const body = JSON.parse(line)?.message?.content;
      const text =
        typeof body === "string"
          ? body
          : Array.isArray(body)
            ? body.find((block: { type?: string }) => block.type === "text")?.text
            : null;
      if (text && !text.trimStart().startsWith("<")) return oneLine(text, 400);
    } catch {}
  }
  return null;
}

export function claudeAdapter(
  dirs: {
    registry?: string;
    desktop?: string | null;
    projects?: string | null;
  } = {},
  runtime: HostRuntime = hostRuntime(LOCAL_HOST),
): SessionAdapter {
  const desktopCache = new Map<string, { mtime: number; record: SessionRecord | null }>();

  return {
    backend: "claude",
    minIntervalMs: 30_000,
    async list(known) {
      const home = await runtime.home();
      const registryDir = dirs.registry ?? join(home, ".claude", "sessions");
      const desktopDir =
        dirs.desktop === undefined
          ? join(home, "Library", "Application Support", "Claude", "claude-code-sessions")
          : dirs.desktop;
      const projectsDir =
        dirs.projects === undefined ? join(home, ".claude", "projects") : dirs.projects;
      const projectFiles = projectsDir ? await runtime.listFiles(projectsDir) : [];
      const transcripts = new Map(
        projectFiles
          .filter((file) => file.path.endsWith(".jsonl"))
          .map((file) => [basename(file.path, ".jsonl"), file] as const),
      );
      const records = new Map<string, SessionRecord>();

      if (desktopDir) {
        for (const file of await runtime.listFiles(desktopDir)) {
          if (!basename(file.path).startsWith("local_") || !file.path.endsWith(".json")) continue;
          const path = file.path;
          const mtime = file.mtimeMs;
          let cached = desktopCache.get(path);
          if (cached?.mtime !== mtime) {
            let record: SessionRecord | null = null;
            try {
              const d = DesktopEntry.parse(
                JSON.parse(new TextDecoder().decode(await runtime.readFile(path, 2 * 1024 * 1024))),
              );
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

      for (const file of await runtime.listFiles(registryDir, 10_000)) {
        if (!file.path.endsWith(".json")) continue;
        let entry: RegistryEntry;
        try {
          entry = RegistryEntry.parse(
            JSON.parse(new TextDecoder().decode(await runtime.readFile(file.path, 1024 * 1024))),
          );
        } catch {
          continue;
        }
        const now = Date.now();
        const live: SessionRecord = {
          backend: "claude",
          externalId: entry.sessionId,
          title: entry.name ?? basename(entry.cwd),
          cwd: entry.cwd,
          pid: entry.pid,
          status: !(await runtime.processAlive(entry.pid))
            ? "stopped"
            : entry.status === "busy"
              ? "running"
              : "idle",
          createdAt: new Date(entry.startedAt ?? now),
          lastActivityAt: new Date(entry.updatedAt ?? now),
        };
        const base = records.get(entry.sessionId);
        records.set(entry.sessionId, {
          ...base,
          ...live,
          title: base?.title ?? live.title,
          createdAt: base?.createdAt ?? live.createdAt,
        });
      }

      for (const record of records.values()) {
        const transcript = transcripts.get(record.externalId);
        if (!transcript) continue;
        record.transcriptPath = transcript.path;
        const before = known.get(record.externalId);
        const mtime = transcript.mtimeMs;
        record.lastActivityAt = new Date(Math.max(record.lastActivityAt.getTime(), mtime));
        if (!before || before.tokensUsed == null || mtime - before.lastActivityMs >= 1000) {
          const content = new TextDecoder().decode(
            await runtime.readFile(transcript.path, 150 * 1024 * 1024),
          );
          record.tokens = async () => claudeTokensFromText(content);
          record.summary = firstPromptFromText(content);
        }
      }
      return [...records.values()];
    },
  };
}
