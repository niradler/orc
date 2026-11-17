import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathLabel } from "@orc/core/display-path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { CLAUDE_TOKENS_VERSION, USAGE_EVENT_VERSION } from "@orc/core/usage";
import { z } from "zod";
import { activityAdvanced, isAlive, oneLine, statusFromMtime } from "./common.js";
import type { SessionAdapter, SessionRecord, SessionWaiting } from "./types.js";
import { lifetimeUsage, type ParsedUsage, parseClaudeUsage } from "./usage-parsers.js";

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
  nameSource: z.string().optional(),
  status: z.string().optional(),
  waitingFor: z.string().nullish(),
  startedAt: z.number().optional(),
  updatedAt: z.number().optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

const DesktopEntry = z.object({
  sessionId: z.string().optional(),
  cliSessionId: z.string().min(1),
  spawnedFrom: z
    .object({ sessionId: z.string().min(1) })
    .nullish()
    .catch(null),
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

function registryName(entry: RegistryEntry): string | null {
  return entry.nameSource === "derived" ? null : entry.name || null;
}

function waitingReason(waitingFor: string | null | undefined): SessionWaiting["reason"] {
  if (waitingFor === "input needed") return "question";
  return /permission|sandbox|worker/.test(waitingFor ?? "") ? "permission" : "dialog";
}

function registryRunState(
  entry: RegistryEntry,
  alive: boolean,
): Pick<SessionRecord, "status" | "pendingHuman" | "waitingFor" | "background"> {
  if (!alive) return { status: "stopped" };
  if (entry.status === "waiting")
    return {
      status: "running",
      pendingHuman: true,
      waitingFor: { reason: waitingReason(entry.waitingFor), tool: null },
    };
  if (entry.status === "busy") return { status: "running", pendingHuman: false };
  return { status: "idle", pendingHuman: false, background: entry.status === "shell" };
}

export function registryRecord(entry: RegistryEntry): SessionRecord {
  const now = Date.now();
  return {
    backend: "claude",
    externalId: entry.sessionId,
    title: registryName(entry) || pathLabel(entry.cwd) || "Claude session",
    cwd: entry.cwd,
    pid: entry.pid,
    ...registryRunState(entry, isAlive(entry.pid)),
    createdAt: new Date(entry.startedAt ?? now),
    lastActivityAt: new Date(entry.updatedAt ?? now),
  };
}

export async function claudeTokens(path: string): Promise<number> {
  return claudeTokensFromText(await Bun.file(path).text());
}

function claudeTokensFromText(content: string): number {
  return parseClaudeUsage(content).tokens;
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

export type TranscriptMeta = {
  customTitle: string | null;
  aiTitle: string | null;
  prompt: string | null;
  firstAt: number | null;
  lastAt: number | null;
  pendingTool: string | null;
};

function lineAt(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index) + 1;
  const end = content.indexOf("\n", index);
  return content.slice(start, end === -1 ? undefined : end);
}

function lastField(content: string, marker: string, field: string): string | null {
  const index = content.lastIndexOf(marker);
  if (index === -1) return null;
  try {
    const value = JSON.parse(lineAt(content, index))?.[field];
    return typeof value === "string" && value.trim() ? oneLine(value, 120) : null;
  } catch {
    return null;
  }
}

function pendingTool(content: string): string | null {
  const index = content.lastIndexOf('"type":"tool_use"');
  if (index === -1) return null;
  try {
    const blocks = JSON.parse(lineAt(content, index))?.message?.content;
    const call = Array.isArray(blocks)
      ? blocks.findLast((block: { type?: string }) => block.type === "tool_use")
      : null;
    if (typeof call?.id !== "string" || typeof call.name !== "string") return null;
    return content.includes(`"tool_use_id":"${call.id}"`, index) ? null : call.name;
  } catch {
    return null;
  }
}

function lineTime(line: string): number | null {
  if (!line.includes('"timestamp"')) return null;
  try {
    const value = Date.parse(JSON.parse(line)?.timestamp);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function transcriptMeta(content: string): TranscriptMeta {
  const lines = content.split("\n");
  let firstAt: number | null = null;
  for (const line of lines.slice(0, 200)) {
    firstAt = lineTime(line);
    if (firstAt !== null) break;
  }
  let lastAt: number | null = null;
  for (let index = lines.length - 1; index >= 0 && lastAt === null; index--)
    lastAt = lineTime(lines[index] ?? "");
  return {
    customTitle: lastField(content, '"type":"custom-title"', "customTitle"),
    aiTitle: lastField(content, '"type":"ai-title"', "aiTitle"),
    prompt: firstPromptFromText(content),
    firstAt,
    lastAt,
    pendingTool: pendingTool(content),
  };
}

export function isClaudeProcessName(title: string, cwd: string | null | undefined): boolean {
  const folder = cwd ? basename(cwd) : "";
  if (!folder) return false;
  return (
    title === folder ||
    title === pathLabel(cwd ?? "") ||
    new RegExp(`^${RegExp.escape(folder)}-[0-9a-f]{2}$`, "i").test(title)
  );
}

function storedTitle(title: string | undefined, cwd: string | null | undefined): string | null {
  return title && !isClaudeProcessName(title, cwd) ? title : null;
}

const SubagentMeta = z.object({
  agentType: z.string().optional(),
  description: z.string().optional(),
});

export function claudeAdapter(
  dirs: {
    registry?: string | string[];
    desktop?: string | null;
    projects?: string | string[] | null;
  } = {},
  runtime: HostRuntime = hostRuntime(LOCAL_HOST),
): SessionAdapter {
  const desktopCache = new Map<
    string,
    {
      mtime: number;
      record: SessionRecord | null;
      desktopId?: string;
      cliId?: string;
      spawnedFrom?: string;
    }
  >();
  const metaCache = new Map<string, { mtime: number; meta: TranscriptMeta }>();
  const subagentCache = new Map<string, { mtime: number; title: string | null }>();

  const list = (value: string | string[] | null | undefined, fallback: string): string[] => {
    if (value === null) return [];
    if (Array.isArray(value)) return value;
    return value ? [value] : [fallback];
  };
  return {
    backend: "claude",
    minIntervalMs: 30_000,
    async list(known) {
      const home = await runtime.home();
      const registryDirs = list(dirs.registry, join(home, ".claude", "sessions"));
      const desktopDir =
        dirs.desktop === undefined
          ? join(home, "Library", "Application Support", "Claude", "claude-code-sessions")
          : dirs.desktop;
      const projectsDirs = list(dirs.projects, join(home, ".claude", "projects"));
      const transcripts = new Map<string, { path: string; mtimeMs: number }>();
      const subagents: { path: string; parentId: string; mtimeMs: number; birthtimeMs: number }[] =
        [];
      const subagentMeta = new Map<string, number>();
      for (const projectsDir of projectsDirs) {
        for (const file of await runtime.listFiles(projectsDir)) {
          if (basename(dirname(file.path)) === "subagents") {
            if (file.path.endsWith(".meta.json")) subagentMeta.set(file.path, file.mtimeMs);
            else if (basename(file.path).startsWith("agent-") && file.path.endsWith(".jsonl"))
              subagents.push({
                path: file.path,
                parentId: basename(dirname(dirname(file.path))),
                mtimeMs: file.mtimeMs,
                birthtimeMs: file.birthtimeMs,
              });
            continue;
          }
          if (!file.path.endsWith(".jsonl")) continue;
          const id = basename(file.path, ".jsonl");
          // Copied account directories can repeat a session id; the first home
          // (default first) keeps it so metadata and transcript stay together.
          if (!transcripts.has(id)) transcripts.set(id, { path: file.path, mtimeMs: file.mtimeMs });
        }
      }
      const records = new Map<string, SessionRecord>();

      if (desktopDir) {
        for (const file of await runtime.listFiles(desktopDir)) {
          if (!basename(file.path).startsWith("local_") || !file.path.endsWith(".json")) continue;
          const path = file.path;
          const mtime = file.mtimeMs;
          let cached = desktopCache.get(path);
          if (cached?.mtime !== mtime) {
            let record: SessionRecord | null = null;
            let link: { desktopId?: string; cliId?: string; spawnedFrom?: string } = {};
            try {
              const d = DesktopEntry.parse(
                JSON.parse(new TextDecoder().decode(await runtime.readFile(path, 2 * 1024 * 1024))),
              );
              link = {
                cliId: d.cliSessionId,
                ...(d.sessionId ? { desktopId: d.sessionId } : {}),
                ...(d.spawnedFrom ? { spawnedFrom: d.spawnedFrom.sessionId } : {}),
              };
              if (!d.isArchived) {
                const last = new Date(d.lastActivityAt ?? d.createdAt ?? Date.now());
                record = {
                  backend: "claude",
                  externalId: d.cliSessionId,
                  title: d.title || pathLabel(d.cwd) || "Claude session",
                  cwd: d.cwd,
                  status: "stopped",
                  createdAt: new Date(d.createdAt ?? last.getTime()),
                  lastActivityAt: last,
                };
              }
            } catch {}
            cached = { mtime, record, ...link };
            desktopCache.set(path, cached);
          }
          if (cached.record) records.set(cached.record.externalId, { ...cached.record });
        }
        const cliByDesktopId = new Map(
          [...desktopCache.values()].flatMap((entry) =>
            entry.desktopId && entry.cliId ? [[entry.desktopId, entry.cliId] as const] : [],
          ),
        );
        for (const entry of desktopCache.values()) {
          const record = entry.record && records.get(entry.record.externalId);
          const parent = entry.spawnedFrom && cliByDesktopId.get(entry.spawnedFrom);
          if (record && parent && parent !== record.externalId) record.spawnedFromId = parent;
        }
      }

      const registrySeen = new Set<string>();
      const chosenNames = new Map<string, string>();
      const desktopTitles = new Map(
        [...records.values()].flatMap((record) =>
          record.title ? [[record.externalId, record.title] as const] : [],
        ),
      );
      for (const registryDir of registryDirs) {
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
          if (registrySeen.has(entry.sessionId)) continue;
          registrySeen.add(entry.sessionId);
          const now = Date.now();
          const named = registryName(entry);
          if (named) chosenNames.set(entry.sessionId, named);
          const live: SessionRecord = {
            backend: "claude",
            externalId: entry.sessionId,
            title: named || "New session",
            cwd: entry.cwd,
            pid: entry.pid,
            ...registryRunState(entry, await runtime.processAlive(entry.pid)),
            createdAt: new Date(entry.startedAt ?? now),
            lastActivityAt: new Date(entry.updatedAt ?? now),
          };
          const base = records.get(entry.sessionId);
          records.set(entry.sessionId, {
            ...base,
            ...live,
            title: named || base?.title || live.title,
            createdAt: base?.createdAt ?? live.createdAt,
          });
        }
      }

      for (const [id, before] of known) {
        if (
          !records.has(id) &&
          before.session &&
          (before.tokensVersion !== CLAUDE_TOKENS_VERSION ||
            before.usageVersion !== USAGE_EVENT_VERSION) &&
          transcripts.has(id)
        ) {
          records.set(id, { ...before.session });
        } else if (
          !records.has(id) &&
          before.session &&
          !transcripts.has(id) &&
          before.usageVersion !== USAGE_EVENT_VERSION
        ) {
          // No transcript is left to index. Report the known session once so the settle
          // loop below writes its lifetime total instead of leaving it pending forever.
          const title =
            before.session.title !== "New session" &&
            !storedTitle(before.session.title, before.session.cwd)
              ? "New session"
              : before.session.title;
          records.set(id, { ...before.session, title });
        } else if (
          !records.has(id) &&
          before.session &&
          !transcripts.has(id) &&
          before.session.title !== "New session" &&
          !storedTitle(before.session.title, before.session.cwd)
        ) {
          records.set(id, { ...before.session, title: "New session" });
        }
      }
      for (const record of records.values()) {
        const transcript = transcripts.get(record.externalId);
        if (!transcript) continue;
        record.transcriptPath = transcript.path;
        const before = known.get(record.externalId);
        const mtime = transcript.mtimeMs;
        const cached = metaCache.get(record.externalId);
        const changed =
          cached?.mtime !== mtime && (!before || activityAdvanced(mtime, before.lastActivityMs));
        let parsed: ParsedUsage | null = null;
        if (
          changed ||
          (record.waitingFor && cached?.mtime !== mtime) ||
          before?.tokensUsed == null ||
          before?.tokensVersion !== CLAUDE_TOKENS_VERSION
        ) {
          const content = new TextDecoder().decode(
            await runtime.readFile(transcript.path, 150 * 1024 * 1024),
          );
          parsed = parseClaudeUsage(content, mtime);
          record.tokens = async () => parsed?.tokens ?? 0;
          record.tokensVersion = CLAUDE_TOKENS_VERSION;
          const meta = transcriptMeta(content);
          metaCache.set(record.externalId, { mtime, meta });
          record.summary = meta.prompt;
        }
        const meta = metaCache.get(record.externalId)?.meta;
        if (record.waitingFor && meta?.pendingTool)
          record.waitingFor = {
            reason: meta.pendingTool === "AskUserQuestion" ? "question" : record.waitingFor.reason,
            tool: meta.pendingTool,
          };
        if (meta) {
          record.title =
            meta.customTitle ||
            chosenNames.get(record.externalId) ||
            desktopTitles.get(record.externalId) ||
            meta.aiTitle ||
            storedTitle(before?.session?.title, record.cwd) ||
            (meta.prompt ? oneLine(meta.prompt, 120) : null) ||
            storedTitle(record.title, record.cwd) ||
            "New session";
          if (meta.firstAt) record.createdAt = new Date(meta.firstAt);
        } else {
          record.title =
            chosenNames.get(record.externalId) ||
            desktopTitles.get(record.externalId) ||
            storedTitle(before?.session?.title, record.cwd) ||
            record.title;
        }
        record.lastActivityAt = new Date(
          Math.max(
            record.lastActivityAt.getTime(),
            meta ? (meta.lastAt ?? mtime) : (before?.lastActivityMs ?? mtime),
          ),
        );
        if (changed || before?.usageVersion !== USAGE_EVENT_VERSION) {
          record.usage = async () => {
            if (parsed) return parsed;
            const content = new TextDecoder().decode(
              await runtime.readFile(transcript.path, 150 * 1024 * 1024),
            );
            parsed = parseClaudeUsage(content, mtime);
            return parsed;
          };
          record.usageVersion = USAGE_EVENT_VERSION;
        }
      }
      // A registry or desktop entry without a transcript has nothing left to index.
      // Settle it once so Coverage stops reporting it as pending; if a transcript
      // appears later, the normal activity check indexes it then.
      for (const record of records.values()) {
        if (transcripts.has(record.externalId)) continue;
        const before = known.get(record.externalId);
        if (before?.usageVersion === USAGE_EVENT_VERSION) continue;
        const lifetime = before?.tokensUsed ?? 0;
        record.usage = async () => lifetimeUsage(lifetime, record.lastActivityAt.getTime());
        record.usageVersion = USAGE_EVENT_VERSION;
      }
      const parents = new Map<string, { cwd: string | null; live: boolean }>();
      for (const [id, before] of known)
        parents.set(id, { cwd: before.session?.cwd ?? null, live: false });
      for (const record of records.values())
        parents.set(record.externalId, {
          cwd: record.cwd ?? null,
          live: record.status !== "stopped",
        });
      for (const subagent of subagents) {
        const parent = parents.get(subagent.parentId);
        if (!parent) continue;
        const metaPath = subagent.path.replace(/\.jsonl$/, ".meta.json");
        const metaMtime = subagentMeta.get(metaPath);
        let cached = subagentCache.get(metaPath);
        if (metaMtime !== undefined && cached?.mtime !== metaMtime) {
          let title: string | null = null;
          try {
            const meta = SubagentMeta.parse(
              JSON.parse(new TextDecoder().decode(await runtime.readFile(metaPath, 64 * 1024))),
            );
            title = meta.description || meta.agentType || null;
          } catch {}
          cached = { mtime: metaMtime, title };
          subagentCache.set(metaPath, cached);
        }
        records.set(basename(subagent.path, ".jsonl"), {
          backend: "claude",
          externalId: basename(subagent.path, ".jsonl"),
          parentId: subagent.parentId,
          title: oneLine(cached?.title || "Subagent", 120),
          cwd: parent.cwd,
          status: parent.live ? statusFromMtime(subagent.mtimeMs) : "stopped",
          createdAt: new Date(subagent.birthtimeMs || subagent.mtimeMs),
          lastActivityAt: new Date(subagent.mtimeMs),
          transcriptPath: subagent.path,
        });
      }
      return [...records.values()];
    },
  };
}
