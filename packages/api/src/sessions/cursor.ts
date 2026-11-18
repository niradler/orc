import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathLabel } from "@orc/core/display-path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { USAGE_EVENT_VERSION } from "@orc/core/usage";
import { activityAdvanced, oneLine, statusFromMtime } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

export const CURSOR_PROJECTS_DIR = join(homedir(), ".cursor", "projects");
export function cursorStateDbPath(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  let configRoot: string;
  if (platform === "win32") configRoot = env.APPDATA || join(home, "AppData", "Roaming");
  else if (platform === "darwin") configRoot = join(home, "Library", "Application Support");
  else configRoot = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(configRoot, "Cursor", "User", "globalStorage", "state.vscdb");
}

export const CURSOR_STATE_DB = cursorStateDbPath();

const pathBySlug = new Map<string, string | null>();

// Windows slugs lead with the drive letter ("c-Users-me-proj"); POSIX ones start at "/".
function slugRoot(slug: string, windows: boolean): { root: string; parts: string[] } {
  const parts = slug.split("-");
  const drive = parts[0] ?? "";
  if (windows && /^[A-Za-z]$/.test(drive))
    return { root: `${drive.toUpperCase()}:\\`, parts: parts.slice(1) };
  return { root: "/", parts };
}

export function resolveSlugPath(slug: string): string | null {
  const cached = pathBySlug.get(slug);
  if (cached !== undefined) return cached;
  const walk = (cur: string, parts: string[]): string | null => {
    if (parts.length === 0) return cur;
    for (let take = 1; take <= parts.length; take++) {
      const next = join(cur, parts.slice(0, take).join("-"));
      if (existsSync(next)) {
        const found = walk(next, parts.slice(take));
        if (found) return found;
      }
    }
    return null;
  };
  const { root, parts } = slugRoot(slug, process.platform === "win32");
  const resolved = walk(root, parts);
  pathBySlug.set(slug, resolved);
  return resolved;
}

function firstQueryFromText(content: string): string | null {
  try {
    const line = content.slice(0, 60_000).split("\n")[0] ?? "";
    const text = JSON.parse(line)?.message?.content?.find(
      (block: { type?: string }) => block.type === "text",
    )?.text as string | undefined;
    if (!text) return null;
    const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    return match?.[1] ?? text;
  } catch {
    return null;
  }
}

async function resolveSlugPathOnHost(slug: string, runtime: HostRuntime): Promise<string | null> {
  let deepest = { path: "", depth: 0 };
  const walk = async (current: string, parts: string[], depth: number): Promise<string | null> => {
    if (parts.length === 0) return current;
    if (depth > deepest.depth) deepest = { path: current, depth };
    for (let take = 1; take <= parts.length; take++) {
      const name = parts.slice(0, take).join("-");
      for (const candidate of [name, `.${name}`]) {
        const next = join(current, candidate);
        if (await runtime.isDirectory(next)) {
          const found = await walk(next, parts.slice(take), depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  };
  // SSH hosts are POSIX; only a local host can be Windows.
  const { root, parts } = slugRoot(
    slug,
    runtime.host.kind === "local" && process.platform === "win32",
  );
  const found = await walk(root, parts, 0);
  if (found) return found;
  const home = await runtime.home();
  return deepest.path.length > home.length && deepest.path.startsWith(home) ? deepest.path : null;
}

function folderFromUri(uri: unknown): string | null {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

export function cursorAdapter(
  opts: { projects?: string | null; stateDb?: string | null; runtime?: HostRuntime } = {},
): SessionAdapter {
  const runtime = opts.runtime ?? hostRuntime(LOCAL_HOST);
  const workspaceCache = new Map<string, { mtime: number; folder: string | null; ids: string[] }>();
  const workspaceFolders = async (stateDb: string): Promise<Map<string, string>> => {
    const storage = join(dirname(dirname(stateDb)), "workspaceStorage");
    const folders = new Map<string, string>();
    for (const file of await runtime.listFiles(storage)) {
      if (!file.path.endsWith("state.vscdb")) continue;
      let cached = workspaceCache.get(file.path);
      if (cached?.mtime !== file.mtimeMs) {
        let folder: string | null = null;
        let ids: string[] = [];
        try {
          folder = folderFromUri(
            JSON.parse(
              new TextDecoder().decode(
                await runtime.readFile(join(dirname(file.path), "workspace.json"), 64 * 1024),
              ),
            )?.folder,
          );
          if (folder)
            ids = (
              await runtime.sqliteQuery<{ id: string | null }>(
                file.path,
                `SELECT json_extract(c.value, '$.composerId') AS id
                 FROM ItemTable, json_each(ItemTable.value, '$.allComposers') AS c
                 WHERE ItemTable.key = 'composer.composerData'`,
              )
            ).flatMap((row) => (row.id ? [row.id] : []));
        } catch {}
        cached = { mtime: file.mtimeMs, folder, ids };
        workspaceCache.set(file.path, cached);
      }
      if (cached.folder) for (const id of cached.ids) folders.set(id, cached.folder);
    }
    return folders;
  };
  return {
    backend: "cursor",
    minIntervalMs: 30_000,
    async list(known) {
      const byId = new Map<string, SessionRecord>();
      const home = await runtime.home();
      const projectsDir =
        opts.projects === undefined ? join(home, ".cursor", "projects") : opts.projects;
      const stateDb =
        opts.stateDb === undefined
          ? ((
              await Promise.all(
                (["linux", "darwin"] as const).map(async (platform) => {
                  const path = cursorStateDbPath(platform, home, {});
                  return (await runtime.isFile(path)) ? path : null;
                }),
              )
            ).find((path): path is string => path !== null) ?? null)
          : opts.stateDb;
      if (stateDb && (await runtime.isFile(stateDb))) {
        const folders = await workspaceFolders(stateDb);
        const rows = await runtime.sqliteQuery<{
          id: string;
          f: string | null;
        }>(
          stateDb,
          `SELECT substr(key, 14) AS id,
                  json_extract(value, '$.name', '$.createdAt', '$.lastUpdatedAt',
                    '$.contextTokensUsed', '$.latestConversationSummary.summary.summary',
                    '$.fullConversationHeadersOnly[0].grouping.textPreview',
                    '$.subagentInfo.parentComposerId') AS f
           FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'
             AND COALESCE(json_extract(value, '$.isArchived'), 0) = 0`,
        );
        for (const row of rows) {
          if (!row.f) continue;
          const [name, created, updated, tokens, summary, preview, parent] = JSON.parse(row.f) as [
            string | null,
            number | null,
            number | null,
            number | null,
            string | null,
            string | null,
            string | null,
          ];
          if (!name) continue;
          const last = updated ?? created ?? Date.now();
          const folder = folders.get(row.id) ?? (parent ? folders.get(parent) : undefined);
          const text = summary || preview;
          byId.set(row.id, {
            backend: "cursor",
            externalId: row.id,
            ...(parent ? { parentId: parent } : {}),
            title: oneLine(
              name === "Generate a name for the chat"
                ? preview || pathLabel(folder) || "Cursor session"
                : name,
              120,
            ),
            ...(folder ? { cwd: folder } : {}),
            summary: text ? oneLine(text, 400) : null,
            status: statusFromMtime(last),
            createdAt: new Date(created ?? last),
            lastActivityAt: new Date(last),
            tokensUsed: tokens ?? null,
          });
        }
      }
      if (projectsDir) {
        for (const file of await runtime.listFiles(projectsDir)) {
          const match = /[\\/]([^\\/]+)[\\/]agent-transcripts[\\/]([^\\/]+)[\\/]\2\.jsonl$/.exec(
            file.path,
          );
          if (!match?.[1] || !match[2]) continue;
          const prompt = firstQueryFromText(
            new TextDecoder().decode(await runtime.readFile(file.path, 150 * 1024 * 1024)),
          );
          const r: SessionRecord = {
            backend: "cursor",
            externalId: match[2],
            title: oneLine(prompt ?? match[2], 120),
            summary: prompt ? oneLine(prompt, 400) : null,
            cwd: await resolveSlugPathOnHost(match[1], runtime),
            status: statusFromMtime(file.mtimeMs),
            createdAt: new Date(file.birthtimeMs || file.mtimeMs),
            lastActivityAt: new Date(file.mtimeMs),
            transcriptPath: file.path,
            tokensUsed: Math.round(file.size / 4),
          };
          const composer = byId.get(r.externalId);
          byId.set(r.externalId, {
            ...composer,
            ...r,
            cwd: r.cwd ?? composer?.cwd ?? null,
            summary: composer?.summary ?? r.summary ?? null,
            tokensUsed: composer?.tokensUsed ?? r.tokensUsed ?? null,
          });
        }
      }
      const records = [...byId.values()];
      for (const record of records) {
        const tokens = record.tokensUsed ?? 0;
        if (tokens <= 0) continue;
        const before = known.get(record.externalId);
        if (
          before &&
          !activityAdvanced(record.lastActivityAt, before.lastActivityMs) &&
          before.usageVersion === USAGE_EVENT_VERSION
        )
          continue;
        record.usage = async () => ({
          tokens,
          model: null,
          events: [
            {
              key: "session",
              ts: record.lastActivityAt.getTime(),
              model: null,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              otherTokens: tokens,
              estimated: true,
            },
          ],
        });
        record.usageVersion = USAGE_EVENT_VERSION;
      }
      return records;
    },
  };
}
