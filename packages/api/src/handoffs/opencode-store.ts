import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { type ExecHost, type HostRuntime, hostExec } from "@orc/core/exec-host";
import type { SessionBundle, SessionHandoffRequest } from "@orc/core/session-handoff";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** OpenCode ids are `<prefix>_` + 12 hex time digits + 14 base62 characters. */
export function newOpenCodeId(prefix: "ses" | "msg"): string {
  const time = Date.now().toString(16).padStart(12, "0");
  let random = "";
  for (const byte of randomBytes(14)) random += ID_ALPHABET[byte % 62];
  return `${prefix}_${time}${random}`;
}

interface SessionRow {
  id: string;
  [key: string]: unknown;
}
interface MessageRow {
  id: string;
  type: string;
  seq: number;
  time_created: number;
  time_updated: number;
  data: string;
}

/** OpenCode's `path` column is the cwd without its root separator, in posix form. */
function openCodePath(cwd: string): string {
  return cwd
    .replace(/\\/g, "/")
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\//, "");
}

function parseLines(content: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ValidationError("OpenCode session export contains invalid JSONL");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ValidationError("OpenCode session export records must be JSON objects");
    rows.push(value as Record<string, unknown>);
  }
  return rows;
}

export function validateOpenCodeBundle(
  bundle: SessionBundle,
  request: SessionHandoffRequest,
): void {
  const main = bundle.files.find((file) => file.path === "session.jsonl");
  if (!main) throw new ValidationError("Upload must contain session.jsonl");
  if (bundle.files.length !== 1)
    throw new ValidationError("OpenCode handoff carries one export file");
  const rows = parseLines(main.content);
  const header = rows[0];
  const row = header?.row as SessionRow | undefined;
  if (header?.type !== "session" || !row || row.id !== request.session_id)
    throw new ValidationError("OpenCode export does not match the source session");
  if (!rows.slice(1).some((entry) => entry.type === "session_message"))
    throw new ValidationError("OpenCode export has no messages");
  for (const entry of rows.slice(1)) {
    if (
      entry.type !== "session_message" ||
      typeof entry.data !== "string" ||
      typeof entry.role !== "string"
    )
      throw new ValidationError("OpenCode export contains an unsupported record");
    try {
      JSON.parse(entry.data);
    } catch {
      throw new ValidationError("OpenCode message data is not valid JSON");
    }
  }
}

/** Raw-row export of one OpenCode 2.2+ session; legacy stores are refused clearly. */
export async function exportOpenCodeSession(
  runtime: HostRuntime,
  dbPath: string,
  sessionId: string,
): Promise<SessionBundle> {
  if (!SESSION_ID.test(sessionId)) throw new ValidationError("Malformed OpenCode session id");
  if (!(await runtime.isFile(dbPath)))
    throw new ValidationError("The OpenCode database is missing on the source host");
  const rows = await runtime.sqliteQuery<SessionRow>(
    dbPath,
    `SELECT * FROM session_v2 WHERE id = '${sessionId}'`,
  );
  if (!rows.length) {
    const legacy = await runtime.sqliteQuery<{ id: string }>(
      dbPath,
      `SELECT id FROM session WHERE id = '${sessionId}'`,
    );
    if (legacy.length)
      throw new ValidationError(
        "This OpenCode session uses the legacy store. Open it in OpenCode once to migrate it, then send again.",
      );
    throw new ValidationError("OpenCode session not found in the source database");
  }
  const before = rows[0]?.time_updated;
  const messages = await runtime.sqliteQuery<MessageRow>(
    dbPath,
    `SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = '${sessionId}' ORDER BY seq`,
  );
  if (!messages.length) throw new ValidationError("The OpenCode session has no messages to move");
  const after = await runtime.sqliteQuery<{ time_updated: number }>(
    dbPath,
    `SELECT time_updated FROM session_v2 WHERE id = '${sessionId}'`,
  );
  if (after[0]?.time_updated !== before)
    throw new ConflictError(
      "The OpenCode session changed during the snapshot; wait for it to be idle and retry",
    );
  const lines = [
    JSON.stringify({ type: "session", row: rows[0] }),
    ...messages.map((message) =>
      JSON.stringify({
        type: "session_message",
        id: message.id,
        role: message.type,
        seq: message.seq,
        time_created: message.time_created,
        time_updated: message.time_updated,
        data: message.data,
      }),
    ),
  ];
  return { version: 1, files: [{ path: "session.jsonl", content: `${lines.join("\n")}\n` }] };
}

const REMOTE_INSTALL_SCRIPT = `import json, sqlite3, sys
data = json.load(sys.stdin)
db = sqlite3.connect(data['dbPath'], timeout=30)
try:
    def columns(table):
        return [r[1] for r in db.execute('PRAGMA table_info(' + table + ')')]
    def insert(table, row):
        cols = [c for c in columns(table) if c in row]
        sql = 'INSERT INTO ' + table + ' (' + ','.join(cols) + ') VALUES (' + ','.join('?' for _ in cols) + ')'
        db.execute(sql, [row[c] for c in cols])
    project = data.get('project')
    if project:
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        if 'project' in tables:
            existing = db.execute('SELECT id FROM project WHERE id = ?', [project['id']]).fetchone()
            if not existing:
                insert('project', project)
    insert('session_v2', data['session'])
    for message in data['messages']:
        insert('session_message', message)
    db.commit()
finally:
    db.close()
`;

/**
 * Installs an exported session into the destination OpenCode database under a
 * new session id, relocating its directory. Message ids are regenerated; the
 * v2 message data holds no cross-message references.
 */
export async function installOpenCodeSession(
  host: ExecHost,
  dbPath: string,
  bundle: SessionBundle,
  _request: SessionHandoffRequest,
  sessionId: string,
  cwd: string,
): Promise<void> {
  const rows = parseLines(bundle.files[0]?.content ?? "");
  const source = (rows[0]?.row ?? {}) as SessionRow;
  const session: Record<string, unknown> = {
    ...source,
    id: sessionId,
    directory: cwd,
    path: openCodePath(cwd),
    parent_id: null,
    workspace_id: null,
    share_url: null,
    time_archived: null,
    time_compacting: null,
  };
  if ("fork_session_id" in source) session.fork_session_id = null;
  // OpenCode resolves the session's project at load time; the destination has
  // never seen the source's project id, so carry a row for it at the new cwd.
  const now = Date.now();
  const project =
    typeof source.project_id === "string" && source.project_id
      ? {
          id: source.project_id,
          worktree: cwd,
          vcs: "git",
          time_created: now,
          time_updated: now,
          sandboxes: "[]",
        }
      : null;
  const messages = rows.slice(1).map((entry) => ({
    id: newOpenCodeId("msg"),
    session_id: sessionId,
    type: entry.role,
    seq: entry.seq,
    time_created: entry.time_created,
    time_updated: entry.time_updated,
    data: entry.data,
  }));
  if (host.kind === "local") {
    if (!existsSync(dbPath))
      throw new ValidationError(
        "OpenCode has not run on the destination host yet; start it once before sending a session",
      );
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA busy_timeout=30000;");
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name);
      if (!tables.includes("session_v2") || !tables.includes("session_message"))
        throw new ValidationError(
          "OpenCode on the destination host is too old for a session handoff; update it and start it once first",
        );
      const columns = (table: string) =>
        db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name);
      const insert = (table: string, row: Record<string, unknown>) => {
        const cols = columns(table).filter((name) => name in row);
        const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
        db.query(sql).run(...cols.map((name) => row[name] as string | number | null));
      };
      db.transaction(() => {
        if (project && tables.includes("project")) {
          const existing = db.query("SELECT id FROM project WHERE id = ?").get(project.id);
          if (!existing) insert("project", project);
        }
        insert("session_v2", session);
        for (const message of messages) insert("session_message", message);
      })();
    } finally {
      db.close();
    }
    return;
  }
  const result = await hostExec(host, ["python3", "-c", REMOTE_INSTALL_SCRIPT], {
    input: JSON.stringify({ dbPath, session, messages, project }),
    timeoutMs: 60_000,
    login: false,
  });
  if (result.code !== 0)
    throw new ConflictError("Could not install the session into the destination OpenCode database");
}
