import { type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { z } from "zod";
import { oneLine } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

const SESSION_LIMIT = 500;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const SessionRow = z.object({
  id: z.string().regex(SESSION_ID),
  directory: z.string().nullish(),
  title: z.string().nullish(),
  time_created: z.number().finite(),
  time_updated: z.number().finite(),
  tokens_input: z.number().nullish(),
  tokens_output: z.number().nullish(),
  tokens_reasoning: z.number().nullish(),
});

export async function opencodeDbPath(runtime: HostRuntime): Promise<string> {
  const home = await runtime.home();
  const sep = runtime.host.kind === "ssh" || !home.includes("\\") ? "/" : "\\";
  return [home, ".local", "share", "opencode", "opencode.db"].join(sep);
}

export function opencodeAdapter(
  dbPath: string | undefined = undefined,
  runtime: HostRuntime = hostRuntime(LOCAL_HOST),
): SessionAdapter {
  return {
    backend: "opencode",
    minIntervalMs: 30_000,
    async list() {
      const path = dbPath ?? (await opencodeDbPath(runtime));
      if (!(await runtime.isFile(path))) return [];
      const rows = await runtime.sqliteQuery<Record<string, unknown>>(
        path,
        `SELECT * FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ${SESSION_LIMIT}`,
      );
      const records: SessionRecord[] = [];
      for (const raw of rows) {
        const parsed = SessionRow.safeParse(raw);
        if (!parsed.success) continue;
        const row = parsed.data;
        const tokens =
          (row.tokens_input ?? 0) + (row.tokens_output ?? 0) + (row.tokens_reasoning ?? 0);
        records.push({
          backend: "opencode",
          externalId: row.id,
          title: oneLine(row.title || row.id, 120),
          cwd: row.directory || null,
          status: "stopped",
          createdAt: new Date(row.time_created),
          lastActivityAt: new Date(row.time_updated),
          transcriptPath: path,
          tokensUsed: tokens || null,
        });
      }
      return records;
    },
  };
}

type PartRow = { mid: string; mt: number; mdata: string; pdata: string | null };

/** Serializes one session's messages and parts as JSON lines for the opencode transcript reader. */
export async function opencodeTranscriptBytes(
  runtime: HostRuntime,
  dbPath: string,
  sessionId: string,
): Promise<Uint8Array> {
  if (!SESSION_ID.test(sessionId)) throw new Error("Malformed OpenCode session id");
  const rows = await runtime.sqliteQuery<PartRow>(
    dbPath,
    `SELECT m.id AS mid, m.time_created AS mt, m.data AS mdata, p.data AS pdata FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = '${sessionId}' ORDER BY m.time_created, m.id, p.time_created, p.id`,
  );
  const messages: { id: string; time: number; message: unknown; parts: unknown[] }[] = [];
  for (const row of rows) {
    let current = messages[messages.length - 1];
    if (current?.id !== row.mid) {
      current = { id: row.mid, time: row.mt, message: safeJson(row.mdata), parts: [] };
      messages.push(current);
    }
    if (row.pdata) current.parts.push(safeJson(row.pdata));
  }
  const lines = messages.map(({ time, message, parts }) =>
    JSON.stringify({ time, message, parts }),
  );
  return new TextEncoder().encode(lines.join("\n"));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
