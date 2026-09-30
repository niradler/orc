import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { gateway_sessions } from "@orc/db/schema";
import { and, eq, ne, notInArray } from "drizzle-orm";
import {
  CLAUDE_REGISTRY_DIR,
  claudeAdapter,
  readRegistryFile,
  registryRecord,
} from "./sessions/claude.js";
import { codexAdapter } from "./sessions/codex.js";
import { LIVE_CHAT_ID, projectIdFor } from "./sessions/common.js";
import { cursorAdapter } from "./sessions/cursor.js";
import type { KnownSession, SessionAdapter, SessionRecord } from "./sessions/types.js";

export { LIVE_CHAT_ID };

const logger = createLogger("api:session-sync");

export type SyncResult = { backend: string; seen: number; ms: number; error?: string };

const defaultAdapters = (): SessionAdapter[] => [claudeAdapter(), codexAdapter(), cursorAdapter()];

let currentAdapters: SessionAdapter[] = defaultAdapters();
const lastRun = new Map<string, number>();
let chain: Promise<unknown> = Promise.resolve();
let tokenChain: Promise<unknown> = Promise.resolve();

const serialized = <T>(job: () => Promise<T>): Promise<T> => {
  const next = chain.then(job, job);
  chain = next.catch(() => {});
  return next;
};

async function upsertRecord(r: SessionRecord): Promise<string> {
  const db = getDb();
  const existing = await db.query.gateway_sessions.findFirst({
    where: and(
      eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
      eq(gateway_sessions.backend, r.backend),
      eq(gateway_sessions.runtime_session_id, r.externalId),
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
    ...(r.transcriptPath !== undefined && { transcript_path: r.transcriptPath }),
    ...(r.tokensUsed !== undefined && { tokens_used: r.tokensUsed }),
  };
  if (existing) {
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
    project_id: await projectIdFor(r.cwd),
    created_at: r.createdAt,
    ...fields,
  });
  return id;
}

async function loadKnown(backend: string): Promise<Map<string, KnownSession>> {
  const rows = await getDb().query.gateway_sessions.findMany({
    where: and(eq(gateway_sessions.chat_id, LIVE_CHAT_ID), eq(gateway_sessions.backend, backend)),
  });
  return new Map(
    rows
      .filter((r) => r.runtime_session_id)
      .map((r) => [
        r.runtime_session_id as string,
        { lastActivityMs: r.last_activity_at?.getTime() ?? 0, tokensUsed: r.tokens_used ?? null },
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
  try {
    const records = await adapter.list(await loadKnown(adapter.backend));
    for (const r of records) {
      const id = await upsertRecord(r);
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
    return results;
  });
}

export const syncNow = () => runSync(currentAdapters, { force: true });

export function tokensSettled(): Promise<unknown> {
  return tokenChain;
}

export function startSessionWatcher(
  opts: { adapters?: SessionAdapter[]; registryDir?: string | null; tickMs?: number } = {},
): () => void {
  currentAdapters = opts.adapters ?? defaultAdapters();
  const registryDir = opts.registryDir === undefined ? CLAUDE_REGISTRY_DIR : opts.registryDir;
  void runSync(currentAdapters, { force: true });
  const timer = setInterval(() => void runSync(currentAdapters), opts.tickMs ?? 30_000);

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: ReturnType<typeof watch> | undefined;
  if (registryDir && existsSync(registryDir)) {
    try {
      watcher = watch(registryDir, (_event, file) => {
        if (!file?.endsWith(".json")) return;
        clearTimeout(pending.get(file));
        pending.set(
          file,
          setTimeout(() => {
            pending.delete(file);
            const path = join(registryDir, file);
            const entry = existsSync(path) ? readRegistryFile(path) : null;
            void serialized(async () => {
              if (entry) return void (await upsertRecord(registryRecord(entry)));
              await getDb()
                .update(gateway_sessions)
                .set({ status: "stopped", updated_at: new Date() })
                .where(
                  and(
                    eq(gateway_sessions.chat_id, LIVE_CHAT_ID),
                    eq(gateway_sessions.backend, "claude"),
                    eq(gateway_sessions.pid, Number.parseInt(file, 10)),
                  ),
                );
            }).catch((err) => logger.error("live registry sync failed", err));
          }, 100),
        );
      });
      watcher.on("error", (err) => logger.error(`watch error on ${registryDir}`, err));
      logger.info(`Watching Claude sessions: ${registryDir}`);
    } catch (err) {
      logger.warn(`Cannot watch ${registryDir}; relying on the periodic sync`, err);
    }
  }

  return () => {
    clearInterval(timer);
    for (const t of pending.values()) clearTimeout(t);
    watcher?.close();
  };
}
