import type { AgentSession } from "@orc/agent-runtime";
import { openAgentSession } from "@orc/agent-runtime";
import type { PickedTask } from "@orc/core";
import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import type { SkillFull } from "@orc/core/skill-service";
import { readSkill } from "@orc/core/skill-service";
import { getDb, getSqlite } from "@orc/db/client";
import { gateway_sessions, job_runs, jobs, tasks } from "@orc/db/schema";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { OrcTaskProvider } from "./orc-task-provider.js";

const logger = createLogger("runner:task-loop");
const provider = new OrcTaskProvider();

function getActiveWorkerCount(projectId?: string | null): number {
  const sqlite = getSqlite();
  if (projectId) {
    const row = sqlite
      .query(
        "SELECT COUNT(*) as count FROM gateway_sessions WHERE role = 'worker' AND status = 'running' AND project_id = ?",
      )
      .get(projectId) as { count: number } | null;
    return row?.count ?? 0;
  }
  const row = sqlite
    .query(
      "SELECT COUNT(*) as count FROM gateway_sessions WHERE role = 'worker' AND status = 'running'",
    )
    .get() as { count: number } | null;
  return row?.count ?? 0;
}

function getProjectMaxWorkers(projectId: string): number | null {
  const sqlite = getSqlite();
  const row = sqlite.query("SELECT max_workers FROM projects WHERE id = ?").get(projectId) as {
    max_workers: number | null;
  } | null;
  return row?.max_workers ?? null;
}

async function buildPrompt(
  task: PickedTask,
  prevSession?: { ended_at: number } | null,
): Promise<string> {
  const sqlite = getSqlite();

  // Resuming after changes_requested: send only the feedback added since the
  // worker's last session ended. The agent already has full task context from
  // its previous run — resending the whole prompt wastes tokens and buries the
  // reviewer's feedback inside noise.
  if (prevSession) {
    const newComments = sqlite
      .query(
        `SELECT content, author FROM comments
         WHERE resource_type = 'task' AND resource_id = ? AND created_at > ?
         ORDER BY created_at ASC`,
      )
      .all(task.id, prevSession.ended_at) as { content: string; author: string }[];

    const parts = [
      `You are resuming work on task "${task.title}" (ID: ${task.id}) after the reviewer requested changes.`,
    ];
    if (newComments.length > 0) {
      parts.push("## Reviewer Feedback");
      for (const c of newComments) {
        parts.push(`[${c.author}]: ${c.content}`);
      }
    } else {
      parts.push("(No new comments found — re-read the task history and address any open issues.)");
    }
    parts.push(
      'Address the feedback above, then set the task status to "review" with a comment summarising exactly what you fixed.',
    );
    return parts.join("\n\n");
  }

  // Fresh start: full context
  const parts: string[] = [];

  const baseSkill = readSkill("orc-worker-base") as SkillFull | null;
  if (baseSkill) parts.push(baseSkill.content);

  if (task.skill_name) {
    const workflow = readSkill(task.skill_name) as SkillFull | null;
    if (workflow) parts.push(`\n---\n## Workflow: ${workflow.name}\n${workflow.content}`);
  }

  parts.push(`\n---\n## Task: ${task.title}\nTask ID: ${task.id}`);
  if (task.body) parts.push(task.body);

  const taskComments = sqlite
    .query(
      "SELECT content, author, created_at FROM comments WHERE resource_type = 'task' AND resource_id = ? ORDER BY created_at ASC",
    )
    .all(task.id) as { content: string; author: string; created_at: number }[];
  if (taskComments.length > 0) {
    parts.push("\n## Comments");
    for (const c of taskComments) {
      parts.push(`[${c.author}]: ${c.content}`);
    }
  }

  return parts.join("\n\n");
}

function findPreviousWorkerSession(taskId: string): {
  runtime_session_id: string;
  review_rounds: number;
  cwd: string;
  ended_at: number;
} | null {
  const sqlite = getSqlite();
  const row = sqlite
    .query(
      `SELECT runtime_session_id, review_rounds, cwd, updated_at AS ended_at FROM gateway_sessions
       WHERE task_id = ? AND role = 'worker' AND runtime_session_id IS NOT NULL
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(taskId) as {
    runtime_session_id: string;
    review_rounds: number;
    cwd: string;
    ended_at: number;
  } | null;
  return row;
}

async function spawnWorker(task: PickedTask): Promise<void> {
  const config = loadConfig();
  const db = getDb();
  const sessionId = ulid();

  const backendName = task.agent_backend ?? config.agent_loop.default_backend;
  const prevSession = findPreviousWorkerSession(task.id);
  const isResume = !!prevSession;

  const claimResult = await provider.updateTaskStatus({
    taskId: task.id,
    status: "queued",
    claimedBy: sessionId,
    comment: isResume
      ? `Resuming after changes_requested (backend: ${backendName})`
      : `Claimed by task loop (backend: ${backendName})`,
    author: "system",
  });
  if (!claimResult.ok) {
    logger.warn(`Failed to claim task ${task.id}: ${claimResult.error}`);
    return;
  }

  const prompt = await buildPrompt(task, prevSession);
  let cwd = prevSession?.cwd ?? process.cwd();
  if (task.project_id) {
    const proj = getSqlite()
      .query("SELECT scope FROM projects WHERE id = ?")
      .get(task.project_id) as { scope: string | null } | null;
    if (proj?.scope) cwd = proj.scope;
  }

  const now = new Date();
  await db.insert(gateway_sessions).values({
    id: sessionId,
    chat_id: "__task-loop__",
    backend: backendName,
    mode: `agent:${backendName}`,
    cwd,
    title: task.title,
    status: "running",
    auto_approve: true,
    task_id: task.id,
    role: "worker",
    pid: process.pid,
    project_id: task.project_id,
    review_rounds: prevSession?.review_rounds ?? 0,
    created_at: now,
    updated_at: now,
  });

  driveWorkerLoop(sessionId, task, backendName, prompt, cwd, prevSession?.runtime_session_id).catch(
    (err) => {
      logger.error(`Worker ${sessionId} failed: ${String(err)}`);
    },
  );
}

// Throttle per-event session activity writes. Agents can emit many events per
// second; writing last_activity_at on every one was the dominant WAL-write
// source feeding unbounded WAL growth. A few seconds of lag is harmless — the
// idle-cleanup cutoff is minutes-scale.
const SESSION_TOUCH_THROTTLE_MS = 5_000;
const lastSessionTouch = new Map<string, number>();

// In-memory handles to live worker/reviewer agent sessions. Without this,
// cleanupStaleSessions could only flip DB rows — the hung agent child process
// and the suspended `for await (session.events())` frame leaked forever. The
// registry lets cleanup actually close the session (kill the process), which
// ends the event loop and releases the worker slot.
const liveSessions = new Map<string, AgentSession>();

function touchSessionActivity(sessionId: string): void {
  const now = Date.now();
  const last = lastSessionTouch.get(sessionId) ?? 0;
  if (now - last < SESSION_TOUCH_THROTTLE_MS) return;
  lastSessionTouch.set(sessionId, now);
  getSqlite()
    .query(
      "UPDATE gateway_sessions SET last_activity_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
    )
    .run(sessionId);
}

async function driveWorkerLoop(
  sessionId: string,
  task: PickedTask,
  backendName: string,
  prompt: string,
  cwd: string,
  previousRuntimeSessionId?: string | undefined,
): Promise<void> {
  const sqlite = getSqlite();
  let session: AgentSession | null = null;

  try {
    const doingResult = await provider.updateTaskStatus({
      taskId: task.id,
      status: "doing",
      claimedBy: sessionId,
      author: "system",
    });
    if (!doingResult.ok) {
      logger.warn(`Failed to start task ${task.id}: ${doingResult.error}`);
      sqlite
        .query("UPDATE gateway_sessions SET status = 'error', last_error = ? WHERE id = ?")
        .run(doingResult.error ?? "transition failed", sessionId);
      return;
    }

    const sessionOpts = {
      cwd,
      autoApprove: true,
      ...(task.agent_model ? { model: task.agent_model } : {}),
    };

    session = await openAgentSession(backendName, sessionOpts, previousRuntimeSessionId);
    liveSessions.set(sessionId, session);
    await session.send(prompt);

    const autoApprove = loadConfig().agent_loop.worker_auto_approve;

    for await (const event of session.events()) {
      touchSessionActivity(sessionId);

      if (event.type === "permission_request") {
        if (autoApprove) {
          session.respondPermission(event.data.requestId, "approved");
        } else {
          logger.info(
            `Permission request for worker ${sessionId}: ${event.data.tool} - queuing for human`,
          );
          session.respondPermission(event.data.requestId, "denied");
        }
      }

      if (event.type === "result") {
        if (event.data.runtimeSessionId) {
          sqlite
            .query("UPDATE gateway_sessions SET runtime_session_id = ? WHERE id = ?")
            .run(event.data.runtimeSessionId, sessionId);
        }
      }

      if (event.type === "error") {
        logger.error(`Worker ${sessionId} error: ${event.data}`);
        sqlite
          .query("UPDATE gateway_sessions SET last_error = ?, status = 'error' WHERE id = ?")
          .run(event.data, sessionId);
        await provider.updateTaskStatus({
          taskId: task.id,
          status: "blocked",
          comment: `Agent error: ${event.data}`,
          author: "system",
        });
        return;
      }
    }

    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'stopped', updated_at = unixepoch() WHERE id = ?",
      )
      .run(sessionId);
    await provider.releaseTask(task.id);
    logger.info(`Worker ${sessionId} completed for task ${task.id}`);
  } catch (err) {
    const errMsg = String(err);
    logger.error(`Worker ${sessionId} crashed: ${errMsg}`);
    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'error', last_error = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(errMsg, sessionId);
    await provider.updateTaskStatus({
      taskId: task.id,
      status: "blocked",
      comment: `Worker crashed: ${errMsg}`,
      author: "system",
    });
  } finally {
    lastSessionTouch.delete(sessionId);
    liveSessions.delete(sessionId);
    if (session?.alive()) {
      await session.close().catch(() => {});
    }
  }
}

async function buildReviewPrompt(task: PickedTask): Promise<string> {
  const parts: string[] = [];

  const reviewerSkill = readSkill("orc-reviewer") as SkillFull | null;
  if (reviewerSkill) parts.push(reviewerSkill.content);

  parts.push(`\n---\n## Task Under Review: ${task.title}\nTask ID: ${task.id}`);
  if (task.body) parts.push(task.body);

  const sqlite = getSqlite();
  const taskComments = sqlite
    .query(
      "SELECT content, author, created_at FROM comments WHERE resource_type = 'task' AND resource_id = ? ORDER BY created_at ASC",
    )
    .all(task.id) as { content: string; author: string; created_at: number }[];
  if (taskComments.length > 0) {
    parts.push("\n## Comments");
    for (const c of taskComments) {
      parts.push(`[${c.author}]: ${c.content}`);
    }
  }

  return parts.join("\n\n");
}

async function spawnReviewer(task: PickedTask): Promise<void> {
  const config = loadConfig();
  const db = getDb();
  const sessionId = ulid();
  const backendName = task.agent_backend ?? config.agent_loop.default_backend;

  const current = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
  if (!current || current.status !== "review" || current.claimed_by) {
    logger.warn(
      `Reviewer skipped: task ${task.id} no longer eligible (status=${current?.status}, claimed=${current?.claimed_by})`,
    );
    return;
  }
  await provider.claimTask(task.id, sessionId);

  const prompt = await buildReviewPrompt(task);
  let cwd = process.cwd();
  if (task.project_id) {
    const proj = getSqlite()
      .query("SELECT scope FROM projects WHERE id = ?")
      .get(task.project_id) as { scope: string | null } | null;
    if (proj?.scope) cwd = proj.scope;
  }

  const now = new Date();
  await db.insert(gateway_sessions).values({
    id: sessionId,
    chat_id: "__task-loop__",
    backend: backendName,
    mode: `agent:${backendName}`,
    cwd,
    title: `Review: ${task.title}`,
    status: "running",
    auto_approve: true,
    task_id: task.id,
    role: "reviewer",
    pid: process.pid,
    project_id: task.project_id,
    review_rounds: 0,
    created_at: now,
    updated_at: now,
  });

  driveReviewerLoop(sessionId, task, backendName, prompt, cwd).catch((err) => {
    logger.error(`Reviewer ${sessionId} failed: ${String(err)}`);
  });
}

async function driveReviewerLoop(
  sessionId: string,
  task: PickedTask,
  backendName: string,
  prompt: string,
  cwd: string,
): Promise<void> {
  const sqlite = getSqlite();
  let session: AgentSession | null = null;

  try {
    session = await openAgentSession(backendName, { cwd, autoApprove: true });
    liveSessions.set(sessionId, session);
    await session.send(prompt);

    for await (const event of session.events()) {
      touchSessionActivity(sessionId);

      if (event.type === "permission_request") {
        session.respondPermission(event.data.requestId, "approved");
      }

      if (event.type === "error") {
        logger.error(`Reviewer ${sessionId} error: ${event.data}`);
        sqlite
          .query("UPDATE gateway_sessions SET last_error = ?, status = 'error' WHERE id = ?")
          .run(event.data, sessionId);
        await provider.releaseTask(task.id);
        return;
      }
    }

    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'stopped', updated_at = unixepoch() WHERE id = ?",
      )
      .run(sessionId);
    await provider.releaseTask(task.id);
    logger.info(`Reviewer ${sessionId} completed for task ${task.id}`);
  } catch (err) {
    const errMsg = String(err);
    logger.error(`Reviewer ${sessionId} crashed: ${errMsg}`);
    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'error', last_error = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(errMsg, sessionId);
    await provider.releaseTask(task.id);
  } finally {
    lastSessionTouch.delete(sessionId);
    liveSessions.delete(sessionId);
    if (session?.alive()) {
      await session.close().catch(() => {});
    }
  }
}

function isAtCapacity(task: PickedTask): boolean {
  const config = loadConfig();
  const globalMax = config.agent_loop.max_workers;
  const globalActive = getActiveWorkerCount();
  if (globalActive >= globalMax) return true;

  if (task.project_id) {
    const projectMax = getProjectMaxWorkers(task.project_id);
    if (projectMax !== null) {
      const projectActive = getActiveWorkerCount(task.project_id);
      if (projectActive >= projectMax) return true;
    }
  }
  return false;
}

export const SYSTEM_JOB_NAME = "orc-task-loop";

export function cleanupStaleSessions(): number {
  const config = loadConfig();
  const timeoutMinutes = config.agent_loop.session_idle_timeout_minutes;
  const maxLifetimeMinutes = config.agent_loop.session_max_lifetime_minutes;
  const sqlite = getSqlite();
  const nowSecs = Math.floor(Date.now() / 1000);
  const cutoff = nowSecs - timeoutMinutes * 60;
  // Absolute-lifetime ceiling, independent of activity: a chatty-but-hung agent
  // refreshes last_activity_at every event and would never hit the idle cutoff,
  // permanently holding a worker slot. This cap is a separate, generous config
  // (default 120m) so it doesn't reap healthy long-running work.
  const lifetimeCutoff = nowSecs - maxLifetimeMinutes * 60;
  const stale = sqlite
    .query(
      `SELECT id, task_id, role, created_at FROM gateway_sessions
       WHERE role IN ('worker', 'reviewer') AND status = 'running'
         AND ((last_activity_at IS NOT NULL AND last_activity_at < ?
              OR last_activity_at IS NULL AND updated_at < ?)
              OR created_at < ?)`,
    )
    .all(cutoff, cutoff, lifetimeCutoff) as {
    id: string;
    task_id: string | null;
    role: string;
    created_at: number;
  }[];

  for (const s of stale) {
    const reason = s.created_at < lifetimeCutoff ? "max lifetime exceeded" : "idle timeout";
    // Kill the live agent process (if we still hold a handle) so the suspended
    // event loop unblocks and the worker slot is genuinely freed — not just
    // flagged in the DB.
    const live = liveSessions.get(s.id);
    if (live) {
      liveSessions.delete(s.id);
      void live.close().catch(() => {});
    }
    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'error', last_error = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(reason, s.id);
    if (s.task_id) {
      if (s.role === "reviewer") {
        // Reviewer timed out: unclaim the task so a new reviewer can be spawned.
        // Don't touch status — task stays in 'review'.
        sqlite
          .query("UPDATE tasks SET claimed_by = NULL, updated_at = unixepoch() WHERE id = ?")
          .run(s.task_id);
      } else {
        // Worker timed out: reset to 'todo' so the loop retries.
        sqlite
          .query(
            "UPDATE tasks SET claimed_by = NULL, status = CASE WHEN status IN ('doing','queued') THEN 'todo' ELSE status END, updated_at = unixepoch() WHERE id = ?",
          )
          .run(s.task_id);
      }
    }
    logger.warn(`Cleaned up stale ${s.role} session ${s.id} (${reason})`);
  }
  return stale.length;
}

async function runCycle(): Promise<string> {
  const config = loadConfig();
  const lines: string[] = [];

  const cleaned = cleanupStaleSessions();
  if (cleaned > 0) lines.push(`Cleaned ${cleaned} stale session(s)`);

  const globalActive = getActiveWorkerCount();
  lines.push(`Active workers: ${globalActive}/${config.agent_loop.max_workers}`);

  if (globalActive >= config.agent_loop.max_workers) {
    lines.push("At global capacity - skipping");
    return lines.join("\n");
  }

  let spawned = 0;

  // Review tasks run in parallel with work tasks and with each other
  const reviewTasks = await provider.pickReviewTasks();
  for (const reviewTask of reviewTasks) {
    if (getActiveWorkerCount() >= config.agent_loop.max_workers) break;
    if (isAtCapacity(reviewTask)) continue;
    logger.info(`Spawning reviewer for task ${reviewTask.id}: "${reviewTask.title}"`);
    await spawnReviewer(reviewTask);
    lines.push(`Spawned reviewer for: [${reviewTask.id}] ${reviewTask.title}`);
    spawned++;
  }

  // Work tasks: one per project, different projects run in parallel
  const projectsWithWorker = new Set<string>();
  const allTasks = await provider.pickWorkTasks();
  for (const task of allTasks) {
    if (getActiveWorkerCount() >= config.agent_loop.max_workers) break;
    const projectKey = task.project_id ?? "__no_project__";
    if (projectsWithWorker.has(projectKey)) continue;
    if (isAtCapacity(task)) {
      lines.push(`At capacity for project ${task.project_id ?? "global"}`);
      projectsWithWorker.add(projectKey);
      continue;
    }
    logger.info(`Spawning worker for task ${task.id}: "${task.title}"`);
    await spawnWorker(task);
    lines.push(`Spawned worker for: [${task.id}] ${task.title}`);
    projectsWithWorker.add(projectKey);
    spawned++;
  }

  if (spawned === 0) lines.push("No eligible tasks");
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
    description: "Agent task loop - polls for tasks, spawns workers, cleans stale sessions",
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
    `Task loop started (cron: ${cronExpr}, max ${config.agent_loop.max_workers} workers, idle timeout: ${config.agent_loop.session_idle_timeout_minutes}m)`,
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
