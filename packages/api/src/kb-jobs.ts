import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { job_runs, jobs } from "@orc/db/schema";
import type { KbJobHooks, KnowledgeService } from "@orc/knowledge";
import { executeJob } from "@orc/runner/executor";
import { syncJob, unscheduleJob } from "@orc/runner/scheduler";
import { eq } from "drizzle-orm";

const logger = createLogger("api:kb-jobs");

/** How the knowledge service schedules and starts digest jobs in the process that runs them. */
export const kbJobHooks: KbJobHooks = {
  sync(jobId) {
    const job = getDb().select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (job) syncJob(job);
    else unscheduleJob(jobId);
  },
  async run(jobId, triggerBy) {
    const runId = ulid();
    await getDb().insert(job_runs).values({
      id: runId,
      job_id: jobId,
      status: "pending",
      trigger_by: triggerBy,
      created_at: new Date(),
    });
    executeJob({ jobId, runId, triggerBy }).catch((err) =>
      logger.error(
        `Digest run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return runId;
  },
};

export function withKbJobHooks(svc: KnowledgeService): KnowledgeService {
  svc.jobHooks ??= kbJobHooks;
  return svc;
}
