import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { jobs } from "@orc/db/schema";
import chokidar from "chokidar";
import { eq } from "drizzle-orm";
import { executeJob } from "./executor.js";

const logger = createLogger("runner:watcher");
const activeWatchers = new Map<string, ReturnType<typeof chokidar.watch>>();

export async function startWatchers(): Promise<void> {
  const db = getDb();
  const watchJobs = await db.query.jobs.findMany({ where: eq(jobs.enabled, true) });

  for (const job of watchJobs) {
    if (job.trigger_type === "watch" && job.watch_path) {
      startWatcher(job.id, job.name, job.watch_path);
    }
  }

  logger.info(`Watchers started. ${activeWatchers.size} paths watched.`);
}

export function startWatcher(jobId: string, name: string, watchPath: string): void {
  if (activeWatchers.has(jobId)) {
    activeWatchers
      .get(jobId)
      ?.close()
      .catch(() => {});
  }

  const watcher = chokidar.watch(watchPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on("add", (path) => triggerWatch(jobId, name, path));
  watcher.on("change", (path) => triggerWatch(jobId, name, path));
  // An unhandled 'error' event on the watcher (permission denied, path removed,
  // inotify limits) would otherwise crash the process.
  watcher.on("error", (err) => logger.error(`Watcher error for ${name} (${watchPath})`, err));

  activeWatchers.set(jobId, watcher);
  logger.info(`Watching: ${watchPath} → ${name}`);
}

async function triggerWatch(jobId: string, name: string, path: string): Promise<void> {
  logger.info(`Watch trigger: ${name} (${path})`);
  try {
    await executeJob({ jobId, triggerBy: "watch", envOverrides: { WATCH_PATH: path } });
  } catch (err) {
    logger.error(`Watch job failed: ${name}`, err);
  }
}

export async function stopWatchers(): Promise<void> {
  for (const [, watcher] of activeWatchers) await watcher.close();
  activeWatchers.clear();
  logger.info("Watchers stopped.");
}
