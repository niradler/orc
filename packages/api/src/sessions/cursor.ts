import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { oneLine, statusFromMtime } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

export const CURSOR_PROJECTS_DIR = join(homedir(), ".cursor", "projects");
export const CURSOR_STATE_DB = join(
  homedir(),
  "Library",
  "Application Support",
  "Cursor",
  "User",
  "globalStorage",
  "state.vscdb",
);

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
  const resolved = walk("/", slug.split("-"));
  pathBySlug.set(slug, resolved);
  return resolved;
}

function firstQuery(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(60_000);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const line = buf.subarray(0, bytes).toString("utf-8").split("\n")[0] ?? "";
    const text = JSON.parse(line)?.message?.content?.find(
      (b: { type?: string }) => b.type === "text",
    )?.text as string | undefined;
    if (!text) return null;
    const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
    return m?.[1] ?? text;
  } catch {
    return null;
  }
}

function transcriptRecords(projectsDir: string): SessionRecord[] {
  const out: SessionRecord[] = [];
  if (!existsSync(projectsDir)) return out;
  for (const slug of readdirSync(projectsDir)) {
    const root = join(projectsDir, slug, "agent-transcripts");
    if (!existsSync(root)) continue;
    for (const id of readdirSync(root)) {
      const file = join(root, id, `${id}.jsonl`);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const prompt = firstQuery(file);
      out.push({
        backend: "cursor",
        externalId: id,
        title: oneLine(prompt ?? id, 120),
        summary: prompt ? oneLine(prompt, 400) : null,
        cwd: resolveSlugPath(slug),
        status: statusFromMtime(st.mtimeMs),
        createdAt: new Date(st.birthtimeMs || st.mtimeMs),
        lastActivityAt: new Date(st.mtimeMs),
        transcriptPath: file,
        tokensUsed: Math.round(st.size / 4),
      });
    }
  }
  return out;
}

function composerRecords(dbPath: string): SessionRecord[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query<{ id: string; f: string | null }, []>(
        `SELECT substr(key, 14) AS id,
                json_extract(value, '$.name', '$.createdAt', '$.lastUpdatedAt',
                  '$.contextTokensUsed', '$.latestConversationSummary.summary.summary',
                  '$.fullConversationHeadersOnly[0].grouping.textPreview') AS f
         FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'`,
      )
      .all();
    const out: SessionRecord[] = [];
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
      out.push({
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
    return out;
  } finally {
    db.close();
  }
}

export function cursorAdapter(
  opts: { projects?: string | null; stateDb?: string | null } = {},
): SessionAdapter {
  const projectsDir = opts.projects === undefined ? CURSOR_PROJECTS_DIR : opts.projects;
  const stateDb = opts.stateDb === undefined ? CURSOR_STATE_DB : opts.stateDb;
  return {
    backend: "cursor",
    minIntervalMs: 120_000,
    async list() {
      const byId = new Map<string, SessionRecord>();
      if (stateDb) for (const r of composerRecords(stateDb)) byId.set(r.externalId, r);
      if (projectsDir) {
        for (const r of transcriptRecords(projectsDir)) {
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
