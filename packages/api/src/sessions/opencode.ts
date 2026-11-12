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

const SESSION_COLUMNS =
  "id, directory, title, time_created, time_updated, tokens_input, tokens_output, tokens_reasoning";

/** Queries a table that may not exist in this OpenCode version's database. */
async function queryTable<T extends object>(
  runtime: HostRuntime,
  path: string,
  sql: string,
): Promise<T[]> {
  try {
    return await runtime.sqliteQuery<T>(path, sql);
  } catch (error) {
    if (/no such table/i.test(error instanceof Error ? error.message : String(error))) return [];
    throw error;
  }
}

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
      // OpenCode 2.2+ keeps sessions in session_v2; the legacy session table
      // still holds conversations created before the migration, so read both.
      const tail = `WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ${SESSION_LIMIT}`;
      const current = await queryTable<Record<string, unknown>>(
        runtime,
        path,
        `SELECT ${SESSION_COLUMNS} FROM session_v2 ${tail}`,
      );
      const legacy = await queryTable<Record<string, unknown>>(
        runtime,
        path,
        `SELECT ${SESSION_COLUMNS} FROM session ${tail}`,
      );
      const seen = new Set<string>();
      const records: SessionRecord[] = [];
      for (const raw of [...current, ...legacy]) {
        const parsed = SessionRow.safeParse(raw);
        if (!parsed.success || seen.has(parsed.data.id)) continue;
        seen.add(parsed.data.id);
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
      records.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
      return records.slice(0, SESSION_LIMIT);
    },
  };
}

type PartRow = { mid: string; mt: number; mdata: string; pdata: string | null };
type MessageRow = { mid: string; mt: number; mtype: string; mdata: string };

/** Normalizes an OpenCode 2.2+ message (inline parts) into the legacy part shapes. */
function v2Parts(data: unknown): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  if (!data || typeof data !== "object") return parts;
  const message = data as { text?: unknown; synthetic?: unknown; content?: unknown };
  if (typeof message.text === "string" && message.text)
    parts.push({
      type: "text",
      text: message.text,
      ...(message.synthetic === true ? { synthetic: true } : {}),
    });
  if (Array.isArray(message.content)) {
    for (const raw of message.content) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Record<string, unknown>;
      if (part.type !== "tool") {
        parts.push(part);
        continue;
      }
      const callId = part.id ?? part.callID;
      parts.push({
        type: "tool",
        tool: part.name ?? part.tool ?? "tool",
        ...(callId ? { callID: callId } : {}),
        ...(part.state !== undefined ? { state: part.state } : {}),
      });
    }
  }
  return parts;
}

/** Serializes one session's messages and parts as JSON lines for the opencode transcript reader. */
export async function opencodeTranscriptBytes(
  runtime: HostRuntime,
  dbPath: string,
  sessionId: string,
): Promise<Uint8Array> {
  if (!SESSION_ID.test(sessionId)) throw new Error("Malformed OpenCode session id");
  // OpenCode 2.2+ stores whole messages with inline parts in session_message;
  // older sessions keep messages and parts in separate tables.
  const messages = await queryTable<MessageRow>(
    runtime,
    dbPath,
    `SELECT m.id AS mid, m.time_created AS mt, m.type AS mtype, m.data AS mdata FROM session_message m WHERE m.session_id = '${sessionId}' ORDER BY m.seq`,
  );
  if (messages.length) {
    const v2Lines = messages.map((row) =>
      JSON.stringify({
        time: row.mt,
        message: { role: row.mtype },
        parts: v2Parts(safeJson(row.mdata)),
      }),
    );
    return new TextEncoder().encode(v2Lines.join("\n"));
  }
  const rows = await queryTable<PartRow>(
    runtime,
    dbPath,
    `SELECT m.id AS mid, m.time_created AS mt, m.data AS mdata, p.data AS pdata FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = '${sessionId}' ORDER BY m.time_created, m.id, p.time_created, p.id`,
  );
  const grouped: { id: string; time: number; message: unknown; parts: unknown[] }[] = [];
  for (const row of rows) {
    let current = grouped[grouped.length - 1];
    if (current?.id !== row.mid) {
      current = { id: row.mid, time: row.mt, message: safeJson(row.mdata), parts: [] };
      grouped.push(current);
    }
    if (row.pdata) current.parts.push(safeJson(row.pdata));
  }
  const lines = grouped.map(({ time, message, parts }) => JSON.stringify({ time, message, parts }));
  return new TextEncoder().encode(lines.join("\n"));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
