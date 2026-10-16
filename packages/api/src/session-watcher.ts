import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { changes } from "@orc/core/changes";
import { execHostFor, hostRuntime, resolveExecHost } from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { LIVE_REGISTRY_DIR } from "@orc/core/live-session";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq, isNull, ne, notInArray } from "drizzle-orm";
import { watchRemotePaths } from "./realtime/host-watch.js";
import { watchProcessExit } from "./realtime/process-watch.js";
import { watchResourcePath } from "./realtime/sources.js";
import { CLAUDE_REGISTRY_DIR, claudeAdapter } from "./sessions/claude.js";
import { codexAdapter } from "./sessions/codex.js";
import { LIVE_CHAT_ID, projectIdFor } from "./sessions/common.js";
import { cursorAdapter, cursorStateDbPath } from "./sessions/cursor.js";
import { cursorAgentAdapter } from "./sessions/cursor-agent.js";
import { geminiAdapter } from "./sessions/gemini.js";
import { lifecycleRecords, withLifecycle } from "./sessions/lifecycle.js";
import type { KnownSession, SessionAdapter, SessionRecord } from "./sessions/types.js";

export { LIVE_CHAT_ID };

const logger = createLogger("api:session-sync");

const selectedHostAlias = (): string | null => {
  const host = resolveExecHost();
  return host.kind === "ssh" ? host.alias : null;
};

export type SyncResult = {
  backend: string;
  seen: number;
  ms: number;
  error?: string;
};

const defaultAdapters = (): SessionAdapter[] => {
  const runtime = hostRuntime(resolveExecHost());
  return [
    claudeAdapter({}, runtime),
    codexAdapter(undefined, { runtime }),
    cursorAdapter({ runtime }),
    cursorAgentAdapter(undefined, runtime),
    geminiAdapter(undefined, runtime),
  ].map((adapter) => withLifecycle(adapter, undefined, runtime));
};

let currentAdapters: SessionAdapter[] = defaultAdapters();
let liveRegistryDir: string | null = null;
const lastRun = new Map<string, number>();
let chain: Promise<unknown> = Promise.resolve();
let tokenChain: Promise<unknown> = Promise.resolve();
let synchronized: (() => Promise<void>) | undefined;
let refreshWatchers: (() => void) | undefined;

const serialized = <T>(job: () => Promise<T>): Promise<T> => {
  const next = chain.then(job, job);
  chain = next.catch(() => {});
  return next;
};

const hostCondition = (alias: string | null) =>
  alias ? eq(gateway_sessions.execution_host, alias) : isNull(gateway_sessions.execution_host);

async function upsertRecord(r: SessionRecord, executionHost: string | null): Promise<string> {
  const db = getDb();
  const existing = await db.query.gateway_sessions.findFirst({
    where: and(
      eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      eq(gateway_sessions.backend, r.backend),
      eq(gateway_sessions.runtime_session_id, r.externalId),
      hostCondition(executionHost),
    ),
  });
  const fields = {
    title: r.title,
    status: r.status,
    last_activity_at: r.lastActivityAt,
    updated_at: new Date(),
    ...(r.cwd !== undefined && { cwd: r.cwd }),
    ...(r.summary !== undefined && { summary: r.summary }),
    ...(r.pid !== undefined && { pid: r.pid }),
    ...(r.transcriptPath !== undefined && {
      transcript_path: r.transcriptPath,
    }),
    ...(r.tokensUsed !== undefined && { tokens_used: r.tokensUsed }),
  };
  if (existing) {
    const changed = Object.entries(fields).some(([key, value]) => {
      if (key === "updated_at") return false;
      const previous = existing[key as keyof typeof existing];
      return previous instanceof Date && value instanceof Date
        ? previous.getTime() !== value.getTime()
        : previous !== value;
    });
    if (changed)
      await db.update(gateway_sessions).set(fields).where(eq(gateway_sessions.id, existing.id));
    return existing.id;
  }
  const id = ulid();
  await db.insert(gateway_sessions).values({
    id,
    chat_id: LIVE_CHAT_ID,
    backend: r.backend,
    mode: "direct",
    runtime_session_id: r.externalId,
    execution_host: executionHost,
    project_id: await projectIdFor(r.cwd, hostRuntime(resolveExecHost())),
    created_at: r.createdAt,
    ...fields,
  });
  return id;
}

async function loadKnown(
  backend: string,
  executionHost: string | null,
): Promise<Map<string, KnownSession>> {
  const rows = await getDb().query.gateway_sessions.findMany({
    where: and(
      eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      eq(gateway_sessions.backend, backend),
      hostCondition(executionHost),
    ),
  });
  return new Map(
    rows
      .filter((r) => r.runtime_session_id)
      .map((r) => [
        r.runtime_session_id as string,
        {
          lastActivityMs: r.last_activity_at?.getTime() ?? 0,
          tokensUsed: r.tokens_used ?? null,
        },
      ]),
  );
}

function queueTokens(id: string, compute: () => Promise<number | null>): void {
  tokenChain = tokenChain
    .then(async () => {
      const tokens = await compute();
      if (tokens != null) {
        await getDb()
          .update(gateway_sessions)
          .set({ tokens_used: tokens })
          .where(eq(gateway_sessions.id, id));
      }
    })
    .catch((err) => logger.error("token count failed", err));
}

async function syncAdapter(adapter: SessionAdapter): Promise<SyncResult> {
  const started = Date.now();
  const executionHost = selectedHostAlias();
  try {
    const records = await adapter.list(await loadKnown(adapter.backend, executionHost));
    for (const r of records) {
      const id = await upsertRecord(r, executionHost);
      if (r.tokens) queueTokens(id, r.tokens);
    }
    const seen = records.map((r) => r.externalId);
    await getDb()
      .update(gateway_sessions)
      .set({ status: "stopped", updated_at: new Date() })
      .where(
        and(
          eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
          eq(gateway_sessions.backend, adapter.backend),
          hostCondition(executionHost),
          ne(gateway_sessions.status, "stopped"),
          seen.length > 0 ? notInArray(gateway_sessions.runtime_session_id, seen) : undefined,
        ),
      );
    return { backend: adapter.backend, seen: records.length, ms: Date.now() - started };
  } catch (err) {
    logger.error(`sync failed for ${adapter.backend}`, err);
    return {
      backend: adapter.backend,
      seen: 0,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    lastRun.set(adapter.backend, Date.now());
  }
}

export function runSync(
  adapters: SessionAdapter[] = currentAdapters,
  opts: { force?: boolean } = {},
): Promise<SyncResult[]> {
  return serialized(async () => {
    const results: SyncResult[] = [];
    for (const adapter of adapters) {
      const due = Date.now() - (lastRun.get(adapter.backend) ?? 0) >= adapter.minIntervalMs;
      if (opts.force || due) results.push(await syncAdapter(adapter));
    }
    if (liveRegistryDir) {
      for (const record of await lifecycleRecords(liveRegistryDir, hostRuntime(resolveExecHost())))
        await upsertRecord(record, selectedHostAlias());
    }
    await synchronized?.();
    return results;
  });
}

export const syncNow = () => runSync(currentAdapters, { force: true });

export function refreshConfiguredSessionAdapters(): void {
  currentAdapters = defaultAdapters();
  lastRun.clear();
  refreshWatchers?.();
}

export function tokensSettled(): Promise<unknown> {
  return tokenChain;
}

export function startSessionWatcher(
  opts: {
    adapters?: SessionAdapter[];
    registryDir?: string | null;
    liveRegistryDir?: string | null;
  } = {},
): () => void {
  currentAdapters = opts.adapters ?? defaultAdapters();
  liveRegistryDir =
    opts.liveRegistryDir === undefined
      ? opts.adapters
        ? null
        : LIVE_REGISTRY_DIR
      : opts.liveRegistryDir;
  if (liveRegistryDir) mkdirSync(liveRegistryDir, { recursive: true });
  const registryDir =
    opts.registryDir === undefined
      ? opts.adapters || resolveExecHost().kind === "ssh"
        ? null
        : CLAUDE_REGISTRY_DIR
      : opts.registryDir;
  let stopped = false;
  let requested = false;
  let changedFiles = false;
  let syncing = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let expiration: ReturnType<typeof setTimeout> | undefined;
  let watchedHost = selectedHostAlias();
  const fileWatchers: (() => void)[] = [];
  const processes = new Map<string, () => void>();
  const schedule = (fileChanged = false): void => {
    if (stopped) return;
    changedFiles ||= fileChanged;
    requested = true;
    if (debounce || syncing) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      requested = false;
      const notify = changedFiles;
      changedFiles = false;
      syncing = true;
      void runSync(currentAdapters, { force: true })
        .then(() => {
          if (notify) changes.publish("sessions");
        })
        .catch((error) => logger.error("Session change sync failed", error))
        .finally(() => {
          syncing = false;
          if (requested) schedule();
        });
    }, 100);
    debounce.unref();
  };
  synchronized = async () => {
    if (stopped || opts.adapters) return;
    const rows = await getDb().query.gateway_sessions.findMany({
      where: and(
        eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
        ne(gateway_sessions.status, "stopped"),
      ),
    });
    const keys = new Set<string>();
    let nextExpiration = Number.POSITIVE_INFINITY;
    for (const row of rows) {
      if (row.pid && (row.pid !== process.pid || row.execution_host !== null)) {
        const key = `${row.execution_host ?? "local"}:${row.pid}`;
        keys.add(key);
        if (!processes.has(key))
          processes.set(
            key,
            watchProcessExit(execHostFor(row.execution_host), row.pid, () => {
              processes.delete(key);
              schedule();
            }),
          );
      } else if (!row.pid && row.status === "running" && row.last_activity_at) {
        const expires = row.last_activity_at.getTime() + 30_050;
        if (expires > Date.now()) nextExpiration = Math.min(nextExpiration, expires);
      }
    }
    for (const [key, stop] of processes)
      if (!keys.has(key)) {
        stop();
        processes.delete(key);
      }
    clearTimeout(expiration);
    if (Number.isFinite(nextExpiration)) {
      expiration = setTimeout(schedule, Math.max(1, nextExpiration - Date.now()));
      expiration.unref();
    }
  };
  const attach = (): void => {
    watchedHost = selectedHostAlias();
    for (const stop of fileWatchers.splice(0)) stop();
    const local = new Set<string>();
    if (liveRegistryDir) local.add(liveRegistryDir);
    if (registryDir) local.add(registryDir);
    if (!opts.adapters) {
      const host = resolveExecHost();
      const sources = [
        ".claude/sessions",
        ".claude/projects",
        "Library/Application Support/Claude/claude-code-sessions",
        ".codex/sessions",
        ".codex/state_5.sqlite",
        ".codex/state_5.sqlite-wal",
        ".cursor/projects",
        ".cursor/chats",
        ".gemini/tmp",
      ];
      if (host.kind === "ssh")
        fileWatchers.push(
          watchRemotePaths(
            host,
            sources.map((path) => `~/${path}`),
            () => schedule(true),
          ),
        );
      else {
        for (const source of sources) local.add(join(homedir(), source));
        local.add(cursorStateDbPath());
        local.add(`${cursorStateDbPath()}-wal`);
      }
    }
    for (const path of local) fileWatchers.push(watchResourcePath(path, () => schedule(true)));
    schedule();
  };
  refreshWatchers = attach;
  const unsubscribe = changes.subscribe(({ resources }) => {
    if (resources.includes("ssh") && watchedHost !== selectedHostAlias())
      refreshConfiguredSessionAdapters();
  });
  attach();
  return () => {
    stopped = true;
    unsubscribe();
    clearTimeout(debounce);
    clearTimeout(expiration);
    for (const stop of fileWatchers) stop();
    for (const stop of processes.values()) stop();
    synchronized = undefined;
    refreshWatchers = undefined;
    liveRegistryDir = null;
  };
}
