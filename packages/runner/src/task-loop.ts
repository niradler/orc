import type { Database } from "bun:sqlite";
import type { AgentBackendName, AgentSession } from "@orc/agent-runtime";
import { createBackend } from "@orc/agent-runtime";
import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import { getDb } from "@orc/db/client";
import { gateway_sessions, prompts, tasks } from "@orc/db/schema";
import { updateTaskStatus } from "@orc/task-service";
import { eq } from "drizzle-orm";

const logger = createLogger("runner:task-loop");

function getSqlite(): Database {
  const db = getDb();
  return (db as unknown as { $client: Database }).$client;
}

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

function pickNextTask(): PickedTask | null {
  const sqlite = getSqlite();
  const row = sqlite
    .query(
      `SELECT t.id, t.title, t.body, t.status, t.prompt_id, t.agent_backend, t.tags, t.project_id
       FROM tasks t
       WHERE (t.status = 'todo' OR t.status = 'changes_requested')
         AND t.claimed_by IS NULL
         AND (t.prompt_id IS NOT NULL OR t.agent_backend IS NOT NULL
              OR EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = 'agent'))
         AND NOT EXISTS (
           SELECT 1 FROM task_links tl JOIN tasks blocker ON blocker.id = tl.from_task_id
           WHERE tl.to_task_id = t.id AND tl.link_type = 'blocks'
             AND blocker.status NOT IN ('done', 'cancelled')
         )
       ORDER BY
         CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         t.created_at ASC
       LIMIT 1`,
    )
    .get() as PickedTask | null;
  return row;
}

function getActiveWorkerCount(): number {
  const sqlite = getSqlite();
  const row = sqlite
    .query(
      "SELECT COUNT(*) as count FROM gateway_sessions WHERE role = 'worker' AND status = 'running'",
    )
    .get() as { count: number } | null;
  return row?.count ?? 0;
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

async function spawnWorker(task: PickedTask): Promise<void> {
  const config = loadConfig();
  const db = getDb();
  const sessionId = ulid();

  const backendName = (task.agent_backend ?? config.agent_loop.default_backend) as AgentBackendName;

  await updateTaskStatus({
    taskId: task.id,
    status: "queued",
    claimedBy: sessionId,
    comment: `Claimed by task loop (backend: ${backendName})`,
    author: "system",
  });

  const prompt = await buildPrompt(task);
  const cwd = process.cwd();

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
    review_rounds: 0,
    created_at: now,
    updated_at: now,
  });

  driveWorkerLoop(sessionId, task, backendName, prompt, cwd).catch((err) => {
    logger.error(`Worker ${sessionId} failed: ${String(err)}`);
  });
}

async function driveWorkerLoop(
  sessionId: string,
  task: PickedTask,
  backendName: AgentBackendName,
  prompt: string,
  cwd: string,
): Promise<void> {
  const db = getDb();
  const sqlite = getSqlite();
  let session: AgentSession | null = null;

  try {
    await updateTaskStatus({
      taskId: task.id,
      status: "doing",
      claimedBy: sessionId,
      author: "system",
    });

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

async function runCycle(): Promise<void> {
  const config = loadConfig();
  const maxWorkers = config.agent_loop.max_workers;
  const activeCount = getActiveWorkerCount();

  if (activeCount >= maxWorkers) {
    logger.debug(`At capacity: ${activeCount}/${maxWorkers} workers`);
    return;
  }

  const task = pickNextTask();
  if (!task) {
    logger.debug("No eligible tasks");
    return;
  }

  logger.info(`Spawning worker for task ${task.id}: "${task.title}"`);
  await spawnWorker(task);
}

let loopInterval: ReturnType<typeof setInterval> | null = null;

export function startTaskLoop(): void {
  const config = loadConfig();
  if (!config.agent_loop.enabled) {
    logger.info("Agent loop disabled");
    return;
  }

  const intervalMs = config.agent_loop.poll_interval_minutes * 60_000;
  logger.info(
    `Task loop started (poll every ${config.agent_loop.poll_interval_minutes}m, max ${config.agent_loop.max_workers} workers)`,
  );

  runCycle().catch((err) => logger.error(`Cycle error: ${String(err)}`));
  loopInterval = setInterval(() => {
    runCycle().catch((err) => logger.error(`Cycle error: ${String(err)}`));
  }, intervalMs);
}

export function stopTaskLoop(): void {
  if (loopInterval) {
    clearInterval(loopInterval);
    loopInterval = null;
    logger.info("Task loop stopped");
  }
}
