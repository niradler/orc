import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { jobs } from "@orc/db/schema";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { executeJob } from "./executor.js";

const logger = createLogger("runner:scheduler");

const activeCrons = new Map<string, Cron>();

export async function startScheduler(): Promise<void> {
  const db = getDb();
  const cronJobs = await db.query.jobs.findMany({
    where: eq(jobs.enabled, true),
  });

  for (const job of cronJobs) {
    if (job.trigger_type === "cron" && job.cron_expr) {
      scheduleCronJob(job.id, job.name, job.cron_expr);
    } else if (job.trigger_type === "repeat" && job.repeat_secs) {
      scheduleRepeatJob(job.id, job.name, job.repeat_secs);
    }
  }

  logger.info(`Scheduler started. ${activeCrons.size} jobs scheduled.`);
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
      logger.error(`Cron job failed: ${name}`, err);
    }
  });

  activeCrons.set(jobId, cron);
  logger.info(`Scheduled cron job: ${name} (${expr})`);
}

export function scheduleRepeatJob(jobId: string, name: string, secs: number): void {
  if (activeCrons.has(jobId)) {
    activeCrons.get(jobId)?.stop();
  }

  const expr = `*/${secs < 60 ? secs : Math.floor(secs / 60)} * * * *`;
  const cron = new Cron(expr, async () => {
    logger.info(`Repeat trigger: ${name}`);
    try {
      await executeJob({ jobId, triggerBy: "repeat" });
    } catch (err) {
      logger.error(`Repeat job failed: ${name}`, err);
    }
  });

  activeCrons.set(jobId, cron);
  logger.info(`Scheduled repeat job: ${name} (every ${secs}s)`);
}

export function unscheduleJob(jobId: string): void {
  const cron = activeCrons.get(jobId);
  if (cron) {
    cron.stop();
    activeCrons.delete(jobId);
  }
}

export function stopScheduler(): void {
  for (const [, cron] of activeCrons) cron.stop();
  activeCrons.clear();
  logger.info("Scheduler stopped.");
}
