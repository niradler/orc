# Agent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the agent orchestration design spec (`docs/2026-03-21-agent-orchestration-design.md`) in 3 waves, turning ORC into a task-driven multi-agent orchestrator with HITL review.

**Architecture:** Extract shared task service + agent runtime from existing gateway code. Add task loop to runner. Expose prompts via MCP. Status transitions drive all side-effects.

**Tech Stack:** Bun, TypeScript strict, Drizzle ORM + SQLite, Hono + zod-openapi, MCP SDK, Biome

**Spec:** `docs/2026-03-21-agent-orchestration-design.md`

**Branch strategy:** Each wave is a feature branch off `master`. PR per wave. Validate `bun check && bun typecheck && bun test` before every PR.

---

## File Structure

### New files
- `packages/task-service/package.json` — new shared package
- `packages/task-service/src/index.ts` — task service: transitions, side-effects, comments
- `packages/task-service/src/transitions.ts` — status transition logic + validation
- `packages/task-service/src/notifications.ts` — gateway notification dispatch
- `packages/task-service/src/__tests__/transitions.test.ts` — task service unit tests
- `packages/task-service/tsconfig.json`
- `packages/agent-runtime/package.json` — new shared package (extracted from gateway)
- `packages/agent-runtime/src/types.ts` — AgentSession, AgentBackend interfaces
- `packages/agent-runtime/src/registry.ts` — backend registry
- `packages/agent-runtime/src/io.ts` — stdin/stdout helpers
- `packages/agent-runtime/src/claude.ts` — Claude backend
- `packages/agent-runtime/src/codex.ts` — Codex backend
- `packages/agent-runtime/src/index.ts` — public exports
- `packages/agent-runtime/tsconfig.json`
- `packages/runner/src/task-loop.ts` — poll board, spawn workers, manage concurrency
- `packages/runner/src/seed-prompts.ts` — built-in prompt templates

### Modified files
- `packages/core/src/types.ts` — add `queued`, `paused` to TaskStatusSchema + transitions
- `packages/core/src/config.ts` — add `agent_loop` config section
- `packages/db/src/schema.ts` — add task fields (`prompt_id`, `required_review`, `agent_backend`, `max_review_rounds`), extend `gateway_sessions` (`role`, `pid`, `project_id`, `review_rounds`), make `chat_id` nullable
- `packages/db/src/client.ts` — ALTER TABLE migrations for new columns
- `packages/mcp/src/tools.ts` — add `prompt_list`, `prompt_get`, modify `task_create/update/batch_create/list`, deprecate `task_submit_review`/`task_check_review`
- `packages/api/src/routes/tasks.ts` — add new fields to schemas, wire through task service
- `packages/api/src/server.ts` — call `seedBuiltInPrompts()` on startup
- `packages/runner/src/index.ts` — export task loop
- `packages/gateway/src/agent-runtime/*.ts` — each file becomes thin re-export from `@orc/agent-runtime`
- `package.json` — add new workspace packages
- `AGENTS.md` — document new MCP tools, statuses, agent loop

---

## Wave 1 — Core Orchestration

> Branch: `feat/agent-orchestration-wave1`

### Task 1: Extend Task Status Schema

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add `queued` and `paused` to TaskStatusSchema**

In `packages/core/src/types.ts`, add the two new statuses:

```typescript
export const TaskStatusSchema = z.enum([
  "todo",
  "queued",
  "doing",
  "review",
  "changes_requested",
  "blocked",
  "done",
  "paused",
  "cancelled",
]);
```

- [ ] **Step 2: Update TASK_STATUS_TRANSITIONS**

```typescript
export const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ["doing", "queued", "paused", "cancelled"],
  queued: ["doing", "todo", "cancelled"],
  doing: ["review", "blocked", "paused", "cancelled"],
  blocked: ["doing", "todo", "cancelled"],
  review: ["done", "changes_requested"],
  changes_requested: ["doing", "queued", "paused"],
  done: [],
  paused: ["todo"],
  cancelled: [],
};
```

**Note:** `blocked → todo` added so the unblocking side-effect can go through the transition map consistently.

- [ ] **Step 3: Run typecheck**

Run: `bun typecheck`
Expected: May show errors in files that hardcode status enums. That's expected — we fix those in later tasks.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "feat: add queued and paused task statuses"
```

---

### Task 2: Add Task Schema Columns + Fix gateway_sessions FK

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/client.ts`

- [ ] **Step 1: Add new columns to tasks table in schema.ts**

After `claim_expires_at` in the tasks table definition, add:

```typescript
prompt_id: text("prompt_id").references(() => prompts.id, { onDelete: "set null" }),
required_review: integer("required_review", { mode: "boolean" }).default(true).notNull(),
agent_backend: text("agent_backend", { enum: ["claude", "codex", "cursor"] }),
max_review_rounds: integer("max_review_rounds").default(3).notNull(),
```

- [ ] **Step 2: Extend gateway_sessions table**

After `last_error` in gateway_sessions, add:

```typescript
role: text("role", { enum: ["main", "worker"] }),
pid: integer("pid"),
project_id: text("project_id").references(() => projects.id, { onDelete: "set null" }),
review_rounds: integer("review_rounds").default(0).notNull(),
```

- [ ] **Step 3: Make gateway_sessions.chat_id nullable**

**Why:** The task loop inserts worker sessions not tied to a bridge chat. The current schema has `chat_id` as NOT NULL FK to `bridge_chats(id)`, which blocks task-loop sessions.

Change in the `gateway_sessions` table definition:

```typescript
// Before:
chat_id: text("chat_id")
  .notNull()
  .references(() => bridge_chats.id, { onDelete: "cascade" }),

// After:
chat_id: text("chat_id")
  .references(() => bridge_chats.id, { onDelete: "cascade" }),
```

**Migration note:** SQLite does not support ALTER COLUMN. For existing databases, the NOT NULL constraint remains from the original DDL. For those, the task loop uses a synthetic bridge_chat row (see Step 5).

- [ ] **Step 4: Update status enum in schema.ts tasks table**

```typescript
status: text("status", {
  enum: ["todo", "queued", "doing", "review", "changes_requested", "blocked", "done", "paused", "cancelled"],
})
  .default("todo")
  .notNull(),
```

- [ ] **Step 5: Add ALTER TABLE migrations in client.ts**

```typescript
// Wave 1: Agent orchestration columns
const safeAlter = (sql: string) => {
  try { db.run(sql); } catch {}
};
safeAlter("ALTER TABLE tasks ADD COLUMN prompt_id TEXT REFERENCES prompts(id) ON DELETE SET NULL");
safeAlter("ALTER TABLE tasks ADD COLUMN required_review INTEGER NOT NULL DEFAULT 1");
safeAlter("ALTER TABLE tasks ADD COLUMN agent_backend TEXT");
safeAlter("ALTER TABLE tasks ADD COLUMN max_review_rounds INTEGER NOT NULL DEFAULT 3");
safeAlter("ALTER TABLE gateway_sessions ADD COLUMN role TEXT");
safeAlter("ALTER TABLE gateway_sessions ADD COLUMN pid INTEGER");
safeAlter("ALTER TABLE gateway_sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL");
safeAlter("ALTER TABLE gateway_sessions ADD COLUMN review_rounds INTEGER NOT NULL DEFAULT 0");

// Synthetic bridge_chat for task-loop sessions (existing DBs have NOT NULL on chat_id)
db.run(`INSERT OR IGNORE INTO bridge_chats (id, platform, chat_id, mode, authorized, updated_at, created_at)
  VALUES ('__task-loop__', 'telegram', '__task-loop__', 'direct', 0, unixepoch(), unixepoch())`);
```

- [ ] **Step 6: Update exported types**

Add at the bottom of schema.ts:

```typescript
export type GatewaySessionNew = typeof gateway_sessions.$inferInsert;
```

- [ ] **Step 7: Run typecheck + test**

Run: `bun typecheck && bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema.ts packages/db/src/client.ts
git commit -m "feat: add orchestration columns to tasks and gateway_sessions"
```

---

### Task 3: Create Task Service Package

**Files:**
- Create: `packages/task-service/package.json`
- Create: `packages/task-service/tsconfig.json`
- Create: `packages/task-service/src/index.ts`
- Create: `packages/task-service/src/transitions.ts`
- Create: `packages/task-service/src/notifications.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@orc/task-service",
  "version": "0.1.6",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@orc/core": "workspace:*",
    "@orc/db": "workspace:*",
    "drizzle-orm": "^0.39.3"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 3: Write transitions.ts — the core logic**

Contains `updateTaskStatus()` and `addTaskComment()` — single entry points for both MCP tools and task loop. Validates transitions, applies status changes, fires side-effects.

Key fixes from review:
- `claimedBy` set on both `doing` AND `queued` transitions
- `claimed_by` cleared on both `doing → todo` AND `queued → todo`
- All comment creation goes through `addTaskComment()`

```typescript
import type { Database } from "bun:sqlite";
import { ulid } from "@orc/core/ids";
import { TASK_STATUS_TRANSITIONS, type TaskStatus } from "@orc/core/types";
import { getDb } from "@orc/db/client";
import { comments, tasks } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { notifyReview } from "./notifications.js";

export type TransitionOpts = {
  taskId: string;
  status: TaskStatus;
  comment?: string;
  author?: string;
  claimedBy?: string;
};

export type TransitionResult = {
  ok: boolean;
  error?: string;
  task?: typeof tasks.$inferSelect;
};

function getSqlite(db: ReturnType<typeof getDb>): Database {
  return (db as unknown as { $client: Database }).$client;
}

export async function addTaskComment(taskId: string, content: string, author = "agent"): Promise<string> {
  const db = getDb();
  const id = ulid();
  await db.insert(comments).values({
    id,
    resource_type: "task",
    resource_id: taskId,
    content,
    author,
    created_at: new Date(),
  });
  return id;
}

export async function updateTaskStatus(opts: TransitionOpts): Promise<TransitionResult> {
  const db = getDb();
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, opts.taskId) });
  if (!task) return { ok: false, error: `Task not found: ${opts.taskId}` };

  const currentStatus = task.status as TaskStatus;
  const allowed = TASK_STATUS_TRANSITIONS[currentStatus];
  if (!allowed?.includes(opts.status)) {
    return { ok: false, error: `Cannot transition from ${currentStatus} to ${opts.status}` };
  }

  // Blocker check for "doing"
  if (opts.status === "doing") {
    const sqlite = getSqlite(db);
    const blockers = sqlite
      .query(
        `SELECT t.id, t.title FROM task_links tl JOIN tasks t ON t.id = tl.from_task_id
         WHERE tl.to_task_id = ? AND tl.link_type = 'blocks' AND t.status NOT IN ('done', 'cancelled')
         UNION
         SELECT t.id, t.title FROM task_links tl JOIN tasks t ON t.id = tl.to_task_id
         WHERE tl.from_task_id = ? AND tl.link_type = 'blocked_by' AND t.status NOT IN ('done', 'cancelled')`,
      )
      .all(opts.taskId, opts.taskId) as { id: string; title: string }[];
    if (blockers.length > 0) {
      const names = blockers.map((b) => `[${b.id.slice(-6)}] ${b.title}`).join(", ");
      return { ok: false, error: `Cannot start: blocked by ${names}` };
    }
  }

  const now = new Date();
  const updates: Record<string, unknown> = { status: opts.status, updated_at: now };

  // claimed_by handling
  if ((opts.status === "doing" || opts.status === "queued") && opts.claimedBy) {
    updates.claimed_by = opts.claimedBy;
  }
  if (opts.status === "todo" && (currentStatus === "doing" || currentStatus === "queued")) {
    updates.claimed_by = null;
  }
  if (opts.status === "paused") {
    updates.claimed_by = null;
  }

  await db.update(tasks).set(updates).where(eq(tasks.id, opts.taskId));

  // Add comment if provided
  if (opts.comment) {
    await addTaskComment(opts.taskId, opts.comment, opts.author ?? "agent");
  }

  // Post-transition: review notification
  if (opts.status === "review") {
    const refreshed = await db.query.tasks.findFirst({ where: eq(tasks.id, opts.taskId) });
    if (refreshed && (refreshed as Record<string, unknown>).required_review) {
      notifyReview(opts.taskId, task.title).catch(() => {});
    }
  }

  // Post-transition: unblock dependents + rollup parent
  if (["done", "cancelled"].includes(opts.status)) {
    const sqlite = getSqlite(db);
    const dependents = sqlite
      .query(
        `SELECT DISTINCT dependent_id AS id FROM (
         SELECT tl.to_task_id AS dependent_id FROM task_links tl WHERE tl.from_task_id = ? AND tl.link_type = 'blocks'
         UNION SELECT tl.from_task_id AS dependent_id FROM task_links tl WHERE tl.to_task_id = ? AND tl.link_type = 'blocked_by'
       )`,
      )
      .all(opts.taskId, opts.taskId) as { id: string }[];
    for (const dep of dependents) {
      const remaining = sqlite
        .query(
          `SELECT 1 FROM task_links tl JOIN tasks t ON t.id = tl.from_task_id
         WHERE tl.to_task_id = ? AND tl.link_type = 'blocks' AND t.status NOT IN ('done','cancelled') LIMIT 1`,
        )
        .get(dep.id);
      if (!remaining) {
        const depTask = sqlite.query("SELECT status FROM tasks WHERE id = ?").get(dep.id) as { status: string } | null;
        if (depTask?.status === "blocked") {
          sqlite.query("UPDATE tasks SET status = 'todo', updated_at = unixepoch() WHERE id = ?").run(dep.id);
        }
      }
    }
    const parentLink = sqlite
      .query("SELECT tl.to_task_id FROM task_links tl WHERE tl.from_task_id = ? AND tl.link_type = 'subtask_of' LIMIT 1")
      .get(opts.taskId) as { to_task_id: string } | null;
    if (parentLink) {
      const stats = sqlite
        .query(
          `SELECT COUNT(*) as total, SUM(CASE WHEN t.status IN ('done','cancelled') THEN 1 ELSE 0 END) as done
         FROM task_links tl JOIN tasks t ON t.id = tl.from_task_id WHERE tl.to_task_id = ? AND tl.link_type = 'subtask_of'`,
        )
        .get(parentLink.to_task_id) as { total: number; done: number } | null;
      if (stats && stats.total > 0) {
        const progress = Math.round((stats.done / stats.total) * 100);
        sqlite.query("UPDATE tasks SET progress = ?, updated_at = unixepoch() WHERE id = ?").run(progress, parentLink.to_task_id);
        if (stats.done === stats.total) {
          const parent = sqlite.query("SELECT status FROM tasks WHERE id = ?").get(parentLink.to_task_id) as { status: string } | null;
          if (parent && !["done", "cancelled", "review"].includes(parent.status)) {
            sqlite.query("UPDATE tasks SET status = 'review', updated_at = unixepoch() WHERE id = ?").run(parentLink.to_task_id);
          }
        }
      }
    }
  }

  // Post-transition: max_review_rounds check
  if (opts.status === "changes_requested") {
    const sqlite = getSqlite(db);
    const maxRounds = (task as Record<string, unknown>).max_review_rounds as number ?? 3;
    const session = sqlite
      .query("SELECT id, review_rounds FROM gateway_sessions WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(opts.taskId) as { id: string; review_rounds: number } | null;
    if (session && maxRounds > 0) {
      const newRounds = session.review_rounds + 1;
      sqlite.query("UPDATE gateway_sessions SET review_rounds = ? WHERE id = ?").run(newRounds, session.id);
      if (newRounds >= maxRounds) {
        await db.update(tasks).set({ status: "paused", claimed_by: null, updated_at: now }).where(eq(tasks.id, opts.taskId));
        await addTaskComment(opts.taskId, `Task exceeded max review rounds (${maxRounds}). Paused for manual attention.`, "system");
      }
    }
  }

  const updated = await db.query.tasks.findFirst({ where: eq(tasks.id, opts.taskId) });
  return { ok: true, task: updated ?? undefined };
}
```

- [ ] **Step 4: Write notifications.ts — stub for gateway notification**

```typescript
import { createLogger } from "@orc/core/logger";

const logger = createLogger("task-service:notify");

export async function notifyReview(taskId: string, title: string): Promise<void> {
  // TODO: Wire to gateway notification system in Wave 2
  logger.info(`Review notification: task ${taskId} "${title}" ready for review`);
}
```

- [ ] **Step 5: Write index.ts — public exports**

```typescript
export { updateTaskStatus, addTaskComment, type TransitionOpts, type TransitionResult } from "./transitions.js";
export { notifyReview } from "./notifications.js";
```

- [ ] **Step 6: Run bun install + typecheck**

Run: `bun install && bun typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/task-service/
git commit -m "feat: create @orc/task-service shared package"
```

---

### Task 4: Write Task Service Tests

**Files:**
- Create: `packages/task-service/src/__tests__/transitions.test.ts`

- [ ] **Step 1: Write tests for the task service**

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getDb, createTestDb, closeDb } from "@orc/db/client";
import { tasks, task_links, comments } from "@orc/db/schema";
import { eq } from "drizzle-orm";
import { updateTaskStatus, addTaskComment } from "../transitions.js";
import { ulid } from "@orc/core/ids";

beforeAll(() => {
  process.env.ORC_DB_PATH = ":memory:";
  createTestDb();
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
});

async function createTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const db = getDb();
  const id = ulid();
  const now = new Date();
  await db.insert(tasks).values({
    id, title: `Test task ${id.slice(-4)}`, status: "todo",
    priority: "normal", author: "agent", created_at: now, updated_at: now,
    ...overrides,
  });
  return id;
}

describe("updateTaskStatus", () => {
  test("transitions todo → doing", async () => {
    const id = await createTask();
    const result = await updateTaskStatus({ taskId: id, status: "doing" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("doing");
  });

  test("rejects invalid transition (todo → done)", async () => {
    const id = await createTask();
    const result = await updateTaskStatus({ taskId: id, status: "done" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Cannot transition");
  });

  test("adds comment on transition", async () => {
    const db = getDb();
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "doing", comment: "Starting work" });
    const rows = await db.query.comments.findMany({ where: eq(comments.resource_id, id) });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe("Starting work");
  });

  test("sets claimed_by on doing transition", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "doing", claimedBy: "session-123" });
    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBe("session-123");
  });

  test("sets claimed_by on queued transition", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "queued", claimedBy: "session-456" });
    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBe("session-456");
  });

  test("clears claimed_by on paused transition", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "doing", claimedBy: "s1" });
    await updateTaskStatus({ taskId: id, status: "paused" });
    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBeNull();
  });

  test("clears claimed_by on queued → todo fallback", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "queued", claimedBy: "s2" });
    await updateTaskStatus({ taskId: id, status: "todo" });
    const db = getDb();
    const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(task?.claimed_by).toBeNull();
  });

  test("rejects doing when blockers exist", async () => {
    const db = getDb();
    const blockerId = await createTask();
    const blockedId = await createTask();
    await db.insert(task_links).values({
      id: ulid(), from_task_id: blockerId, to_task_id: blockedId,
      link_type: "blocks", created_at: new Date(),
    });
    const result = await updateTaskStatus({ taskId: blockedId, status: "doing" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("blocked by");
  });

  test("unblocks dependents on done", async () => {
    const db = getDb();
    const blockerId = await createTask();
    const blockedId = await createTask({ status: "blocked" });
    await db.insert(task_links).values({
      id: ulid(), from_task_id: blockerId, to_task_id: blockedId,
      link_type: "blocks", created_at: new Date(),
    });
    await updateTaskStatus({ taskId: blockerId, status: "doing" });
    await updateTaskStatus({ taskId: blockerId, status: "review" });
    await updateTaskStatus({ taskId: blockerId, status: "done" });
    const blocked = await db.query.tasks.findFirst({ where: eq(tasks.id, blockedId) });
    expect(blocked?.status).toBe("todo");
  });

  test("queued → doing transition works", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "queued" });
    const result = await updateTaskStatus({ taskId: id, status: "doing" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("doing");
  });

  test("paused → todo re-enables pickup", async () => {
    const id = await createTask();
    await updateTaskStatus({ taskId: id, status: "doing" });
    await updateTaskStatus({ taskId: id, status: "paused" });
    const result = await updateTaskStatus({ taskId: id, status: "todo" });
    expect(result.ok).toBe(true);
    expect(result.task?.status).toBe("todo");
  });
});

describe("addTaskComment", () => {
  test("creates a comment on a task", async () => {
    const db = getDb();
    const id = await createTask();
    const commentId = await addTaskComment(id, "Test comment", "human");
    expect(commentId).toBeTruthy();
    const row = await db.query.comments.findFirst({ where: eq(comments.id, commentId) });
    expect(row?.content).toBe("Test comment");
    expect(row?.author).toBe("human");
    expect(row?.resource_type).toBe("task");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun test packages/task-service/src/__tests__/transitions.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add packages/task-service/src/__tests__/
git commit -m "test: add task service transition and comment tests"
```

---

### Task 5: Wire Task Service into MCP Tools

**Files:**
- Modify: `packages/mcp/src/tools.ts`
- Modify: `packages/mcp/package.json`

- [ ] **Step 1: Add dependencies**

Add `"@orc/task-service": "workspace:*"` to `packages/mcp/package.json`.

- [ ] **Step 2: Add imports at top of tools.ts**

```typescript
import { updateTaskStatus, addTaskComment } from "@orc/task-service";
import type { TaskStatus } from "@orc/core/types";
import { comments, prompts } from "@orc/db/schema";
```

- [ ] **Step 3: Replace task_update case with task service**

```typescript
case "task_update": {
  const { id, status, body, priority, comment } = args as {
    id: string; status?: string; body?: string; priority?: string; comment?: string;
  };
  if (body !== undefined || priority) {
    await db.update(tasks).set({
      ...(body !== undefined ? { body } : {}),
      ...(priority ? { priority: priority as "low" } : {}),
      updated_at: new Date(),
    }).where(eq(tasks.id, id));
  }
  if (status) {
    const result = await updateTaskStatus({
      taskId: id, status: status as TaskStatus, comment, author: "agent",
    });
    if (!result.ok) return result.error ?? "Transition failed";
  } else if (comment) {
    await addTaskComment(id, comment, "agent");
  }
  return `Updated: ${id}`;
}
```

- [ ] **Step 4: Add `comment` to task_update inputSchema**

- [ ] **Step 5: Add new fields to task_create inputSchema**

`prompt_id`, `required_review`, `agent_backend`, `max_review_rounds`, `tags`

- [ ] **Step 6: Pass new fields through in task_create case**

- [ ] **Step 7: Update task_batch_create similarly**

- [ ] **Step 8: Update task_list status filter enum**

Include `queued` and `paused`.

- [ ] **Step 9: Deprecate task_submit_review / task_check_review**

Add deprecation warning, redirect internally to `updateTaskStatus`.

- [ ] **Step 10: Run bun install + typecheck + test**

- [ ] **Step 11: Commit**

```bash
git add packages/mcp/src/tools.ts packages/mcp/package.json
git commit -m "feat: wire task service into MCP tools, add comment param, deprecate review tools"
```

---

### Task 6: Update API Routes for New Fields

**Files:**
- Modify: `packages/api/src/routes/tasks.ts`
- Modify: `packages/api/package.json`

- [ ] **Step 1: Add @orc/task-service dependency**
- [ ] **Step 2: Update CreateTaskSchema** — add `prompt_id`, `required_review`, `agent_backend`, `max_review_rounds`
- [ ] **Step 3: Update UpdateTaskSchema** — add `comment`
- [ ] **Step 4: Update TaskSchema (response)** — add new fields
- [ ] **Step 5: Update create handler** — pass new fields
- [ ] **Step 6: Update update handler** — use `updateTaskStatus()` / `addTaskComment()`
- [ ] **Step 7: Run tests** — `bun test packages/api/src/__tests__/tasks.test.ts`
- [ ] **Step 8: Commit**

---

### Task 7: Add Prompt MCP Tools

**Files:**
- Modify: `packages/mcp/src/tools.ts`

- [ ] **Step 1: Add prompt_list tool definition**

```typescript
{
  name: "prompt_list",
  description: "Discover available prompts and skills. Returns name + description for each.",
  inputSchema: z.object({
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    is_skill: z.boolean().optional().describe("Filter by skill flag"),
  }),
},
```

- [ ] **Step 2: Add prompt_get tool definition**

```typescript
{
  name: "prompt_get",
  description: "Load full prompt content by name or ID.",
  inputSchema: z.object({
    name: z.string().optional().describe("Prompt name"),
    id: z.string().optional().describe("Prompt ID (alternative to name)"),
  }),
},
```

- [ ] **Step 3: Implement prompt_list case**

- [ ] **Step 4: Implement prompt_get case** (use static `prompts` import, not dynamic)

- [ ] **Step 5: Run typecheck + test**

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools.ts
git commit -m "feat: add prompt_list and prompt_get MCP tools"
```

---

### Task 8: Seed Built-in Prompts

**Files:**
- Create: `packages/runner/src/seed-prompts.ts`
- Modify: `packages/api/src/server.ts`

- [ ] **Step 1: Write seed-prompts.ts with all 8 spec prompts**

Seeds: `orc-worker-base`, `orc-main-base`, `orc-coder`, `orc-planner`, `orc-reviewer`, `orc-requirements`, `orc-bugfix`, `orc-report`

Each has name, description, is_skill flag, tags, and template text. Skips if already exists.

- [ ] **Step 2: Call seedBuiltInPrompts from API server startup**

In `packages/api/src/server.ts`, import and call:

```typescript
import { seedBuiltInPrompts } from "@orc/runner/seed-prompts";
// After createApp:
seedBuiltInPrompts().catch(() => {});
```

**Why not in client.ts:** Avoids circular dependency `db → runner → db`.

- [ ] **Step 3: Run tests**
- [ ] **Step 4: Commit**

```bash
git add packages/runner/src/seed-prompts.ts packages/api/src/server.ts
git commit -m "feat: seed 8 built-in prompt templates on startup"
```

---

### Task 9: Add Agent Loop Config

**Files:**
- Modify: `packages/core/src/config.ts`

- [ ] **Step 1: Add agent_loop config section**

```typescript
agent_loop: z
  .object({
    enabled: z.boolean().default(false),
    poll_interval_minutes: z.number().int().min(1).default(5),
    max_workers: z.number().int().min(1).default(1),
    default_backend: z.enum(["claude", "codex", "cursor"]).default("claude"),
    session_idle_timeout_minutes: z.number().int().min(1).default(20),
  })
  .default({}),
```

- [ ] **Step 2: Add env var support in fromEnv()**
- [ ] **Step 3: Run typecheck**
- [ ] **Step 4: Commit**

---

### Task 10: Extract Agent Runtime Package

**Files:**
- Create: `packages/agent-runtime/{package.json,tsconfig.json,src/*.ts}`
- Modify: `packages/gateway/src/agent-runtime/*.ts` — each becomes thin re-export
- Modify: `packages/gateway/package.json`

- [ ] **Step 1: Create package.json** (version 0.1.6, dep on @orc/core)
- [ ] **Step 2: Create tsconfig.json**
- [ ] **Step 3: Copy types.ts, io.ts, registry.ts, claude.ts, codex.ts from gateway**
- [ ] **Step 4: Create index.ts with exports + side-effect imports for auto-registration**
- [ ] **Step 5: Replace each gateway agent-runtime file with thin re-export**

Each file re-exports from `@orc/agent-runtime`. This preserves relative imports in other gateway files.

- [ ] **Step 6: Add @orc/agent-runtime dep to gateway package.json**
- [ ] **Step 7: Run bun install + typecheck + test**
- [ ] **Step 8: Commit**

```bash
git add packages/agent-runtime/ packages/gateway/
git commit -m "refactor: extract @orc/agent-runtime as shared package"
```

---

### Task 11: Implement Task Loop

**Files:**
- Create: `packages/runner/src/task-loop.ts`
- Modify: `packages/runner/src/index.ts`
- Modify: `packages/runner/package.json`

- [ ] **Step 1: Add dependencies** (`@orc/agent-runtime`, `@orc/task-service`)

- [ ] **Step 2: Write task-loop.ts**

Key design decisions:
- Uses `__task-loop__` synthetic bridge_chat ID (created in Task 2 migration)
- Auto-approves all permission requests for workers (**Wave 1 limitation** — configurable in Wave 2)
- Queries `gateway_sessions` table directly for worker count (no cross-package import)
- `startFreshSession()` helper handles codex vs claude differences
- `spawnWorker()` claims task as `queued`, builds prompt (base + task-specific + context), spawns agent, transitions to `doing`
- `driveWorkerLoop()` runs in background, captures runtimeSessionId for resume
- `runCycle()`: health check → concurrency check → task pickup → spawn

Task pickup SQL:
```sql
SELECT t.* FROM tasks t
WHERE (t.status = 'todo' OR t.status = 'changes_requested')
  AND t.claimed_by IS NULL
  AND (t.prompt_id IS NOT NULL OR t.agent_backend IS NOT NULL
       OR EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE j.value = 'agent'))
  AND NOT EXISTS (
    SELECT 1 FROM task_links tl JOIN tasks blocker ON blocker.id = tl.from_task_id
    WHERE tl.to_task_id = t.id AND tl.link_type = 'blocks'
      AND blocker.status NOT IN ('done', 'cancelled')
  )
ORDER BY priority (critical=0, high=1, normal=2, low=3), created_at ASC
LIMIT 1
```

- [ ] **Step 3: Export from runner/index.ts**
- [ ] **Step 4: Run bun install + typecheck**
- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/task-loop.ts packages/runner/src/index.ts packages/runner/package.json
git commit -m "feat: implement task loop for automatic agent spawning"
```

---

### Task 12: Update Context Tool

**Files:**
- Modify: `packages/mcp/src/tools.ts`

- [ ] **Step 1: Add active worker count to context output**

Query `gateway_sessions` table directly (no cross-package import):

```typescript
const activeCount = sqlite
  .query("SELECT COUNT(*) as count FROM gateway_sessions WHERE role = 'worker' AND status = 'running'")
  .get() as { count: number } | null;
if (activeCount && activeCount.count > 0) {
  lines.push(`\n## Agent Loop: ${activeCount.count} active worker(s)`);
}
```

- [ ] **Step 2: Run test**
- [ ] **Step 3: Commit**

---

### Task 13: Wave 1 Integration Testing, AGENTS.md & PR

- [ ] **Step 1: Run `bun test`** — all pass
- [ ] **Step 2: Run `bun check`** — clean
- [ ] **Step 3: Run `bun typecheck`** — no errors

- [ ] **Step 4: Update AGENTS.md**

- Add `prompt_list`, `prompt_get` to MCP tools table
- Update task status flow with `queued`, `paused`
- Note deprecation of `task_submit_review`, `task_check_review`
- Document `agent_loop` config section

- [ ] **Step 5: Manual sanity — schema changes**

```bash
bun dev &
curl -s -X POST localhost:7700/tasks -H "Content-Type: application/json" \
  -d '{"title":"Agent task","tags":["agent"],"required_review":true,"agent_backend":"claude"}' | jq .
```

- [ ] **Step 6: Manual sanity — prompt discovery**

```bash
curl -s localhost:7700/prompts | jq '.[] | {name, description}'
```

- [ ] **Step 7: Manual sanity — full task lifecycle**

```bash
TASK=$(curl -s -X POST localhost:7700/tasks -H "Content-Type: application/json" -d '{"title":"Lifecycle test"}' | jq -r .id)
curl -s -X PATCH localhost:7700/tasks/$TASK -H "Content-Type: application/json" -d '{"status":"doing"}'
curl -s -X PATCH localhost:7700/tasks/$TASK -H "Content-Type: application/json" -d '{"status":"review"}'
curl -s -X PATCH localhost:7700/tasks/$TASK -H "Content-Type: application/json" -d '{"status":"done"}'
```

- [ ] **Step 8: Manual sanity — paused status + claimed_by clearing**

- [ ] **Step 9: Verify version alignment** — all package.json = `0.1.6`

- [ ] **Step 10: Create PR**

```bash
git push -u origin feat/agent-orchestration-wave1
gh pr create --title "feat: agent orchestration Wave 1 — core infrastructure" --body "..."
```

---

## Wave 2 — Session Resume & Review

> Branch: `feat/agent-orchestration-wave2` (off `master` after Wave 1 merges)

### Task 14: Session Resume Logic

- [ ] **Step 1:** Enhance resume: check session age, track attempts, log results
- [ ] **Step 2:** Manual test — changes_requested → loop resumes session
- [ ] **Step 3:** Commit

### Task 15: Agent Review Step

- [ ] **Step 1:** Add reviewer worker logic — pick up `review` tasks tagged `agent-review`
- [ ] **Step 2:** Spawn reviewer with `orc-reviewer` prompt
- [ ] **Step 3:** Test agent review → human review flow
- [ ] **Step 4:** Commit

### Task 16: max_review_rounds Tests

- [ ] **Step 1:** Write test for escalation to `paused` after N rounds
- [ ] **Step 2:** Verify existing logic
- [ ] **Step 3:** Commit

### Task 17: Gateway Review Notifications

- [ ] **Step 1:** Wire `notifyReview` to send Telegram/Slack cards with approve/reject buttons
- [ ] **Step 2:** Test via Telegram
- [ ] **Step 3:** Commit

### Task 18: Configurable Auto-Approve for Workers

- [ ] **Step 1:** Add `worker_auto_approve` to agent_loop config (default true)
- [ ] **Step 2:** Read config in driveWorkerLoop, conditionally approve or queue for human
- [ ] **Step 3:** Commit

### Task 19: Wave 2 Integration Testing & PR

- [ ] **Step 1:** `bun check && bun typecheck && bun test`
- [ ] **Step 2:** Manual e2e: create task → agent pickup → review → Telegram approve → done
- [ ] **Step 3:** Create PR

---

## Wave 3 — Channel, Polish & Multi-project

> Branch: `feat/agent-orchestration-wave3`

### Task 20: ORC Channel MCP Server

- [ ] **Step 1:** Create `packages/channel/` with `claude/channel` capability
- [ ] **Step 2:** Push notifications on task status changes
- [ ] **Step 3:** Add reply tool for approve/reject within CC
- [ ] **Step 4:** Register in `.mcp.json`
- [ ] **Step 5:** Test with `--dangerously-load-development-channels`
- [ ] **Step 6:** Commit

### Task 21: Per-project Concurrency

- [ ] **Step 1:** Add per-project config override
- [ ] **Step 2:** Modify task loop for per-project max_workers
- [ ] **Step 3:** Test with multiple projects
- [ ] **Step 4:** Commit

### Task 22: Remove Deprecated Review Tools

- [ ] **Step 1:** Remove `task_submit_review`/`task_check_review` from MCP
- [ ] **Step 2:** Remove `/tasks/{id}/review` API routes
- [ ] **Step 3:** Update tests
- [ ] **Step 4:** Commit

### Task 23: Wave 3 Final Validation & PR

- [ ] **Step 1:** `bun check && bun typecheck && bun test`
- [ ] **Step 2:** End-to-end with CC Channel
- [ ] **Step 3:** Create PR

---

## Validation Checklist (Every PR)

- [ ] `bun check` — no lint/format errors
- [ ] `bun typecheck` — no type errors
- [ ] `bun test` — all tests pass (91+ existing + new)
- [ ] Manual sanity: create task → agent pickup → review → approve
- [ ] Version alignment: all package.json = same version
- [ ] No breaking changes to existing MCP tools (deprecated ones still work)
- [ ] AGENTS.md updated

## Known Limitations (Wave 1)

- **Worker auto-approve:** All permission requests auto-approved. Configurable in Wave 2 (Task 18).
- **Global concurrency only:** `max_workers` is global. Per-project in Wave 3 (Task 21).
- **Gateway timeout not unified:** Gateway hardcodes 10min. Should read from config — deferred to Wave 2.
