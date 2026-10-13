import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { oneLine, statusFromMtime } from "./common.js";
import { hasWriter } from "./ownership.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

export const CODEX_STATE_DB = join(homedir(), ".codex", "state_5.sqlite");

type ThreadRow = {
  id: string;
  title: string;
  name: string | null;
  cwd: string;
  preview: string;
  first_user_message: string;
  tokens_used: number;
  rollout_path: string;
  created_at_ms: number | null;
  created_at: number;
  updated_at_ms: number | null;
  updated_at: number;
};

export function codexAdapter(
  dbPath = CODEX_STATE_DB,
  options: {
    writer?: (path: string) => boolean;
    historyDb?: string;
    runtime?: HostRuntime;
  } = {},
): SessionAdapter {
  const runtime = options.runtime ?? hostRuntime(LOCAL_HOST);
  return {
    backend: "codex",
    minIntervalMs: 5_000,
    async list() {
      const home =
        dbPath === CODEX_STATE_DB ? join(await runtime.home(), ".codex") : dirname(dbPath);
      const stateDb = dbPath === CODEX_STATE_DB ? join(home, "state_5.sqlite") : dbPath;
      if (!(await runtime.isFile(stateDb))) return [];
      let statuses = new Map<string, string>();
      try {
        statuses = new Map(
          (
            await runtime.sqliteQuery<{ thread_id: string; status: string }>(
              options.historyDb ?? join(home, "thread_history_1.sqlite"),
              `SELECT thread_id, status FROM (
                 SELECT thread_id, status, ROW_NUMBER() OVER
                   (PARTITION BY thread_id ORDER BY rollout_ordinal DESC) AS rank
                 FROM thread_turns
               ) WHERE rank = 1`,
            )
          ).map((row) => [row.thread_id, row.status]),
        );
      } catch {}
      const rows = await runtime.sqliteQuery<ThreadRow>(
        stateDb,
        `SELECT id, title, name, cwd, preview, first_user_message, tokens_used, rollout_path,
                created_at_ms, created_at, updated_at_ms, updated_at
         FROM threads WHERE archived = 0`,
      );
      return Promise.all(
        rows.map(async (r): Promise<SessionRecord> => {
          const updated = r.updated_at_ms ?? r.updated_at * 1000;
          const live = (await runtime.stat(r.rollout_path))?.mtimeMs ?? null;
          const owned =
            runtime.host.kind === "local"
              ? (options.writer ?? hasWriter)(join(home, "thread-writer-locks", `${r.id}.lock`))
              : statuses.get(r.id) === "inProgress";
          const turn = statuses.get(r.id);
          const status = owned
            ? turn === "inProgress"
              ? "running"
              : "idle"
            : (await runtime.isDirectory(join(home, "thread-writer-locks")))
              ? "stopped"
              : live
                ? statusFromMtime(live)
                : "stopped";
          return {
            backend: "codex",
            externalId: r.id,
            title: oneLine(r.name || r.title || r.first_user_message || r.cwd, 120),
            summary: oneLine(r.preview || r.first_user_message || "", 400) || null,
            cwd: r.cwd,
            status,
            createdAt: new Date(r.created_at_ms ?? r.created_at * 1000),
            lastActivityAt: new Date(Math.max(updated, live ?? 0)),
            transcriptPath: r.rollout_path,
            tokensUsed: r.tokens_used > 0 ? r.tokens_used : null,
          };
        }),
      );
    },
  };
}
