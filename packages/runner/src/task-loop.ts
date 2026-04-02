import type { AgentBackendName, AgentSession } from "@orc/agent-runtime";
import { createBackend } from "@orc/agent-runtime";
import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb, getSqlite } from "@orc/db/client";
import { gateway_sessions, job_runs, jobs, prompts, tasks } from "@orc/db/schema";
import { updateTaskStatus } from "@orc/task-service";
import { Cron } from "croner";
import { eq } from "drizzle-orm";

const logger = createLogger("runner:task-loop");

type PickedTask = {
  id: string;
  title: string;
  body: string | null;
  status: string;
  prompt_id: string | null;
  agent_backend: string | null;
  tags: string | null;
  project_id: string | null;
};

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

async function buildPrompt(task: PickedTask): Promise<string> {
  const db = getDb();
  const parts: string[] = [];

  const basePrompt = await db.query.prompts.findFirst({
    where: eq(prompts.name, "orc-worker-base"),
  });
  if (basePrompt) parts.push(basePrompt.template);

  if (task.prompt_id) {
    const taskPrompt = await db.query.prompts.findFirst({ where: eq(prompts.id, task.prompt_id) });
    if (taskPrompt) parts.push(`\n---\n## Workflow: ${taskPrompt.name}\n${taskPrompt.template}`);
  }

  parts.push(`\n---\n## Task: ${task.title}\nTask ID: ${task.id}`);
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

function findPreviousSession(
  taskId: string,
): { runtime_session_id: string; review_rounds: number; cwd: string } | null {
  const sqlite = getSqlite();
  const row = sqlite
    .query(
      `SELECT runtime_session_id, review_rounds, cwd FROM gateway_sessions
       WHERE task_id = ? AND runtime_session_id IS NOT NULL AND status IN ('stopped', 'error')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(taskId) as { runtime_session_id: string; review_rounds: number; cwd: string } | null;
  return row;
}

async function spawnWorker(task: PickedTask): Promise<void> {
  const config = loadConfig();
  const db = getDb();
  const sessionId = ulid();

  const backendName = (task.agent_backend ?? config.agent_loop.default_backend) as AgentBackendName;
  const isResume = task.status === "changes_requested";
  const prevSession = isResume ? findPreviousSession(task.id) : null;

  const claimResult = await updateTaskStatus({
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

  const prompt = await buildPrompt(task);
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

async function driveWorkerLoop(
  sessionId: string,
  task: PickedTask,
  backendName: AgentBackendName,
  prompt: string,
  cwd: string,
  previousRuntimeSessionId?: string | undefined,
): Promise<void> {
  const _db = getDb();
  const sqlite = getSqlite();
  let session: AgentSession | null = null;

  try {
    const doingResult = await updateTaskStatus({
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

    const backend = createBackend(backendName);

    if (previousRuntimeSessionId) {
      logger.info(`Attempting resume of session ${previousRuntimeSessionId} for task ${task.id}`);
      try {
        session = await backend.resumeSession(previousRuntimeSessionId, { cwd, autoApprove: true });
        await session.send(prompt);
        logger.info(`Resume succeeded for task ${task.id}`);
      } catch (resumeErr) {
        logger.warn(`Resume failed for task ${task.id}: ${String(resumeErr)}, starting fresh`);
        session = await backend.startSession({ cwd, autoApprove: true });
        await session.send(prompt);
      }
    } else {
      session = await backend.startSession({ cwd, autoApprove: true });
      await session.send(prompt);
    }

    const autoApprove = loadConfig().agent_loop.worker_auto_approve;

    for await (const event of session.events()) {
      sqlite
        .query(
          "UPDATE gateway_sessions SET last_activity_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
        )
        .run(sessionId);

      if (event.type === "permission_request") {
        if (autoApprove) {
          session.respondPermission(event.data.requestId, "approved");
        } else {
          logger.info(
            `Permission request for worker ${sessionId}: ${event.data.tool} — queuing for human`,
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
        await updateTaskStatus({
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
    sqlite
      .query("UPDATE tasks SET claimed_by = NULL, updated_at = unixepoch() WHERE id = ?")
      .run(task.id);
    logger.info(`Worker ${sessionId} completed for task ${task.id}`);
  } catch (err) {
    const errMsg = String(err);
    logger.error(`Worker ${sessionId} crashed: ${errMsg}`);
    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'error', last_error = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(errMsg, sessionId);
    await updateTaskStatus({
      taskId: task.id,
      status: "blocked",
      comment: `Worker crashed: ${errMsg}`,
      author: "system",
    });
  } finally {
    if (session?.alive()) {
      await session.close().catch(() => {});
    }
  }
}

async function buildReviewPrompt(task: PickedTask): Promise<string> {
  const db = getDb();
  const parts: string[] = [];

  const reviewerPrompt = await db.query.prompts.findFirst({
    where: eq(prompts.name, "orc-reviewer"),
  });
  if (reviewerPrompt) parts.push(reviewerPrompt.template);

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
  const backendName = (task.agent_backend ?? config.agent_loop.default_backend) as AgentBackendName;

  const current = await db.query.tasks.findFirst({ where: eq(tasks.id, task.id) });
  if (!current || current.status !== "review" || current.claimed_by) {
    logger.warn(
      `Reviewer skipped: task ${task.id} no longer eligible (status=${current?.status}, claimed=${current?.claimed_by})`,
    );
    return;
  }
  await db
    .update(tasks)
    .set({ claimed_by: sessionId, updated_at: new Date() })
    .where(eq(tasks.id, task.id));

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
    role: "worker",
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
  backendName: AgentBackendName,
  prompt: string,
  cwd: string,
): Promise<void> {
  const sqlite = getSqlite();
  let session: AgentSession | null = null;

  try {
    const backend = createBackend(backendName);
    session = await backend.startSession({ cwd, autoApprove: true });
    await session.send(prompt);

    for await (const event of session.events()) {
      sqlite
        .query(
          "UPDATE gateway_sessions SET last_activity_at = unixepoch(), updated_at = unixepoch() WHERE id = ?",
        )
        .run(sessionId);

      if (event.type === "permission_request") {
        session.respondPermission(event.data.requestId, "approved");
      }

      if (event.type === "error") {
        logger.error(`Reviewer ${sessionId} error: ${event.data}`);
        sqlite
          .query("UPDATE gateway_sessions SET last_error = ?, status = 'error' WHERE id = ?")
          .run(event.data, sessionId);
        const reviewDb = getDb();
        await reviewDb
          .update(tasks)
          .set({ claimed_by: null, updated_at: new Date() })
          .where(eq(tasks.id, task.id));
        return;
      }
    }

    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'stopped', updated_at = unixepoch() WHERE id = ?",
      )
      .run(sessionId);
    sqlite
      .query("UPDATE tasks SET claimed_by = NULL, updated_at = unixepoch() WHERE id = ?")
      .run(task.id);
    logger.info(`Reviewer ${sessionId} completed for task ${task.id}`);
  } catch (err) {
    const errMsg = String(err);
    logger.error(`Reviewer ${sessionId} crashed: ${errMsg}`);
    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'error', last_error = ?, updated_at = unixepoch() WHERE id = ?",
      )
      .run(errMsg, sessionId);
    const reviewDb = getDb();
    await reviewDb
      .update(tasks)
      .set({ claimed_by: null, updated_at: new Date() })
      .where(eq(tasks.id, task.id));
  } finally {
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
  const sqlite = getSqlite();
  const cutoff = Math.floor(Date.now() / 1000) - timeoutMinutes * 60;
  const stale = sqlite
    .query(
      `SELECT id, task_id FROM gateway_sessions
       WHERE role = 'worker' AND status = 'running'
         AND (last_activity_at IS NOT NULL AND last_activity_at < ?
              OR last_activity_at IS NULL AND updated_at < ?)`,
    )
    .all(cutoff, cutoff) as { id: string; task_id: string | null }[];

  for (const s of stale) {
    sqlite
      .query(
        "UPDATE gateway_sessions SET status = 'error', last_error = 'idle timeout', updated_at = unixepoch() WHERE id = ?",
      )
      .run(s.id);
    if (s.task_id) {
      sqlite
        .query(
          "UPDATE tasks SET claimed_by = NULL, status = CASE WHEN status IN ('doing','queued') THEN 'todo' ELSE status END, updated_at = unixepoch() WHERE id = ?",
        )
        .run(s.task_id);
    }
    logger.warn(`Cleaned up stale worker session ${s.id} (idle > ${timeoutMinutes}m)`);
  }
  return stale.length;
}

function pickAllReviewTasks(): PickedTask[] {
  const sqlite = getSqlite();
  return sqlite
    .query(
      `SELECT t.id, t.title, t.body, t.status, t.prompt_id, t.agent_backend, t.tags, t.project_id
       FROM tasks t
       WHERE t.status = 'review'
         AND t.claimed_by IS NULL
         AND EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = 'agent-review')
       ORDER BY
         CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         t.updated_at ASC`,
    )
    .all() as PickedTask[];
}

function pickAllNextTasks(): PickedTask[] {
  const sqlite = getSqlite();
  return sqlite
    .query(
      `SELECT t.id, t.title, t.body, t.status, t.prompt_id, t.agent_backend, t.tags, t.project_id
       FROM tasks t
       WHERE (t.status = 'todo' OR t.status = 'changes_requested')
         AND t.claimed_by IS NULL
         AND (t.prompt_id IS NOT NULL OR t.agent_backend IS NOT NULL
              OR EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = 'agent'))
         AND NOT EXISTS (
           SELECT 1 FROM (
             SELECT tl.from_task_id AS blocker_id FROM task_links tl WHERE tl.to_task_id = t.id AND tl.link_type = 'blocks'
             UNION
             SELECT tl.to_task_id AS blocker_id FROM task_links tl WHERE tl.from_task_id = t.id AND tl.link_type = 'blocked_by'
           ) b JOIN tasks blocker ON blocker.id = b.blocker_id
           WHERE blocker.status NOT IN ('done', 'cancelled')
         )
       ORDER BY
         CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         t.created_at ASC`,
    )
    .all() as PickedTask[];
}

async function runCycle(): Promise<string> {
  const config = loadConfig();
  const lines: string[] = [];

  const cleaned = cleanupStaleSessions();
  if (cleaned > 0) lines.push(`Cleaned ${cleaned} stale session(s)`);

  const globalActive = getActiveWorkerCount();
  lines.push(`Active workers: ${globalActive}/${config.agent_loop.max_workers}`);

  if (globalActive >= config.agent_loop.max_workers) {
    lines.push("At global capacity — skipping");
    return lines.join("\n");
  }

  let spawned = 0;

  // Review tasks run in parallel with work tasks and with each other
  const reviewTasks = pickAllReviewTasks();
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
  const allTasks = pickAllNextTasks();
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
    description: "Agent task loop — polls for tasks, spawns workers, cleans stale sessions",
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

export async function recordedCycle(): Promise<void> {
  const db = getDb();
  const job = await db.query.jobs.findFirst({ where: eq(jobs.name, SYSTEM_JOB_NAME) });
  if (!job) return;

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

  loopCron = new Cron(cronExpr, async () => {
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
  if (!loopCron) return;
  if (triggerDebounceTimer) return;
  triggerDebounceTimer = setTimeout(() => {
    triggerDebounceTimer = null;
    logger.info("Task check triggered by task change");
    recordedCycle().catch((err) => logger.error(`Triggered cycle error: ${String(err)}`));
  }, 500);
}
