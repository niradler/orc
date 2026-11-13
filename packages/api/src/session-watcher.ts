import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { changes } from "@orc/core/changes";
import { type ExecHost, execHostFor, hostRuntime, resolveExecHost } from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import { LIVE_REGISTRY_DIR } from "@orc/core/live-session";
import { createLogger } from "@orc/core/logger";
import { agentHomes } from "@orc/core/provider-service";
import { USAGE_EVENT_VERSION } from "@orc/core/usage";
import { getDb, getSqlite } from "@orc/db/client";
import { NotificationStore } from "@orc/db/notifications";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq, isNull, ne, notInArray } from "drizzle-orm";
import { recordObservedNotification } from "./notifications.js";
import { watchRemotePaths } from "./realtime/host-watch.js";
import { watchProcessExit } from "./realtime/process-watch.js";
import { watchResourcePath } from "./realtime/sources.js";
import { indexSessionsWhenEnabled } from "./sessions/archive-local.js";
import { CLAUDE_REGISTRY_DIR, claudeAdapter } from "./sessions/claude.js";
import { codexAdapter } from "./sessions/codex.js";
import {
  invalidateProjectFolderCache,
  LIVE_CHAT_ID,
  leavesScope,
  projectIdFor,
  projectScopeFor,
} from "./sessions/common.js";
import { cursorAdapter, cursorStateDbPath } from "./sessions/cursor.js";
import { cursorAgentAdapter } from "./sessions/cursor-agent.js";
import { geminiAdapter } from "./sessions/gemini.js";
import { lifecycleRecords, withLifecycle } from "./sessions/lifecycle.js";
import { opencodeAdapter } from "./sessions/opencode.js";
import { piAdapter, piSessionRoots } from "./sessions/pi.js";
import type { KnownSession, SessionAdapter, SessionRecord } from "./sessions/types.js";
import { maintainUsageRetention, writeSessionUsage } from "./sessions/usage-events.js";
import type { ParsedUsage } from "./sessions/usage-parsers.js";

export { LIVE_CHAT_ID };

const logger = createLogger("api:session-sync");

/** Unmapped folders shell out to git; this caps concurrent probes during a reconcile. */
const MAPPING_CONCURRENCY = 8;

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

const defaultAdapters = (host: ExecHost = resolveExecHost()): SessionAdapter[] => {
  const runtime = hostRuntime(host);
  const localHomes = host.kind === "local";
  const claudeHomes = localHomes ? agentHomes("claude") : [];
  const codexHomes = localHomes ? agentHomes("codex") : [];
  return [
    claudeAdapter(
      localHomes
        ? {
            registry: claudeHomes.map((home) => join(home, "sessions")),
            projects: claudeHomes.map((home) => join(home, "projects")),
          }
        : {},
      runtime,
    ),
    codexAdapter(undefined, {
      runtime,
      ...(localHomes ? { dbPaths: codexHomes.map((home) => join(home, "state_5.sqlite")) } : {}),
    }),
    cursorAdapter({ runtime }),
    cursorAgentAdapter(undefined, runtime),
    geminiAdapter(undefined, runtime),
    opencodeAdapter(undefined, runtime),
    piAdapter(undefined, runtime),
  ].map((adapter) => withLifecycle(adapter, undefined, runtime));
};

let currentAdapters: SessionAdapter[] = defaultAdapters();
let liveRegistryDir: string | null = null;
const lastRun = new Map<string, number>();
let chain: Promise<unknown> = Promise.resolve();
let tokenChain: Promise<unknown> = Promise.resolve();
let usageChain: Promise<unknown> = Promise.resolve();
let nextUsageMaintenance = 0;
let synchronized: (() => Promise<void>) | undefined;
let refreshWatchers: (() => void) | undefined;
const pendingHuman = new Map<string, Set<string>>();

const pendingKey = (backend: string, host: string | null) => JSON.stringify([backend, host]);

export function sessionWaitingForHuman(
  backend: string,
  host: string | null,
  nativeId: string | null,
): boolean {
  return !!nativeId && pendingHuman.get(pendingKey(backend, host))?.has(nativeId) === true;
}

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
  const mappedProject =
    r.cwd !== undefined
      ? await projectIdFor(r.cwd, hostRuntime(execHostFor(executionHost)))
      : undefined;
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
    ...(r.model !== undefined && { model: r.model }),
    ...(r.tokensUsed !== undefined && { tokens_used: r.tokensUsed }),
    ...(existing && mappedProject != null && mappedProject !== existing.project_id
      ? { project_id: mappedProject }
      : {}),
  };
  if (existing) {
    const changed = Object.entries(fields).some(([key, value]) => {
      if (key === "updated_at") return false;
      const previous = existing[key as keyof typeof existing];
      return previous instanceof Date && value instanceof Date
        ? previous.getTime() !== value.getTime()
        : previous !== value;
    });
    if (changed) {
      await db.update(gateway_sessions).set(fields).where(eq(gateway_sessions.id, existing.id));
      // Only reflect the mapping after the session row holds it, so notifications
      // never point at a project the session does not.
      if (fields.project_id)
        new NotificationStore(getSqlite()).assignProject(existing.id, fields.project_id);
    }
    recordObservedNotification(
      {
        id: existing.id,
        backend: r.backend,
        host: executionHost,
        nativeId: r.externalId,
        title: r.title,
        projectId: fields.project_id ?? existing.project_id,
        previous: existing.status,
        status: r.status,
        waiting: r.pendingHuman === true && r.status !== "stopped",
        wasWaiting: sessionWaitingForHuman(r.backend, executionHost, r.externalId),
        activity: r.lastActivityAt.getTime(),
      },
      () =>
        getSqlite()
          .query<{ status: string }, [string]>("SELECT status FROM gateway_sessions WHERE id=?")
          .get(existing.id)?.status === r.status &&
        sessionWaitingForHuman(r.backend, executionHost, r.externalId) ===
          (r.pendingHuman === true && r.status !== "stopped"),
    );
    return existing.id;
  }
  const id = ulid();
  const projectId = mappedProject ?? null;
  await db.insert(gateway_sessions).values({
    id,
    chat_id: LIVE_CHAT_ID,
    backend: r.backend,
    mode: "direct",
    runtime_session_id: r.externalId,
    execution_host: executionHost,
    project_id: projectId,
    created_at: r.createdAt,
    ...fields,
  });
  // A new session with no requests yet still changes the report's coverage counts.
  changes.publish("usage");
  recordObservedNotification(
    {
      id,
      backend: r.backend,
      host: executionHost,
      nativeId: r.externalId,
      title: r.title,
      projectId,
      previous: null,
      status: r.status,
      waiting: r.pendingHuman === true && r.status !== "stopped",
      wasWaiting: false,
      activity: r.lastActivityAt.getTime(),
    },
    () => sessionWaitingForHuman(r.backend, executionHost, r.externalId) === true,
  );
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
          tokensVersion: r.tokens_version,
          usageVersion: r.usage_version,
          session: {
            backend: r.backend,
            externalId: r.runtime_session_id as string,
            title: r.title ?? (r.runtime_session_id as string),
            cwd: r.cwd,
            summary: r.summary,
            status: "stopped" as const,
            createdAt: r.created_at,
            lastActivityAt: r.last_activity_at ?? r.updated_at,
          },
        },
      ]),
  );
}

function queueTokens(id: string, compute: () => Promise<number | null>, version = 0): void {
  tokenChain = tokenChain
    .then(async () => {
      const tokens = await compute();
      if (tokens != null) {
        await getDb()
          .update(gateway_sessions)
          .set({ tokens_used: tokens, tokens_version: version })
          .where(eq(gateway_sessions.id, id));
      }
    })
    .catch((err) => logger.error("token count failed", err));
}

const USAGE_QUEUE_LIMIT = 40;

function queueUsage(
  id: string,
  agent: string,
  compute: () => Promise<ParsedUsage>,
  version = USAGE_EVENT_VERSION,
): void {
  usageChain = usageChain
    .then(async () => {
      const usage = await compute();
      writeSessionUsage(id, agent, usage, version);
    })
    .catch((err) => logger.error("usage index failed", err));
}

async function syncAdapter(adapter: SessionAdapter): Promise<SyncResult> {
  const started = Date.now();
  const executionHost = selectedHostAlias();
  try {
    const records = await adapter.list(await loadKnown(adapter.backend, executionHost));
    const pending = new Set(pendingHuman.get(pendingKey(adapter.backend, executionHost)));
    let pendingChanged = false;
    const usageJobs: {
      id: string;
      activity: number;
      usage: () => Promise<ParsedUsage>;
      version?: number | undefined;
    }[] = [];
    for (const r of records) {
      const id = await upsertRecord(r, executionHost);
      if (r.tokens) queueTokens(id, r.tokens, r.tokensVersion);
      if (r.usage)
        usageJobs.push({
          id,
          activity: r.lastActivityAt.getTime(),
          usage: r.usage,
          version: r.usageVersion,
        });
      if (r.pendingHuman === true && r.status !== "stopped" && !pending.has(r.externalId)) {
        pending.add(r.externalId);
        pendingChanged = true;
      } else if (
        (r.pendingHuman === false || r.status === "stopped") &&
        pending.delete(r.externalId)
      ) {
        pendingChanged = true;
      }
    }
    usageJobs.sort((a, b) => b.activity - a.activity);
    for (const job of usageJobs.slice(0, USAGE_QUEUE_LIMIT))
      queueUsage(job.id, adapter.backend, job.usage, job.version);
    if (usageJobs.length) {
      // One event after the queued ledger writes drain, not one per request.
      const indexPending = usageChain;
      void indexPending.then(() => changes.publish("usage"));
    }
    const seen = records.map((r) => r.externalId);
    for (const id of pending)
      if (!seen.includes(id)) {
        pending.delete(id);
        pendingChanged = true;
      }
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
    pendingHuman.set(pendingKey(adapter.backend, executionHost), pending);
    if (pendingChanged) changes.publish("sessions");
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
      const synced = new Set(
        results.filter((result) => !result.error).map((result) => result.backend),
      );
      for (const record of await lifecycleRecords(
        liveRegistryDir,
        hostRuntime(resolveExecHost()),
      )) {
        if (synced.has(record.backend)) continue;
        await upsertRecord(record, selectedHostAlias());
      }
    }
    await synchronized?.();
    indexSessionsWhenEnabled();
    // Housekeeping on the same event-driven sync path, not a separate timer.
    if (Date.now() >= nextUsageMaintenance) {
      nextUsageMaintenance = Date.now() + 6 * 60 * 60 * 1000;
      try {
        maintainUsageRetention();
      } catch (error) {
        logger.error("Usage retention failed", error);
      }
    }
    return results;
  });
}

export const syncNow = () => runSync(currentAdapters, { force: true });

/**
 * Re-run folder mapping for every known session. Project folders can be added or
 * changed after a session was first seen, and worktrees resolve to a checkout root
 * that no earlier sync may have known. An assignment that its project's explicit
 * scope no longer justifies is dropped, so moving a scope does not leave sessions
 * and notifications behind in the old project.
 */
export function reconcileSessionProjects(): Promise<number> {
  return serialized(async () => {
    invalidateProjectFolderCache();
    const db = getDb();
    const localSessions = await db.query.gateway_sessions.findMany({
      where: eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
    });
    const rows = localSessions.filter((row) => row.cwd);
    const mapped: (string | null)[] = [];
    // Each miss shells out to git; a handful at a time keeps a cold reconcile short
    // without spawning one process per session at once.
    for (let index = 0; index < rows.length; index += MAPPING_CONCURRENCY) {
      const batch = rows.slice(index, index + MAPPING_CONCURRENCY);
      mapped.push(
        ...(await Promise.all(
          batch.map((row) =>
            projectIdFor(row.cwd as string, hostRuntime(execHostFor(row.execution_host ?? null))),
          ),
        )),
      );
    }
    const notifications = new NotificationStore(getSqlite());
    let changed = 0;
    let notificationsChanged = 0;
    for (const [index, row] of rows.entries()) {
      const projectId = mapped[index] ?? null;
      if (projectId === null) {
        const local = !row.execution_host || row.execution_host === "local";
        if (!row.project_id || !local) continue;
        const scope = await projectScopeFor(row.project_id);
        if (scope !== undefined && (!scope || !leavesScope(row.cwd as string, scope))) continue;
        await db
          .update(gateway_sessions)
          .set({ project_id: null, updated_at: new Date() })
          .where(eq(gateway_sessions.id, row.id));
        notificationsChanged += notifications.assignProject(row.id, null);
        changed++;
        continue;
      }
      if (projectId !== row.project_id) {
        await db
          .update(gateway_sessions)
          .set({ project_id: projectId, updated_at: new Date() })
          .where(eq(gateway_sessions.id, row.id));
        changed++;
      }
      notificationsChanged += notifications.assignProject(row.id, projectId);
    }
    if (changed) changes.publish("sessions");
    if (notificationsChanged) changes.publish("notifications");
    return changed;
  });
}

export function discoverJobSession(
  backend: string,
  nativeId: string,
  host: string | null,
): Promise<string | null> {
  return serialized(async () => {
    const nativeBackend =
      backend === "codex-cli" ? "codex" : backend === "claude-cli" ? "claude" : backend;
    const adapter = defaultAdapters(execHostFor(host)).find(
      (entry) => entry.backend === nativeBackend,
    );
    if (!adapter) return null;
    const record = (await adapter.list(new Map())).find((entry) => entry.externalId === nativeId);
    return record ? upsertRecord(record, host) : null;
  });
}

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
  let watcherGeneration = 0;
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
      void liveState()
        .then(async (before) => {
          await runSync(currentAdapters, { force: true });
          if (notify || before !== (await liveState())) changes.publish("sessions");
        })
        .catch((error) => logger.error("Session change sync failed", error))
        .finally(() => {
          syncing = false;
          if (requested) schedule();
        });
    }, 100);
    debounce.unref();
  };
  const liveState = async () =>
    (
      await getDb()
        .select({
          id: gateway_sessions.id,
          status: gateway_sessions.status,
          pid: gateway_sessions.pid,
          updated: gateway_sessions.updated_at,
        })
        .from(gateway_sessions)
        .where(
          and(eq(gateway_sessions.chat_id, LIVE_CHAT_ID), ne(gateway_sessions.status, "stopped")),
        )
    )
      .map((row) => `${row.id}:${row.status}:${row.pid}:${row.updated?.getTime()}`)
      .sort()
      .join("|");
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
      } else if (!row.pid && row.backend === "codex") {
        // Advisory locks can be released on process exit without changing any watched file.
        nextExpiration = Math.min(nextExpiration, Date.now() + 30_000);
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
    const generation = ++watcherGeneration;
    watchedHost = selectedHostAlias();
    for (const stop of fileWatchers.splice(0)) stop();
    const local = new Set<string>();
    if (liveRegistryDir) local.add(liveRegistryDir);
    if (registryDir) local.add(registryDir);
    if (!opts.adapters) {
      const host = resolveExecHost();
      void piSessionRoots(hostRuntime(host))
        .then((paths) => {
          if (stopped || generation !== watcherGeneration) return;
          if (host.kind === "ssh")
            fileWatchers.push(watchRemotePaths(host, paths, () => schedule(true)));
          else
            for (const path of paths)
              fileWatchers.push(watchResourcePath(path, () => schedule(true)));
        })
        .catch((error) => logger.warn("Cannot watch Pi session directories", { error }));
      const sources = [
        ".claude/sessions",
        ".claude/projects",
        "Library/Application Support/Claude/claude-code-sessions",
        ".codex/sessions",
        ".codex/state_5.sqlite",
        ".codex/state_5.sqlite-wal",
        ".codex/thread_history_1.sqlite",
        ".codex/thread_history_1.sqlite-wal",
        ".codex/thread-writer-locks",
        ".cursor/projects",
        ".cursor/chats",
        ".gemini/tmp",
        ".local/share/opencode/opencode.db",
        ".local/share/opencode/opencode.db-wal",
        ".local/share/opencode/opencode.db-shm",
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
        for (const home of agentHomes("claude")) {
          local.add(join(home, "sessions"));
          local.add(join(home, "projects"));
        }
        for (const home of agentHomes("codex"))
          for (const entry of [
            "sessions",
            "state_5.sqlite",
            "state_5.sqlite-wal",
            "thread_history_1.sqlite",
            "thread_history_1.sqlite-wal",
            "thread-writer-locks",
          ])
            local.add(join(home, entry));
        local.add(cursorStateDbPath());
        local.add(`${cursorStateDbPath()}-wal`);
      }
    }
    for (const path of local) fileWatchers.push(watchResourcePath(path, () => schedule(true)));
    schedule();
  };
  refreshWatchers = attach;
  const unsubscribe = changes.subscribe(({ resources }) => {
    if (
      (!opts.adapters && resources.includes("settings")) ||
      (resources.includes("ssh") && watchedHost !== selectedHostAlias())
    )
      refreshConfiguredSessionAdapters();
  });
  attach();
  return () => {
    stopped = true;
    pendingHuman.clear();
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
