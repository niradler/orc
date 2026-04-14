import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { jobs } from "@orc/db/schema";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { executeJob } from "./executor.js";

const logger = createLogger("runner:scheduler");

const activeCrons = new Map<string, Cron>();
const activeTimers = new Map<string, Timer>();

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
    if (job.trigger_type === "cron" && job.cron_expr) {
      scheduleCronJob(job.id, job.name, job.cron_expr);
    } else if (job.trigger_type === "one-shot" && job.run_at) {
      scheduleOneShotJob(job.id, job.name, job.run_at, job.run_count);
    }
  }

  logger.info(
    `Scheduler started. ${activeCrons.size} cron + ${activeTimers.size} one-shot jobs scheduled.`,
  );
}

export function scheduleCronJob(jobId: string, name: string, expr: string): void {
  if (activeCrons.has(jobId)) {
    activeCrons.get(jobId)?.stop();
  }

  const cron = new Cron(expr, async () => {
    logger.info(`Cron trigger: ${name}`);
    try {
      await executeJob({ jobId, triggerBy: "cron" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("Job not found:")) {
        logger.warn(`Cron job ${name} no longer exists, unscheduling`);
        unscheduleJob(jobId);
        return;
      }
      logger.error(`Cron job failed: ${name}`, err);
    }
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
    logger.info(`One-shot trigger: ${name}`);
    try {
      await executeJob({ jobId, triggerBy: "one-shot" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith("Job not found:")) {
        logger.error(`One-shot job failed: ${name}`, err);
      }
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
  logger.info("Scheduler stopped.");
}
