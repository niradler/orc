import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { displayPath, pathLabel } from "@orc/core/display-path";
import { type HostFileInfo, type HostRuntime, hostRuntime, LOCAL_HOST } from "@orc/core/exec-host";
import { createLogger } from "@orc/core/logger";
import { USAGE_EVENT_VERSION } from "@orc/core/usage";
import { readCodexQuestionPending } from "./codex-attention.js";
import { activityAdvanced, oneLine, promptText, statusFromMtime } from "./common.js";
import { hasWriter, remoteWriters } from "./ownership.js";
import type { SessionAdapter, SessionRecord } from "./types.js";
import { lifetimeUsage, parseCodexUsage } from "./usage-parsers.js";

export const CODEX_STATE_DB = join(homedir(), ".codex", "state_5.sqlite");
const logger = createLogger("api:codex-attention");

/** Rollouts above this cap cannot be read whole; they keep an estimated lifetime total. */
const CODEX_ROLLOUT_READ_LIMIT = 32 * 1024 * 1024;

/** Codex rotates closed rollouts in place as `<rollout>.jsonl.zst`. */
const ROTATED_ROLLOUT_SUFFIX = ".zst";

type Rollout = {
  /** Path that can be read now; rotated rollouts end in `.zst`. */
  path: string;
  info: HostFileInfo;
  compressed: boolean;
};

/**
 * Finds the rollout Codex still keeps. Rotation replaces the JSONL file, so a
 * missing plain path is not a missing transcript.
 */
async function findRollout(runtime: HostRuntime, path: string): Promise<Rollout | null> {
  const plain = await runtime.stat(path);
  if (plain) return { path, info: plain, compressed: false };
  const rotated = `${path}${ROTATED_ROLLOUT_SUFFIX}`;
  const compressed = await runtime.stat(rotated);
  return compressed ? { path: rotated, info: compressed, compressed: true } : null;
}

/** Decompresses a rotated rollout, or null when its text exceeds the read cap. */
function decodeRollout(bytes: Uint8Array, compressed: boolean): string | null {
  if (!compressed) return new TextDecoder().decode(bytes);
  try {
    return new TextDecoder().decode(
      zstdDecompressSync(bytes, { maxOutputLength: CODEX_ROLLOUT_READ_LIMIT }),
    );
  } catch {
    return null;
  }
}

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
  source: string | null;
};

function codexParent(source: string | null): string | null {
  if (!source?.startsWith("{")) return null;
  try {
    const parent = JSON.parse(source)?.subagent?.thread_spawn?.parent_thread_id;
    return typeof parent === "string" && parent ? parent : null;
  } catch {
    return null;
  }
}

export function codexAdapter(
  dbPath = CODEX_STATE_DB,
  options: {
    writer?: (path: string) => boolean;
    historyDb?: string;
    dbPaths?: string[];
    runtime?: HostRuntime;
  } = {},
): SessionAdapter {
  const runtime = options.runtime ?? hostRuntime(LOCAL_HOST);
  return {
    backend: "codex",
    minIntervalMs: 5_000,
    async list(known) {
      const joinHost = runtime.host.kind === "ssh" ? posix.join : join;
      const databases = options.dbPaths?.length ? options.dbPaths : [dbPath];
      const listDatabase = async (database: string): Promise<SessionRecord[]> => {
        const home =
          database === CODEX_STATE_DB
            ? joinHost(await runtime.home(), ".codex")
            : runtime.host.kind === "ssh"
              ? posix.dirname(database)
              : dirname(database);
        const stateDb = database === CODEX_STATE_DB ? joinHost(home, "state_5.sqlite") : database;
        if (!(await runtime.isFile(stateDb))) return [];
        let statuses = new Map<string, string>();
        try {
          statuses = new Map(
            (
              await runtime.sqliteQuery<{ thread_id: string; status: string }>(
                options.historyDb ?? joinHost(home, "thread_history_1.sqlite"),
                `SELECT thread_id, status FROM (
                   SELECT thread_id, status, ROW_NUMBER() OVER
                     (PARTITION BY thread_id ORDER BY rollout_ordinal DESC) AS rank
                   FROM thread_turns
                 ) WHERE rank = 1`,
              )
            ).map((row) => [row.thread_id, row.status]),
          );
        } catch {}
        const columns = `id, title, name, cwd, preview, first_user_message, tokens_used, rollout_path,
                  created_at_ms, created_at, updated_at_ms, updated_at`;
        const rows = await runtime
          .sqliteQuery<ThreadRow>(
            stateDb,
            `SELECT ${columns}, source FROM threads WHERE archived = 0`,
          )
          .catch(() =>
            runtime.sqliteQuery<ThreadRow>(
              stateDb,
              `SELECT ${columns}, NULL AS source FROM threads WHERE archived = 0`,
            ),
          );
        const lockDirectory = joinHost(home, "thread-writer-locks");
        const hasLockDirectory = await runtime.isDirectory(lockDirectory);
        const remoteOwnership =
          runtime.host.kind === "ssh" && hasLockDirectory
            ? await remoteWriters(
                runtime,
                lockDirectory,
                rows.map((row) => row.id),
              )
            : undefined;
        return Promise.all(
          rows.map(async (r): Promise<SessionRecord> => {
            const updated = r.updated_at_ms ?? r.updated_at * 1000;
            const rollout = await findRollout(runtime, r.rollout_path);
            const live = rollout?.info.mtimeMs ?? null;
            const owned =
              runtime.host.kind === "local"
                ? (options.writer ?? hasWriter)(join(lockDirectory, `${r.id}.lock`))
                : (remoteOwnership?.get(r.id) ?? false);
            const turn = statuses.get(r.id);
            const status = owned
              ? turn === "inProgress"
                ? "running"
                : "idle"
              : hasLockDirectory
                ? "stopped"
                : live
                  ? statusFromMtime(live)
                  : "stopped";
            let pendingHuman: boolean | undefined;
            if (status === "stopped") pendingHuman = false;
            else if (rollout)
              try {
                pendingHuman = await readCodexQuestionPending(runtime, rollout.path);
              } catch (error) {
                logger.warn("Cannot inspect Codex session for a pending question", { error });
              }
            const lastActivityAt = new Date(Math.max(updated, live ?? 0));
            const before = known.get(r.id);
            const record: SessionRecord = {
              backend: "codex",
              externalId: r.id,
              ...(codexParent(r.source) ? { parentId: codexParent(r.source) } : {}),
              title: oneLine(
                promptText(r.name) ||
                  (displayPath(r.title) !== displayPath(r.cwd) ? promptText(r.title) : "") ||
                  promptText(r.first_user_message) ||
                  pathLabel(r.cwd) ||
                  "Codex session",
                120,
              ),
              summary:
                oneLine(promptText(r.preview) || promptText(r.first_user_message), 400) || null,
              cwd: r.cwd,
              status,
              ...(pendingHuman !== undefined ? { pendingHuman } : {}),
              ...(pendingHuman
                ? { waitingFor: { reason: "question" as const, tool: "request_user_input" } }
                : {}),
              createdAt: new Date(r.created_at_ms ?? r.created_at * 1000),
              lastActivityAt,
              transcriptPath:
                r.source?.startsWith('{"subagent"') && !codexParent(r.source)
                  ? null
                  : (rollout?.path ?? null),
              tokensUsed: r.tokens_used > 0 ? r.tokens_used : null,
            };
            const expected = r.tokens_used > 0 ? r.tokens_used : null;
            if (
              rollout &&
              (!before ||
                activityAdvanced(lastActivityAt, before.lastActivityMs) ||
                before?.usageVersion !== USAGE_EVENT_VERSION)
            ) {
              record.usage = async () => {
                // An oversized or unreadable rollout cannot be read whole. Keep the
                // lifetime total as a single estimated request instead of throwing
                // (and re-throwing every sync), so the session still reports usage
                // and is not left permanently unindexed.
                if (rollout.info.size > CODEX_ROLLOUT_READ_LIMIT) {
                  return lifetimeUsage(expected ?? 0, lastActivityAt.getTime());
                }
                const content = decodeRollout(
                  await runtime.readFile(rollout.path, CODEX_ROLLOUT_READ_LIMIT),
                  rollout.compressed,
                );
                if (content === null) return lifetimeUsage(expected ?? 0, lastActivityAt.getTime());
                return parseCodexUsage(content, expected, lastActivityAt.getTime());
              };
              record.usageVersion = USAGE_EVENT_VERSION;
            } else if (before?.usageVersion !== USAGE_EVENT_VERSION) {
              // Codex no longer keeps this rollout at all; the lifetime total is the only
              // usage left. Settle it once so Coverage stops reporting it as pending.
              record.usage = async () => lifetimeUsage(expected ?? 0, lastActivityAt.getTime());
              record.usageVersion = USAGE_EVENT_VERSION;
            }
            return record;
          }),
        );
      };
      const records: SessionRecord[] = [];
      const seen = new Set<string>();
      let failures = 0;
      let lastError: unknown;
      for (const database of databases) {
        // One unreadable account database must not hide the healthy homes.
        let rows: SessionRecord[];
        try {
          rows = await listDatabase(database);
        } catch (error) {
          failures += 1;
          lastError = error;
          logger.warn("Cannot read a Codex account database", { database, error });
          continue;
        }
        for (const record of rows) {
          // Copied account directories can repeat a thread id; the first home wins.
          if (seen.has(record.externalId)) continue;
          seen.add(record.externalId);
          records.push(record);
        }
      }
      // A total outage stays an error so the watcher keeps the last known sessions.
      if (failures === databases.length) throw lastError;
      return records;
    },
  };
}
