import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mtimeOf, oneLine, statusFromMtime } from "./common.js";
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

export function codexAdapter(dbPath = CODEX_STATE_DB): SessionAdapter {
  return {
    backend: "codex",
    minIntervalMs: 30_000,
    async list() {
      if (!existsSync(dbPath)) return [];
      const db = new Database(dbPath, { readonly: true });
      try {
        const rows = db
          .query<ThreadRow, []>(
            `SELECT id, title, name, cwd, preview, first_user_message, tokens_used, rollout_path,
                    created_at_ms, created_at, updated_at_ms, updated_at
             FROM threads WHERE archived = 0`,
          )
          .all();
        return rows.map((r): SessionRecord => {
          const updated = r.updated_at_ms ?? r.updated_at * 1000;
          const live = mtimeOf(r.rollout_path);
          return {
            backend: "codex",
            externalId: r.id,
            title: oneLine(r.name || r.title || r.first_user_message || r.cwd, 120),
            summary: oneLine(r.preview || r.first_user_message || "", 400) || null,
            cwd: r.cwd,
            status: live ? statusFromMtime(live) : "stopped",
            createdAt: new Date(r.created_at_ms ?? r.created_at * 1000),
            lastActivityAt: new Date(Math.max(updated, live ?? 0)),
            transcriptPath: r.rollout_path,
            tokensUsed: r.tokens_used > 0 ? r.tokens_used : null,
          };
        });
      } finally {
        db.close();
      }
    },
  };
}
