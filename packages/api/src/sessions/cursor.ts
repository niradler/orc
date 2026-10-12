import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { oneLine, statusFromMtime } from "./common.js";
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
  const parts = slug.split("-");
  // Windows slugs lead with the drive letter ("c-Users-me-proj"); POSIX ones start at "/".
  const windowsDrive = process.platform === "win32" && /^[A-Za-z]$/.test(parts[0] ?? "");
  const resolved = windowsDrive
    ? walk(`${(parts[0] as string).toUpperCase()}:\\`, parts.slice(1))
    : walk("/", parts);
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
  const walk = async (current: string, parts: string[]): Promise<string | null> => {
    if (parts.length === 0) return current;
    for (let take = 1; take <= parts.length; take++) {
      const next = join(current, parts.slice(0, take).join("-"));
      if (await runtime.isDirectory(next)) {
        const found = await walk(next, parts.slice(take));
        if (found) return found;
      }
    }
    return null;
  };
  return walk("/", slug.split("-"));
}

export function cursorAdapter(
  opts: { projects?: string | null; stateDb?: string | null; runtime?: HostRuntime } = {},
): SessionAdapter {
  const runtime = opts.runtime ?? hostRuntime(LOCAL_HOST);
  return {
    backend: "cursor",
    minIntervalMs: 30_000,
    async list() {
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
        const rows = await runtime.sqliteQuery<{
          id: string;
          f: string | null;
        }>(
          stateDb,
          `SELECT substr(key, 14) AS id,
                  json_extract(value, '$.name', '$.createdAt', '$.lastUpdatedAt',
                    '$.contextTokensUsed', '$.latestConversationSummary.summary.summary',
                    '$.fullConversationHeadersOnly[0].grouping.textPreview') AS f
           FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'
             AND COALESCE(json_extract(value, '$.isArchived'), 0) = 0`,
        );
        for (const row of rows) {
          if (!row.f) continue;
          const [name, created, updated, tokens, summary, preview] = JSON.parse(row.f) as [
            string | null,
            number | null,
            number | null,
            number | null,
            string | null,
            string | null,
          ];
          if (!name) continue;
          const last = updated ?? created ?? Date.now();
          const text = summary || preview;
          byId.set(row.id, {
            backend: "cursor",
            externalId: row.id,
            title: oneLine(name, 120),
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
            summary: composer?.summary ?? r.summary ?? null,
            tokensUsed: composer?.tokensUsed ?? r.tokensUsed ?? null,
          });
        }
      }
      return [...byId.values()];
    },
  };
}
