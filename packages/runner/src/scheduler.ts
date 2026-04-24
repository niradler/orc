import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb, getSqlite } from "@orc/db/client";
import { comments, job_runs, jobs } from "@orc/db/schema";
import { Cron } from "croner";
import { desc, eq } from "drizzle-orm";
import { executeJob } from "./executor.js";

const logger = createLogger("runner:scheduler");

const activeCrons = new Map<string, Cron>();
const activeTimers = new Map<string, Timer>();
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

const CIRCUIT_BREAKER_THRESHOLD = 3;
const HISTORY_RETENTION_DAYS = 7;

export async function startScheduler(): Promise<void> {
  const db = getDb();
  const allJobs = await db.query.jobs.findMany({
    where: eq(jobs.enabled, true),
  });

  const knownTriggers = new Set(["cron", "one-shot", "watch", "webhook", "manual", "bridge-msg"]);
  const orphaned = allJobs.filter((j) => !knownTriggers.has(j.trigger_type));
  if (orphaned.length > 0) {
    logger.warn(
      `${orphaned.length} job(s) have an unsupported trigger type and will not fire: ${orphaned.map((j) => `${j.name} (${j.trigger_type})`).join(", ")}. ` +
        `Use 'cron' with a 6-field expression (e.g. '*/30 * * * * *') for sub-minute intervals.`,
    );
  }

  for (const job of allJobs) {
    // Internal commands are managed by their own mechanisms (e.g. task loop), not the scheduler.
    if (job.command.startsWith("__internal:")) continue;
    if (job.trigger_type === "cron" && job.cron_expr) {
      scheduleCronJob(job.id, job.name, job.cron_expr);
    } else if (job.trigger_type === "one-shot" && job.run_at) {
      scheduleOneShotJob(job.id, job.name, job.run_at, job.run_count);
    }
  }

  logger.info(
    `Scheduler started. ${activeCrons.size} cron + ${activeTimers.size} one-shot jobs scheduled.`,
  );

  pruneHistory();
  cleanupInterval = setInterval(() => pruneHistory(), 24 * 60 * 60 * 1000);
}

function pruneHistory(): void {
  try {
    const sqlite = getSqlite();
    const cutoffTs = Math.floor((Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000);

    // Delete runner sessions first — they hold a FK ref to job_runs.
    sqlite.query("DELETE FROM sessions WHERE agent = 'runner' AND created_at < ?").run(cutoffTs);

    // Nullify FK refs in other tables before deleting the runs themselves.
    sqlite
      .query(
        "UPDATE bridge_messages SET job_run_id = NULL WHERE job_run_id IN (SELECT id FROM job_runs WHERE created_at < ?)",
      )
      .run(cutoffTs);
    sqlite
      .query(
        "UPDATE bridge_permissions SET job_run_id = NULL WHERE job_run_id IN (SELECT id FROM job_runs WHERE created_at < ?)",
      )
      .run(cutoffTs);

    // Deleting job_runs cascades to job_run_logs.
    const result = sqlite.query("DELETE FROM job_runs WHERE created_at < ?").run(cutoffTs);
    if (result.changes > 0) {
      logger.info(`Pruned ${result.changes} job runs older than ${HISTORY_RETENTION_DAYS} days`);
    }
  } catch (err) {
    logger.warn("Failed to prune job history", err);
  }
}

async function checkCircuitBreaker(jobId: string, name: string): Promise<void> {
  const db = getDb();
  const recent = await db
    .select({ status: job_runs.status })
    .from(job_runs)
    .where(eq(job_runs.job_id, jobId))
    .orderBy(desc(job_runs.created_at))
    .limit(CIRCUIT_BREAKER_THRESHOLD);

  if (recent.length < CIRCUIT_BREAKER_THRESHOLD) return;
  if (!recent.every((r) => r.status === "failed")) return;

  await db.update(jobs).set({ enabled: false, updated_at: new Date() }).where(eq(jobs.id, jobId));
  await db.insert(comments).values({
    id: ulid(),
    resource_type: "job",
    resource_id: jobId,
    content: `Auto-disabled after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures. Fix the error and re-enable to resume.`,
    author: "system",
    created_at: new Date(),
  });
  unscheduleJob(jobId);
  logger.warn(
    `Job "${name}" auto-disabled after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
  );
}

export function scheduleCronJob(jobId: string, name: string, expr: string): void {
  if (activeCrons.has(jobId)) {
    activeCrons.get(jobId)?.stop();
  }

  const cron = new Cron(expr, async () => {
    const db = getDb();
    const still = await db.query.jobs.findFirst({
      where: eq(jobs.id, jobId),
      columns: { id: true },
    });
    if (!still) {
      logger.warn(`Cron job ${name} no longer exists, unscheduling`);
      unscheduleJob(jobId);
      return;
    }
    logger.info(`Cron trigger: ${name}`);
    try {
      await executeJob({ jobId, triggerBy: "cron" });
    } catch (err) {
      logger.error(`Cron job failed: ${name}`, err);
    }
    await checkCircuitBreaker(jobId, name).catch((err) =>
      logger.warn(`Circuit breaker check failed for ${name}`, err),
    );
  });

  activeCrons.set(jobId, cron);
  logger.info(`Scheduled cron job: ${name} (${expr})`);
}

export function scheduleOneShotJob(
  jobId: string,
  name: string,
  runAt: Date,
  runCount: number,
): void {
  if (runCount > 0) return;

  if (activeTimers.has(jobId)) {
    clearTimeout(activeTimers.get(jobId));
    activeTimers.delete(jobId);
  }

  const delayMs = Math.max(0, runAt.getTime() - Date.now());

  const timer = setTimeout(async () => {
    activeTimers.delete(jobId);
    const db = getDb();
    const still = await db.query.jobs.findFirst({
      where: eq(jobs.id, jobId),
      columns: { id: true },
    });
    if (!still) {
      logger.warn(`One-shot job ${name} no longer exists, skipping`);
      return;
    }
    logger.info(`One-shot trigger: ${name}`);
    try {
      await executeJob({ jobId, triggerBy: "one-shot" });
    } catch (err) {
      logger.error(`One-shot job failed: ${name}`, err);
    }
  }, delayMs);

  activeTimers.set(jobId, timer);
  const fireIn = delayMs < 1000 ? "now" : `in ${Math.round(delayMs / 1000)}s`;
  logger.info(`Scheduled one-shot job: ${name} (${fireIn})`);
}

export function unscheduleJob(jobId: string): void {
  const cron = activeCrons.get(jobId);
  if (cron) {
    cron.stop();
    activeCrons.delete(jobId);
  }
  const timer = activeTimers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(jobId);
  }
}

export function stopScheduler(): void {
  for (const [, cron] of activeCrons) cron.stop();
  activeCrons.clear();
  for (const [, timer] of activeTimers) clearTimeout(timer);
  activeTimers.clear();
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  logger.info("Scheduler stopped.");
}
