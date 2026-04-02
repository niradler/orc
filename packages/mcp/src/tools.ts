import { createHash } from "node:crypto";
import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import type { TaskStatus } from "@orc/core/types";
import { getDb, getSqlite } from "@orc/db/client";
import {
  comments,
  job_runs,
  jobs,
  memories,
  projects,
  prompts,
  sessions,
  tasks,
} from "@orc/db/schema";
import { executeJob } from "@orc/runner/executor";
import { addTaskComment, updateTaskStatus } from "@orc/task-service";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getLayer3, searchLayer1 } from "./search.js";

const projectParam = z
  .string()
  .optional()
  .describe("Project name (e.g. 'orc'). Defaults to activeProject from config if not set.");

export const toolDefinitions = [
  {
    name: "memory_search",
    description:
      "Search memories (3-layer BM25: porter → trigram → fallback). Returns compact index: IDs + snippets. " +
      "Filter by type (fact|decision|event|rule|discovery) or scope. Use memory_get for full content.",
    inputSchema: z.object({
      query: z.string().describe("Search query — keywords, phrases, or natural language"),
      scope: z.string().optional().describe("Scope filter (e.g. domain area)"),
      type: z
        .enum(["fact", "decision", "event", "rule", "discovery"])
        .optional()
        .describe("Filter by memory type"),
      project: projectParam,
      limit: z.number().int().min(1).max(20).optional().default(10),
    }),
  },
  {
    name: "memory_get",
    description:
      "Fetch full content of specific memories by IDs. Always batch multiple IDs in one call. " +
      "~10x more token-expensive than memory_search — only call after filtering by ID.",
    inputSchema: z.object({
      ids: z.array(z.string()).min(1).max(20).describe("Memory IDs to fetch"),
    }),
  },
  {
    name: "memory_store",
    description:
      "Store a fact, decision, or context entry. Use type to classify: " +
      "'decision' for choices made, 'rule' for conventions/constraints, 'discovery' for findings, " +
      "'event' for things that happened, 'fact' for general knowledge.",
    inputSchema: z.object({
      content: z.string().describe("Content to remember"),
      title: z.string().optional().describe("Short label (≤60 chars) for quick scanning"),
      type: z.enum(["fact", "decision", "event", "rule", "discovery"]).optional().default("fact"),
      scope: z.string().optional().describe("Scope (e.g. domain area)"),
      tags: z.array(z.string()).optional(),
      importance: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
      project: projectParam,
    }),
  },
  {
    name: "task_list",
    description: "List active tasks — compact layer-1 index. Does NOT include body/comments.",
    inputSchema: z.object({
      project: projectParam,
      status: z
        .enum(["todo", "queued", "doing", "review", "changes_requested", "blocked", "paused"])
        .optional(),
      limit: z.number().int().min(1).max(50).optional().default(20),
    }),
  },
  {
    name: "task_get",
    description: "Fetch full details of specific tasks by IDs (body, comments, full history).",
    inputSchema: z.object({
      ids: z.array(z.string()).min(1).max(10),
    }),
  },
  {
    name: "task_create",
    description: "Create a new task.",
    inputSchema: z.object({
      title: z.string(),
      body: z.string().optional(),
      project: projectParam,
      priority: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
      author: z.string().optional().default("agent"),
      tags: z.array(z.string()).optional(),
      prompt_id: z.string().optional().describe("Prompt template to use for agent execution"),
      required_review: z
        .boolean()
        .optional()
        .default(true)
        .describe("Require human review before done"),
      agent_backend: z
        .string()
        .optional()
        .describe("Agent backend for task execution (e.g. claude, codex, gemini, a2a)"),
      max_review_rounds: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(3)
        .describe("Max review iterations before pausing"),
    }),
  },
  {
    name: "task_update",
    description:
      "Update task status, priority, body, or add a comment. Status transitions are validated.",
    inputSchema: z.object({
      id: z.string(),
      status: z
        .enum([
          "todo",
          "queued",
          "doing",
          "review",
          "changes_requested",
          "blocked",
          "done",
          "paused",
          "cancelled",
        ])
        .optional(),
      body: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      comment: z.string().optional().describe("Add a comment to the task"),
      agent_backend: z
        .string()
        .optional()
        .describe("Agent backend for task execution (e.g. claude, acpx, a2a, gemini)"),
    }),
  },
  {
    name: "task_batch_create",
    description:
      "Create multiple tasks with dependency links atomically. Use for PRD-to-task workflows. " +
      "Each task has a 'ref' (temporary ID like 'T1') used to express dependencies between tasks in the batch.",
    inputSchema: z.object({
      tasks: z
        .array(
          z.object({
            ref: z.string().describe("Temporary reference ID, e.g. 'T1'"),
            title: z.string(),
            body: z.string().optional(),
            priority: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
            tags: z.array(z.string()).optional(),
            prompt_id: z.string().optional(),
            required_review: z.boolean().optional().default(true),
            agent_backend: z.string().optional(),
            max_review_rounds: z.number().int().min(1).optional().default(3),
            depends_on: z
              .array(z.string())
              .optional()
              .describe("Refs of tasks that block this one"),
            subtask_of: z.string().optional().describe("Ref of parent task"),
          }),
        )
        .min(1)
        .max(100),
      project: projectParam,
      author: z.string().optional().default("agent"),
    }),
  },
  {
    name: "search",
    description:
      "Unified search across tasks and memories. Returns mixed results with resource_type indicator. " +
      "Use instead of separate memory_search + task_search calls.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      resources: z
        .array(z.enum(["tasks", "memories"]))
        .optional()
        .default(["tasks", "memories"]),
      project: projectParam,
      limit: z.number().int().min(1).max(20).optional().default(10),
    }),
  },
  {
    name: "job_list",
    description: "List all jobs with last run status.",
    inputSchema: z.object({
      limit: z.number().int().optional().default(20),
      project: projectParam,
    }),
  },
  {
    name: "job_run",
    description: "Trigger a job by name.",
    inputSchema: z.object({
      name: z.string(),
    }),
  },
  {
    name: "job_status",
    description: "Get run status + exit code + error for a specific run ID.",
    inputSchema: z.object({
      run_id: z.string(),
    }),
  },
  {
    name: "context",
    description:
      "Compact context index — active tasks + important memories. ~200 tokens. Call at session start. " +
      "Pass project name to scope, or omit to use activeProject from config. " +
      "Use task_get or memory_get to drill into specific items.",
    inputSchema: z.object({
      project: projectParam,
    }),
  },
  {
    name: "session_event",
    description:
      "Record a session event (file edit, decision, error, git op) for continuity across compaction. " +
      "Duplicate events are silently deduped. Priority: 1=critical (file/task/rule), 2=high (git/env/error/decision), 3=normal, 4=low.",
    inputSchema: z.object({
      session_id: z.string().optional(),
      type: z.enum([
        "file",
        "task",
        "decision",
        "error",
        "git",
        "env",
        "intent",
        "rule",
        "plan",
        "subagent",
      ]),
      priority: z.number().int().min(1).max(4).optional().default(3),
      data: z.record(z.string()).describe("Event payload — tool, path, content, etc."),
    }),
  },
  {
    name: "session_snapshot",
    description:
      "Build ≤2KB XML snapshot of current session state. Call from PreCompact hook before context window compacts.",
    inputSchema: z.object({
      session_id: z.string().optional(),
    }),
  },
  {
    name: "session_restore",
    description:
      "Restore session state after compaction or agent restart. Returns structured Session Guide.",
    inputSchema: z.object({
      session_id: z.string().optional(),
    }),
  },
  {
    name: "session_log",
    description:
      "Log a session summary after completing a unit of work. " +
      "Auto-derives touched files, task changes, and stored memories from session events.",
    inputSchema: z.object({
      agent: z.string(),
      agent_version: z.string().optional().describe("Agent version string, e.g. 'claude-code/1.x'"),
      summary: z.string(),
      session_id: z.string().optional(),
      project: projectParam,
    }),
  },
  {
    name: "project_list",
    description: "List all projects. Returns name, status, and description for each.",
    inputSchema: z.object({
      status: z.enum(["active", "archived", "paused"]).optional(),
    }),
  },
  {
    name: "prompt_list",
    description: "Discover available prompts and skills. Returns name + description for each.",
    inputSchema: z.object({
      tags: z.array(z.string()).optional().describe("Filter by tags"),
      is_skill: z.boolean().optional().describe("Filter by skill flag"),
    }),
  },
  {
    name: "prompt_get",
    description: "Load full prompt content by name or ID.",
    inputSchema: z.object({
      name: z.string().optional().describe("Prompt name"),
      id: z.string().optional().describe("Prompt ID (alternative to name)"),
    }),
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];

function resolveProjectId(projectName?: string): { id: string; name: string } | null {
  const name = projectName || loadConfig().activeProject;
  if (!name) return null;
  const sqlite = getSqlite();
  const row = sqlite
    .query<{ id: string; name: string }, string>(
      "SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE LIMIT 1",
    )
    .get(name);
  return row ?? null;
}

export async function executeTool(name: ToolName, args: unknown): Promise<string> {
  const db = getDb();

  switch (name) {
    case "memory_search": {
      const { query, scope, type, limit, project } = args as {
        query: string;
        scope?: string;
        type?: "fact" | "decision" | "event" | "rule" | "discovery";
        limit?: number;
        project?: string;
      };
      const resolved = resolveProjectId(project);
      const results = searchLayer1(query, scope, limit, type, resolved?.id);
      if (results.length === 0) return "No memories found.";
      const lines = [`Found ${results.length} results:`];
      for (const m of results) {
        const typeLabel = m.type !== "fact" ? ` [${m.type}]` : "";
        lines.push(
          `[${m.rank}] ${m.id}${typeLabel}  "${m.snippet}"  scope:${m.scope ?? "—"}  ${m.age}  (${m.matchLayer})`,
        );
      }
      lines.push("\nUse memory_timeline(id) for context, memory_get([ids]) for full content.");
      return lines.join("\n");
    }

    case "memory_get": {
      const { ids } = args as { ids: string[] };
      const results = getLayer3(ids);
      if (results.length === 0) return "No memories found.";
      return results
        .map((m) => {
          const header = m.title
            ? `[${m.id}] [${m.type}] "${m.title}" (${m.importance})`
            : `[${m.id}] [${m.type}] (${m.importance})`;
          return `${header}\n${m.content}`;
        })
        .join("\n\n---\n\n");
    }

    case "memory_store": {
      const { content, title, type, scope, tags, importance, project } = args as {
        content: string;
        title?: string;
        type?: string;
        scope?: string;
        tags?: string[];
        importance?: string;
        project?: string;
      };
      const resolved = resolveProjectId(project);
      const id = ulid();
      const now = new Date();
      await db.insert(memories).values({
        id,
        title,
        type: (type ?? "fact") as "fact" | "decision" | "event" | "rule" | "discovery",
        content,
        scope,
        tags,
        importance: (importance ?? "normal") as "low" | "normal" | "high" | "critical",
        project_id: resolved?.id,
        created_at: now,
        updated_at: now,
      });
      const label = title ? ` "${title}"` : "";
      const proj = resolved ? ` (${resolved.name})` : "";
      return `Stored: ${id}${label} [${type ?? "fact"}]${proj}`;
    }

    case "task_list": {
      const { project, status, limit } = args as {
        project?: string;
        status?: string;
        limit?: number;
      };
      const resolved = resolveProjectId(project);
      const conditions = [];
      if (status) {
        conditions.push(eq(tasks.status, status as "todo"));
      }
      if (resolved) {
        conditions.push(eq(tasks.project_id, resolved.id));
      }
      const rows = await db.query.tasks.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        limit: limit ?? 20,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filtered = status
        ? rows
        : rows.filter((t) => !["done", "cancelled"].includes(t.status));
      if (filtered.length === 0) return "No active tasks.";
      return filtered
        .map((t) => `[${t.id}] ${t.status.padEnd(18)} ${t.priority.padEnd(8)} ${t.title}`)
        .join("\n");
    }

    case "task_get": {
      const { ids } = args as { ids: string[] };
      const rows = await Promise.all(
        ids.map((id) => db.query.tasks.findFirst({ where: eq(tasks.id, id) })),
      );
      return rows
        .filter(Boolean)
        .map((t) => `[${t?.id}] ${t?.status} — ${t?.title}\n${t?.body ?? ""}`)
        .join("\n\n");
    }

    case "task_create": {
      const {
        title,
        body,
        project,
        priority,
        author,
        tags,
        prompt_id,
        required_review,
        agent_backend,
        max_review_rounds,
      } = args as {
        title: string;
        body?: string;
        project?: string;
        priority?: string;
        author?: string;
        tags?: string[];
        prompt_id?: string;
        required_review?: boolean;
        agent_backend?: string;
        max_review_rounds?: number;
      };
      const resolved = resolveProjectId(project);
      const id = ulid();
      const now = new Date();
      await db.insert(tasks).values({
        id,
        title,
        body,
        project_id: resolved?.id,
        priority: (priority ?? "normal") as "low" | "normal" | "high" | "critical",
        author: author ?? "agent",
        status: "todo",
        tags,
        prompt_id,
        required_review: required_review ?? true,
        agent_backend: agent_backend as string | undefined,
        max_review_rounds: max_review_rounds ?? 3,
        created_at: now,
        updated_at: now,
      });
      const proj = resolved ? ` (${resolved.name})` : "";
      import("@orc/runner/task-loop")
        .then((m) => m.triggerTaskCheck())
        .catch(() => {});
      return `Created: ${id} — ${title}${proj}`;
    }

    case "task_update": {
      const { id, status, body, priority, comment, agent_backend } = args as {
        id: string;
        status?: string;
        body?: string;
        priority?: string;
        comment?: string;
        agent_backend?: string;
      };
      if (status) {
        const result = await updateTaskStatus({
          taskId: id,
          status: status as TaskStatus,
          comment,
          author: "agent",
        });
        if (!result.ok) return result.error ?? "Transition failed";
      } else if (comment) {
        await addTaskComment(id, comment, "agent");
      }
      if (body !== undefined || priority || agent_backend !== undefined) {
        await db
          .update(tasks)
          .set({
            ...(body !== undefined ? { body } : {}),
            ...(priority ? { priority: priority as "low" } : {}),
            ...(agent_backend !== undefined ? { agent_backend } : {}),
            updated_at: new Date(),
          })
          .where(eq(tasks.id, id));
      }
      return `Updated: ${id}`;
    }

    case "job_list": {
      const { limit, project } = args as { limit?: number; project?: string };
      const resolved = resolveProjectId(project);
      const conditions = resolved ? [eq(jobs.project_id, resolved.id)] : [];
      const rows = await db.query.jobs.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        limit: limit ?? 20,
      });
      if (rows.length === 0) return "No jobs defined.";
      return rows
        .map(
          (j) =>
            `${j.enabled ? "●" : "○"} ${j.name.padEnd(24)} ${j.trigger_type.padEnd(12)} runs:${j.run_count}`,
        )
        .join("\n");
    }

    case "job_run": {
      const { name } = args as { name: string };
      const job = await db.query.jobs.findFirst({ where: eq(jobs.name, name) });
      if (!job) return `Job not found: ${name}`;
      const runId = ulid();
      await db.insert(job_runs).values({
        id: runId,
        job_id: job.id,
        status: "pending",
        trigger_by: "mcp",
        created_at: new Date(),
      });
      executeJob({ jobId: job.id, runId, triggerBy: "mcp" }).catch(() => {});
      return `Triggered: ${name} → run_id: ${runId}`;
    }

    case "job_status": {
      const { run_id } = args as { run_id: string };
      const run = await db.query.job_runs.findFirst({ where: eq(job_runs.id, run_id) });
      if (!run) return `Run not found: ${run_id}`;
      return JSON.stringify({ status: run.status, exit_code: run.exit_code, error: run.error_msg });
    }

    case "context": {
      const { project } = args as { project?: string };
      const config = loadConfig();
      const taskLimit = config.context.layer1_task_limit;
      const memLimit = config.context.layer1_memory_limit;
      const resolved = resolveProjectId(project);

      const taskConditions = [];
      if (resolved) taskConditions.push(eq(tasks.project_id, resolved.id));
      const activeTasks = await db.query.tasks.findMany({
        where: taskConditions.length > 0 ? and(...taskConditions) : undefined,
        limit: taskLimit,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filtered = activeTasks.filter((t) => !["done", "cancelled"].includes(t.status));

      const memConditions = [];
      if (resolved) memConditions.push(eq(memories.project_id, resolved.id));
      const allMems = await db.query.memories.findMany({
        where: memConditions.length > 0 ? and(...memConditions) : undefined,
        limit: memLimit * 3,
        orderBy: (m, { desc }) => [desc(m.created_at)],
      });

      const importanceWeight: Record<string, number> = {
        critical: 4,
        high: 3,
        normal: 2,
        low: 1,
      };

      const typeWeight: Record<string, number> = {
        rule: 3,
        decision: 3,
        discovery: 2,
        fact: 1,
        event: 1,
      };

      const nowMs = Date.now();
      const scored = allMems.map((m) => {
        const ageHours = (nowMs - m.created_at.getTime()) / 3_600_000;
        const recency = Math.max(0, 1 - ageHours / (24 * 30));
        const score =
          (importanceWeight[m.importance] ?? 1) * 2 +
          (typeWeight[m.type ?? "fact"] ?? 1) +
          recency * 2;
        return { m, score };
      });

      scored.sort((a, b) => b.score - a.score);
      const recentMems = scored.slice(0, memLimit).map((s) => s.m);

      const lastSession = await db.query.sessions.findFirst({
        orderBy: [desc(sessions.created_at)],
      });

      const lines: string[] = [];
      if (resolved) {
        lines.push(`## Project: ${resolved.name}`);
      }

      lines.push(resolved ? "\n## Active Tasks" : "## Active Tasks");
      if (filtered.length === 0) lines.push("  (none)");
      for (const t of filtered) {
        lines.push(`  [${t.id}] ${t.status.padEnd(10)} ${t.title}`);
      }

      lines.push("\n## Key Memory");
      if (recentMems.length === 0) lines.push("  (none)");
      for (const m of recentMems) {
        const typeLabel = m.type !== "fact" ? ` [${m.type}]` : "";
        const label = m.title ? ` "${m.title}"` : "";
        lines.push(
          `  [${m.id}]${typeLabel}${label} ${m.content.slice(0, 60)} (${timeAgo(m.created_at)})`,
        );
      }

      if (lastSession?.summary) {
        lines.push(`\n## Last Session (${lastSession.agent})`);
        lines.push(`  ${lastSession.summary}`);
      }

      const sqlite = getSqlite();
      const activeCount = sqlite
        .query(
          "SELECT COUNT(*) as count FROM gateway_sessions WHERE role = 'worker' AND status = 'running'",
        )
        .get() as { count: number } | null;
      if (activeCount && activeCount.count > 0) {
        lines.push(`\n## Agent Loop: ${activeCount.count} active worker(s)`);
      }

      lines.push("\nUse task_get([ids]) or memory_get([ids]) for full content.");
      return lines.join("\n");
    }

    case "session_event": {
      const { session_id, type, priority, data } = args as {
        session_id?: string;
        type: string;
        priority?: number;
        data: Record<string, string>;
      };
      const sqlite = getSqlite();
      const sid = session_id ?? process.env.ORC_SESSION_ID ?? "default";
      const dataJson = JSON.stringify(data);
      const dataHash = createHash("sha256").update(dataJson).digest("hex").slice(0, 16);

      type EventHashRow = { data_hash: string };
      const recent = sqlite
        .query<EventHashRow, [string, string, number]>(
          `SELECT data_hash FROM session_events
           WHERE session_id = ? AND type = ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(sid, type, 5);

      if (recent.some((r) => r.data_hash === dataHash)) {
        return "Duplicate event skipped.";
      }

      type CountRow = { n: number };
      const { n } = sqlite
        .query<CountRow, string>("SELECT COUNT(*) as n FROM session_events WHERE session_id = ?")
        .get(sid) ?? { n: 0 };

      if (n >= 1000) {
        sqlite
          .query(
            `DELETE FROM session_events WHERE id = (
               SELECT id FROM session_events WHERE session_id = ?
               ORDER BY priority ASC, created_at ASC LIMIT 1
             )`,
          )
          .run(sid);
      }

      const id = ulid();
      sqlite
        .query(
          "INSERT INTO session_events(id, session_id, type, priority, data, data_hash) VALUES (?,?,?,?,?,?)",
        )
        .run(id, sid, type, priority ?? 3, dataJson, dataHash);
      return `Event recorded: ${id}`;
    }

    case "session_snapshot": {
      const { session_id } = args as { session_id?: string };
      const config = loadConfig();
      const maxBytes = config.context.snapshot_max_bytes;
      const sid = session_id ?? process.env.ORC_SESSION_ID ?? "default";

      const activeTasks = await db.query.tasks.findMany({
        limit: 10,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filteredTasks = activeTasks.filter((t) => !["done", "cancelled"].includes(t.status));

      const sqlite = getSqlite();

      type EventRow = { type: string; priority: number; data: string; data_hash?: string };
      const events = sqlite
        .query<EventRow, string>(
          `SELECT type, priority, data FROM session_events
           WHERE session_id = ?
           ORDER BY priority ASC, created_at DESC LIMIT 100`,
        )
        .all(sid);

      const xml = buildSnapshot(filteredTasks, events, maxBytes);

      const snapId = ulid();
      sqlite
        .query("INSERT INTO session_snapshots(id, session_id, xml) VALUES (?,?,?)")
        .run(snapId, sid, xml);

      return xml;
    }

    case "session_restore": {
      const { session_id } = args as { session_id?: string };
      const sid = session_id ?? process.env.ORC_SESSION_ID ?? "default";
      const sqlite = getSqlite();

      const snap = sqlite
        .query<{ xml: string }, string>(
          "SELECT xml FROM session_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(sid);

      if (!snap) return "No session snapshot found. Starting fresh.";
      return `## Session Restored\n\n${snap.xml}`;
    }

    case "session_log": {
      const { agent, agent_version, summary, session_id, project } = args as {
        agent: string;
        agent_version?: string;
        summary: string;
        session_id?: string;
        project?: string;
      };

      const resolved = resolveProjectId(project);
      const sid = session_id ?? process.env.ORC_SESSION_ID ?? "default";
      const jobRunId = process.env.ORC_JOB_RUN_ID;
      const sqlite = getSqlite();

      type EventRow = { type: string; data: string };
      const events = sqlite
        .query<EventRow, string>(
          "SELECT type, data FROM session_events WHERE session_id = ? ORDER BY created_at ASC",
        )
        .all(sid);

      const files = new Set<string>();
      const taskIds = new Set<string>();
      const memoryIds = new Set<string>();

      for (const e of events) {
        try {
          const d = JSON.parse(e.data) as Record<string, string>;
          if (e.type === "file" && d.path) files.add(d.path);
          if (e.type === "task" && d.id) taskIds.add(d.id);
          if (e.type === "memory" && d.id) memoryIds.add(d.id);
        } catch {}
      }

      const parts = [summary];
      if (files.size > 0) parts.push(`Files: ${[...files].join(", ")}`);
      if (taskIds.size > 0) parts.push(`Tasks: ${[...taskIds].join(", ")}`);
      if (memoryIds.size > 0) parts.push(`Memories: ${[...memoryIds].join(", ")}`);

      const richSummary = parts.join("\n");
      const id = ulid();
      await db.insert(sessions).values({
        id,
        agent,
        agent_version,
        summary: richSummary,
        project_id: resolved?.id,
        job_run_id: jobRunId,
        created_at: new Date(),
      });
      return `Session logged: ${id}`;
    }

    case "project_list": {
      const { status } = args as { status?: string };
      const conditions = status
        ? [eq(projects.status, status as "active" | "archived" | "paused")]
        : [];
      const rows = await db.query.projects.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: (p, { asc }) => [asc(p.name)],
      });
      if (rows.length === 0) return "No projects found.";
      return rows
        .map((p) => {
          const desc = p.description ? `  ${p.description.slice(0, 60)}` : "";
          return `${p.name.padEnd(24)} ${p.status}${desc}`;
        })
        .join("\n");
    }

    case "task_batch_create": {
      const {
        tasks: items,
        project,
        author,
      } = args as {
        tasks: {
          ref: string;
          title: string;
          body?: string;
          priority?: string;
          tags?: string[];
          prompt_id?: string;
          required_review?: boolean;
          agent_backend?: string;
          max_review_rounds?: number;
          depends_on?: string[];
          subtask_of?: string;
        }[];
        project?: string;
        author?: string;
      };
      const resolved = resolveProjectId(project);
      const now = new Date();
      const mapping: Record<string, string> = {};

      for (const item of items) {
        const id = ulid();
        mapping[item.ref] = id;
        await db.insert(tasks).values({
          id,
          title: item.title,
          body: item.body,
          project_id: resolved?.id,
          priority: (item.priority ?? "normal") as "low" | "normal" | "high" | "critical",
          author: author ?? "agent",
          status: "todo",
          tags: item.tags,
          prompt_id: item.prompt_id,
          required_review: item.required_review ?? true,
          agent_backend: item.agent_backend as string | undefined,
          max_review_rounds: item.max_review_rounds ?? 3,
          created_at: now,
          updated_at: now,
        });
      }

      const sqlite = getSqlite();
      for (const item of items) {
        const taskId = mapping[item.ref] as string;
        if (item.depends_on) {
          for (const dep of item.depends_on) {
            const blockerId = mapping[dep];
            if (!blockerId) continue;
            sqlite
              .query(
                "INSERT INTO task_links (id, from_task_id, to_task_id, link_type, created_at) VALUES (?, ?, ?, 'blocks', unixepoch())",
              )
              .run(ulid(), blockerId, taskId);
          }
        }
        if (item.subtask_of) {
          const parentId = mapping[item.subtask_of];
          if (parentId) {
            sqlite
              .query(
                "INSERT INTO task_links (id, from_task_id, to_task_id, link_type, created_at) VALUES (?, ?, ?, 'subtask_of', unixepoch())",
              )
              .run(ulid(), taskId, parentId);
            sqlite
              .query(
                "INSERT INTO task_links (id, from_task_id, to_task_id, link_type, created_at) VALUES (?, ?, ?, 'parent_of', unixepoch())",
              )
              .run(ulid(), parentId, taskId);
          }
        }
      }

      const lines = items.map((item) => `  ${item.ref} → ${mapping[item.ref]} — ${item.title}`);
      import("@orc/runner/task-loop")
        .then((m) => m.triggerTaskCheck())
        .catch(() => {});
      return `Created ${items.length} tasks:\n${lines.join("\n")}`;
    }

    case "search": {
      const { query, resources, project, limit } = args as {
        query: string;
        resources?: string[];
        project?: string;
        limit?: number;
      };
      const resolved = resolveProjectId(project);
      const lim = limit ?? 10;
      const parts: string[] = [];

      if (!resources || resources.includes("memories")) {
        const memResults = searchLayer1(
          query,
          undefined,
          Math.ceil(lim / 2),
          undefined,
          resolved?.id,
        );
        if (memResults.length > 0) {
          parts.push("## Memories");
          for (const m of memResults) {
            parts.push(`  [memory] ${m.id} [${m.type}] ${m.snippet} (${m.age})`);
          }
        }
      }

      if (!resources || resources.includes("tasks")) {
        const sqlite = getSqlite();
        const words = query
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 0);
        const taskLim = Math.ceil(lim / 2);
        let taskRows: { id: string; title: string; status: string }[] = [];

        if (words.length > 0) {
          try {
            const ftsExpr = words.join(" AND ");
            let sql = `SELECT t.id, t.title, t.status FROM tasks_fts f JOIN tasks t ON t.id = f.id WHERE f.tasks_fts MATCH ?`;
            const params: (string | number)[] = [ftsExpr];
            if (resolved) {
              sql += " AND t.project_id = ?";
              params.push(resolved.id);
            }
            sql += " ORDER BY rank LIMIT ?";
            params.push(taskLim);
            taskRows = sqlite.query(sql).all(...params) as typeof taskRows;
          } catch {
            const likeSql = `SELECT id, title, status FROM tasks WHERE (title LIKE ? OR body LIKE ?)${resolved ? " AND project_id = ?" : ""} ORDER BY updated_at DESC LIMIT ?`;
            const likeParams: (string | number)[] = [`%${query}%`, `%${query}%`];
            if (resolved) likeParams.push(resolved.id);
            likeParams.push(taskLim);
            taskRows = sqlite.query(likeSql).all(...likeParams) as typeof taskRows;
          }
        }

        if (taskRows.length > 0) {
          parts.push("## Tasks");
          for (const t of taskRows) {
            parts.push(`  [task] ${t.id} ${t.status} — ${t.title}`);
          }
        }
      }

      return parts.length > 0 ? parts.join("\n") : "No results found.";
    }

    case "prompt_list": {
      const { tags, is_skill } = args as { tags?: string[]; is_skill?: boolean };
      const conditions = [];
      if (is_skill !== undefined) conditions.push(eq(prompts.is_skill, is_skill));
      const rows = await db.query.prompts.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: (p, { asc }) => [asc(p.name)],
      });
      let filtered = rows;
      if (tags && tags.length > 0) {
        filtered = rows.filter((p) => {
          const pTags = p.tags ?? [];
          return tags.some((t) => pTags.includes(t));
        });
      }
      if (filtered.length === 0) return "No prompts found.";
      return filtered
        .map((p) => {
          const skill = p.is_skill ? " [skill]" : "";
          const desc = p.description ? ` — ${p.description.slice(0, 60)}` : "";
          return `${p.name.padEnd(28)}${skill}${desc}`;
        })
        .join("\n");
    }

    case "prompt_get": {
      const { name: pName, id: pId } = args as { name?: string; id?: string };
      let row: typeof prompts.$inferSelect | undefined;
      if (pId) {
        row = await db.query.prompts.findFirst({ where: eq(prompts.id, pId) });
      } else if (pName) {
        row = await db.query.prompts.findFirst({ where: eq(prompts.name, pName) });
      } else {
        return "Provide either name or id.";
      }
      if (!row) return `Prompt not found: ${pName ?? pId}`;
      return `# ${row.name}\n${row.description ?? ""}\n\n${row.template}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

type TaskRow = { id: string; title: string; status: string; priority: string };
type EventRow = { type: string; priority: number; data: string };

const P1_TYPES = new Set(["file", "task", "rule"]);
const P2_TYPES = new Set(["decision", "git", "env", "error", "plan"]);

function buildSnapshot(tasks: TaskRow[], events: EventRow[], maxBytes: number): string {
  const taskXml = tasks
    .map(
      (t) =>
        `  <task id="${t.id.slice(-6)}" status="${t.status}" priority="${t.priority}">${escapeXml(t.title)}</task>`,
    )
    .join("\n");

  const p1Events = events.filter((e) => P1_TYPES.has(e.type));
  const p2Events = events.filter((e) => P2_TYPES.has(e.type));
  const p3Events = events.filter((e) => !P1_TYPES.has(e.type) && !P2_TYPES.has(e.type));

  function renderEvents(evs: EventRow[], max = 5): string {
    const grouped: Record<string, string[]> = {};
    for (const e of evs.slice(0, max * 3)) {
      if (!grouped[e.type]) grouped[e.type] = [];
      const items = grouped[e.type] ?? [];
      if (items.length >= max) continue;
      try {
        const d = JSON.parse(e.data) as Record<string, string>;
        items.push(
          Object.entries(d)
            .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
            .join(" "),
        );
      } catch {
        items.push(String(e.data).slice(0, 120));
      }
    }
    return Object.entries(grouped)
      .map(
        ([type, items]) =>
          `  <${type}s>${items.map((i) => `<item>${escapeXml(i)}</item>`).join("")}</${type}s>`,
      )
      .join("\n");
  }

  function assemble(includeP2: boolean, includeP3: boolean): string {
    const parts = [`<tasks>\n${taskXml}\n</tasks>`];
    const p1Xml = renderEvents(p1Events);
    if (p1Xml) parts.push(`<context priority="high">\n${p1Xml}\n</context>`);
    if (includeP2) {
      const p2Xml = renderEvents(p2Events);
      if (p2Xml) parts.push(`<context priority="normal">\n${p2Xml}\n</context>`);
    }
    if (includeP3) {
      const p3Xml = renderEvents(p3Events, 3);
      if (p3Xml) parts.push(`<context priority="low">\n${p3Xml}\n</context>`);
    }
    return `<session>\n${parts.join("\n")}\n</session>`;
  }

  const tiers: Array<[boolean, boolean]> = [
    [true, true],
    [true, false],
    [false, false],
  ];

  for (const [incP2, incP3] of tiers) {
    const xml = assemble(incP2, incP3);
    if (Buffer.byteLength(xml) <= maxBytes) return xml;
  }

  return `<session>\n<tasks>\n${taskXml}\n</tasks>\n</session>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
