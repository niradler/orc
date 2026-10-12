import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { job_runs, jobs } from "@orc/db/schema";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import {
  cleanupStaleFlowSessions,
  drainPendingNodes,
  getActiveFlowRunForTask,
  getActiveWorkerCount,
  startFlowForTask,
  sweepFlowTimeouts,
} from "./flow-runner.js";
import { OrcTaskProvider } from "./orc-task-provider.js";

const logger = createLogger("runner:task-loop");
const provider = new OrcTaskProvider();

export const SYSTEM_JOB_NAME = "orc-task-loop";

/**
 * Kept as a named export for callers and tests that predate flows. Session
 * reaping now also has to tell the owning flow its node died, which is why the
 * implementation lives with the flow runner.
 */
export async function cleanupStaleSessions(): Promise<number> {
  return cleanupStaleFlowSessions();
}

/**
 * One cycle: reap dead sessions, honour flow wall clocks, start flows for tasks
 * that need one, then spawn as many queued nodes as capacity allows.
 *
 * Every task runs a flow graph — there is no separate worker/reviewer path any
 * more. `orc-default` is the graph that reproduces the pipeline this loop used
 * to hardcode.
 */
async function runCycle(): Promise<string> {
  const config = loadConfig();
  const lines: string[] = [];

  const cleaned = await cleanupStaleSessions();
  if (cleaned > 0) lines.push(`Cleaned ${cleaned} stale session(s)`);

  const timedOut = await sweepFlowTimeouts();
  if (timedOut > 0) lines.push(`Halted ${timedOut} flow(s) past their execution timeout`);

  lines.push(`Active workers: ${getActiveWorkerCount()}/${config.agent_loop.max_workers}`);

  // Start flows even at capacity: nodes queue as `pending` and drain as slots
  // free up, so a busy install still records what is waiting and why.
  let started = 0;

  for (const task of await provider.pickWorkTasks()) {
    if (getActiveFlowRunForTask(task.id)) continue;
    // Per-task guard: one task with an unusable flow must not abort the cycle
    // for every other task.
    try {
      const result = await startFlowForTask(task.id);
      if (result.ok) {
        lines.push(`Started ${result.flowName} for: [${task.id}] ${task.title}`);
        started++;
      } else {
        lines.push(`Could not start flow for [${task.id}]: ${result.error}`);
      }
    } catch (err) {
      logger.error(`Starting a flow for task ${task.id} threw: ${String(err)}`);
      lines.push(`Error starting flow for [${task.id}]: ${String(err)}`);
    }
  }

  // A task a human moved straight to `review` has no run of its own; give it
  // the review-only graph rather than leaving it sitting there.
  for (const task of await provider.pickReviewTasks()) {
    if (getActiveFlowRunForTask(task.id)) continue;
    try {
      const result = await startFlowForTask(task.id, { flowName: config.agent_loop.review_flow });
      if (result.ok) {
        lines.push(`Started ${result.flowName} for review: [${task.id}] ${task.title}`);
        started++;
      } else {
        lines.push(`Could not start review flow for [${task.id}]: ${result.error}`);
      }
    } catch (err) {
      logger.error(`Starting a review flow for task ${task.id} threw: ${String(err)}`);
      lines.push(`Error starting review flow for [${task.id}]: ${String(err)}`);
    }
  }

  const spawned = await drainPendingNodes();
  for (const node of spawned) lines.push(`Spawned node ${node}`);

  if (started === 0 && spawned.length === 0) lines.push("No eligible tasks");
  return lines.join("\n");
}

export async function ensureSystemJob(): Promise<string> {
  const db = getDb();
  const existing = await db.query.jobs.findFirst({ where: eq(jobs.name, SYSTEM_JOB_NAME) });
  if (existing) {
    const config = loadConfig();
    const expectedCron = `*/${config.agent_loop.poll_interval_minutes} * * * *`;
    if (existing.cron_expr !== expectedCron) {
      await db
        .update(jobs)
        .set({ cron_expr: expectedCron, updated_at: new Date() })
        .where(eq(jobs.id, existing.id));
      logger.info(`Updated task loop cron: ${existing.cron_expr} → ${expectedCron}`);
    }
    return existing.id;
  }

  const config = loadConfig();
  const id = ulid();
  const now = new Date();
  const cronExpr = `*/${config.agent_loop.poll_interval_minutes} * * * *`;
  await db.insert(jobs).values({
    id,
    name: SYSTEM_JOB_NAME,
    description: "Agent task loop - starts task flows, spawns flow nodes, cleans stale sessions",
    command: "__internal:task-loop-cycle__",
    trigger_type: "cron",
    cron_expr: cronExpr,
    timeout_secs: 120,
    enabled: true,
    created_at: now,
    updated_at: now,
  });
  logger.info(`Seeded system job: ${SYSTEM_JOB_NAME} (${cronExpr})`);
  return id;
}

let cycleRunning = false;

export async function recordedCycle(): Promise<void> {
  if (cycleRunning) {
    logger.debug("Skipping cycle - another cycle is already running");
    return;
  }
  cycleRunning = true;

  const db = getDb();
  const job = await db.query.jobs.findFirst({ where: eq(jobs.name, SYSTEM_JOB_NAME) });
  if (!job) {
    cycleRunning = false;
    return;
  }

  const runId = ulid();
  const now = new Date();
  await db.insert(job_runs).values({
    id: runId,
    job_id: job.id,
    status: "running",
    trigger_by: "cron",
    started_at: now,
    created_at: now,
  });

  try {
    const summary = await runCycle();
    const endedAt = new Date();
    await db
      .update(job_runs)
      .set({ status: "success", exit_code: 0, ended_at: endedAt, stdout: summary })
      .where(eq(job_runs.id, runId));
    await db
      .update(jobs)
      .set({ last_run_at: endedAt, run_count: (job.run_count ?? 0) + 1, updated_at: endedAt })
      .where(eq(jobs.id, job.id));
  } catch (err) {
    const errMsg = String(err);
    logger.error(`Task loop cycle failed: ${errMsg}`);
    await db
      .update(job_runs)
      .set({ status: "failed", ended_at: new Date(), error_msg: errMsg })
      .where(eq(job_runs.id, runId));
  } finally {
    cycleRunning = false;
  }
}

let loopCron: Cron | null = null;

export async function startTaskLoop(): Promise<void> {
  const config = loadConfig();
  if (!config.agent_loop.enabled) {
    logger.info("Agent loop disabled");
    return;
  }

  const _jobId = await ensureSystemJob();
  const cronExpr = `*/${config.agent_loop.poll_interval_minutes} * * * *`;

  logger.info(
    `Task loop started (cron: ${cronExpr}, max ${config.agent_loop.max_workers} workers, ` +
      `default flow: ${config.agent_loop.default_flow}, idle timeout: ${config.agent_loop.session_idle_timeout_minutes}m)`,
  );

  // Run first cycle immediately
  recordedCycle().catch((err) => logger.error(`Cycle error: ${String(err)}`));

  loopCron?.stop();
  loopCron = new Cron(cronExpr, { protect: true }, async () => {
    recordedCycle().catch((err) => logger.error(`Cycle error: ${String(err)}`));
  });
}

export function stopTaskLoop(): void {
  if (loopCron) {
    loopCron.stop();
    loopCron = null;
    logger.info("Task loop stopped");
  }
}

let triggerDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function triggerTaskCheck(): void {
  if (!loopCron) {
    logger.debug("triggerTaskCheck called but task loop is not running");
    return;
  }
  if (triggerDebounceTimer) return;
  triggerDebounceTimer = setTimeout(() => {
    triggerDebounceTimer = null;
    logger.info("Task check triggered by task change");
    recordedCycle().catch((err) => logger.error(`Triggered cycle error: ${String(err)}`));
  }, 500);
}
