import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { getDb } from "@orc/db/client";
import { gateway_sessions } from "@orc/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { LIVE_CHAT_ID, oneLine } from "./common.js";

export type SearchHit = {
  row: typeof gateway_sessions.$inferSelect;
  score: number;
  matched: string[];
  snippets: string[];
};

export type SearchResult = { hits: SearchHit[]; rg: boolean; ms: number };

const RG_TIMEOUT_MS = 20_000;
const SNIPPETS_PER_FILE = 3;

const RG_LOCATIONS = [
  "/opt/homebrew/bin/rg",
  "/usr/local/bin/rg",
  "/usr/bin/rg",
  join(homedir(), ".cargo", "bin", "rg"),
  join(homedir(), ".local", "bin", "rg"),
];

export function findRg(locations: string[] = RG_LOCATIONS): string | null {
  return (
    Bun.which("rg", { PATH: process.env.PATH ?? "" }) ??
    locations.find((path) => existsSync(path)) ??
    null
  );
}

async function roots(runtime: HostRuntime): Promise<string[]> {
  const configured = process.env.ORC_SESSION_SEARCH_ROOTS;
  const home = await runtime.home();
  const all = configured
    ? configured.split(delimiter)
    : [
        join(home, ".claude", "projects"),
        join(home, ".codex", "sessions"),
        join(home, ".cursor", "projects"),
        join(home, ".gemini", "tmp"),
        join(home, ".orc", "live-sessions", "transcripts"),
      ];
  const present = await Promise.all(
    all.map(async (dir) => ((await runtime.isDirectory(dir)) ? dir : null)),
  );
  return present.filter((dir): dir is string => dir !== null);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanSnippet(raw: string): string {
  return oneLine(
    raw
      .replace(/\\[nrt]/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\"),
    200,
  );
}

async function ripgrep(q: string, runtime: HostRuntime): Promise<Map<string, string[]> | null> {
  const rg = (await runtime.binary("rg")) ?? (runtime.host.kind === "local" ? findRg() : null);
  const dirs = await roots(runtime);
  if (!rg) return null;
  if (dirs.length === 0) return new Map();
  const result = await runtime.exec(
    [
      rg,
      "-i",
      "-o",
      "-0",
      "-m",
      String(SNIPPETS_PER_FILE),
      "--no-line-number",
      "--no-heading",
      "--with-filename",
      "-g",
      "*.jsonl",
      "-g",
      "session-*.json",
      "-e",
      `.{0,80}${escapeRegex(q)}.{0,80}`,
      ...dirs,
    ],
    { timeoutMs: RG_TIMEOUT_MS },
  );
  const out = result.stdout;
  const byFile = new Map<string, string[]>();
  for (const line of out.split("\n")) {
    const at = line.indexOf("\0");
    if (at < 0) continue;
    const file = line.slice(0, at);
    const list = byFile.get(file) ?? [];
    if (list.length < SNIPPETS_PER_FILE) list.push(cleanSnippet(line.slice(at + 1)));
    byFile.set(file, list);
  }
  return byFile;
}

export async function searchSessions(opts: {
  q: string;
  agent?: string | undefined;
  limit?: number;
  projectId?: string | undefined;
  runtime?: HostRuntime;
}): Promise<SearchResult> {
  const started = Date.now();
  const q = opts.q.trim();
  const db = getDb();
  const needle = q.toLowerCase();
  const [dbRows, files] = await Promise.all([
    db.query.gateway_sessions.findMany({
      where: and(
        eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
        opts.projectId === "unassigned"
          ? isNull(gateway_sessions.project_id)
          : opts.projectId
            ? eq(gateway_sessions.project_id, opts.projectId)
            : undefined,
        opts.agent ? eq(gateway_sessions.backend, opts.agent) : undefined,
      ),
      orderBy: [desc(gateway_sessions.last_activity_at)],
    }),
    ripgrep(q, opts.runtime ?? hostRuntime(LOCAL_HOST)),
  ]);

  const byPath = new Map(
    dbRows.filter((r) => r.transcript_path).map((r) => [r.transcript_path as string, r]),
  );
  const hits = new Map<string, SearchHit>();
  const hit = (row: SearchHit["row"]) => {
    let h = hits.get(row.id);
    if (!h) {
      h = { row, score: 0, matched: [], snippets: [] };
      hits.set(row.id, h);
    }
    return h;
  };

  for (const row of dbRows) {
    const fields: [string, string | null, number][] = [
      ["title", row.title, 5],
      ["summary", row.summary, 3],
      ["directory", row.cwd, 1],
    ];
    for (const [name, value, weight] of fields) {
      if (value?.toLowerCase().includes(needle)) {
        const h = hit(row);
        h.score += weight;
        h.matched.push(name);
      }
    }
  }

  for (const [file, snippets] of files ?? []) {
    const row = byPath.get(file);
    if (!row) continue;
    const h = hit(row);
    h.score += snippets.length * 2;
    h.matched.push("transcript");
    h.snippets = snippets;
  }

  const sorted = [...hits.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.row.last_activity_at?.getTime() ?? 0) - (a.row.last_activity_at?.getTime() ?? 0),
    )
    .slice(0, opts.limit ?? 100);
  return { hits: sorted, rg: files !== null, ms: Date.now() - started };
}
