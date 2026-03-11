import type { Database } from "bun:sqlite";
import { loadConfig } from "@orc/core/config";
import { ulid } from "@orc/core/ids";
import { getDb } from "@orc/db/client";
import { job_runs, jobs, memories, sessions, tasks } from "@orc/db/schema";
import { executeJob } from "@orc/runner/executor";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getLayer2, getLayer3, searchLayer1 } from "./search.js";

export const toolDefinitions = [
  {
    name: "memory_search",
    description:
      "Search memories (BM25 FTS5, porter stemming). Returns compact layer-1 index: IDs + snippets. " +
      "Use memory_timeline to get context around a result. Use memory_get for full content.",
    inputSchema: z.object({
      query: z.string().describe("Search query — keywords, phrases, or natural language"),
      scope: z.string().optional().describe("Scope filter (e.g. project name)"),
      limit: z.number().int().min(1).max(20).optional().default(10),
    }),
  },
  {
    name: "memory_timeline",
    description:
      "Get a memory plus chronological context around it (what was stored before/after). " +
      "Use after memory_search to understand surrounding context without fetching full content.",
    inputSchema: z.object({
      id: z.string().describe("Memory ID from memory_search results"),
      window: z.number().int().min(1).max(5).optional().default(3),
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
    description: "Store a fact, decision, or context entry for future retrieval via FTS5 search.",
    inputSchema: z.object({
      content: z.string().describe("Content to remember"),
      scope: z.string().optional().describe("Scope (e.g. project name)"),
      tags: z.array(z.string()).optional(),
      importance: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
    }),
  },
  {
    name: "task_list",
    description: "List active tasks — compact layer-1 index. Does NOT include body/notes.",
    inputSchema: z.object({
      project_id: z.string().optional(),
      status: z.enum(["todo", "doing", "review", "changes_requested", "blocked"]).optional(),
      limit: z.number().int().min(1).max(50).optional().default(20),
    }),
  },
  {
    name: "task_get",
    description: "Fetch full details of specific tasks by IDs (body, notes, full history).",
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
      project_id: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
      author: z.string().optional().default("agent"),
    }),
  },
  {
    name: "task_update",
    description: "Update task status, priority, or body.",
    inputSchema: z.object({
      id: z.string(),
      status: z
        .enum(["todo", "doing", "review", "changes_requested", "blocked", "done", "cancelled"])
        .optional(),
      body: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    }),
  },
  {
    name: "task_submit_review",
    description:
      "Submit task for human review (HITL checkpoint). Sets status=review, sends Telegram card if configured.",
    inputSchema: z.object({
      id: z.string(),
      summary: z.string().describe("Summary of work done for the reviewer"),
    }),
  },
  {
    name: "task_check_review",
    description: "Poll HITL review result. Returns: pending | approved | changes_requested + note.",
    inputSchema: z.object({
      id: z.string(),
    }),
  },
  {
    name: "job_list",
    description: "List all jobs with last run status.",
    inputSchema: z.object({
      limit: z.number().int().optional().default(20),
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
    name: "context_layer1",
    description:
      "Compact context index — active tasks + recent memories. ~200 tokens. Call at session start. " +
      "Use task_get or memory_get to drill into specific items.",
    inputSchema: z.object({
      project_id: z.string().optional(),
    }),
  },
  {
    name: "session_event",
    description:
      "Record a session event (file edit, decision, error, git op) for continuity across compaction.",
    inputSchema: z.object({
      type: z.enum(["file", "task", "decision", "error", "git", "env", "intent"]),
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
    description: "Log a session summary after completing a unit of work.",
    inputSchema: z.object({
      agent: z.string(),
      summary: z.string(),
      project_id: z.string().optional(),
    }),
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];

export async function executeTool(name: ToolName, args: unknown): Promise<string> {
  const db = getDb();

  switch (name) {
    case "memory_search": {
      const { query, scope, limit } = args as { query: string; scope?: string; limit?: number };
      const results = searchLayer1(query, scope, limit);
      if (results.length === 0) return "No memories found.";
      const lines = [`Found ${results.length} results (BM25 ranked):`];
      for (const m of results) {
        lines.push(`[${m.rank}] ${m.id}  "${m.snippet}"  scope:${m.scope ?? "—"}  ${m.age}`);
      }
      lines.push("\nUse memory_timeline(id) for context, memory_get([ids]) for full content.");
      return lines.join("\n");
    }

    case "memory_timeline": {
      const { id, window } = args as { id: string; window?: number };
      const result = getLayer2(id, window);
      if (!result) return `Memory not found: ${id}`;
      const lines = ["## Timeline Context", ""];
      if (result.before.length) {
        lines.push("Before:");
        for (const m of result.before.reverse())
          lines.push(`  · [${m.id}] ${m.snippet} (${m.age})`);
        lines.push("");
      }
      lines.push(`▶ [${result.id}] ${result.full_content}`);
      if (result.after.length) {
        lines.push("");
        lines.push("After:");
        for (const m of result.after) lines.push(`  · [${m.id}] ${m.snippet} (${m.age})`);
      }
      return lines.join("\n");
    }

    case "memory_get": {
      const { ids } = args as { ids: string[] };
      const results = getLayer3(ids);
      if (results.length === 0) return "No memories found.";
      return results.map((m) => `[${m.id}] (${m.importance})\n${m.content}`).join("\n\n---\n\n");
    }

    case "memory_store": {
      const { content, scope, tags, importance } = args as {
        content: string;
        scope?: string;
        tags?: string[];
        importance?: string;
      };
      const id = ulid();
      const now = new Date();
      await db.insert(memories).values({
        id,
        content,
        scope,
        tags,
        importance: (importance ?? "normal") as "low" | "normal" | "high" | "critical",
        created_at: now,
        updated_at: now,
      });
      return `Stored: ${id}`;
    }

    case "task_list": {
      const { project_id, status, limit } = args as {
        project_id?: string;
        status?: string;
        limit?: number;
      };
      const rows = await db.query.tasks.findMany({
        limit: limit ?? 20,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filtered = rows.filter((t) => {
        if (["done", "cancelled"].includes(t.status)) return false;
        if (project_id && t.project_id !== project_id) return false;
        if (status && t.status !== status) return false;
        return true;
      });
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
        .map((t) => `[${t!.id}] ${t!.status} — ${t!.title}\n${t!.body ?? ""}`)
        .join("\n\n");
    }

    case "task_create": {
      const { title, body, project_id, priority, author } = args as {
        title: string;
        body?: string;
        project_id?: string;
        priority?: string;
        author?: string;
      };
      const id = ulid();
      const now = new Date();
      await db.insert(tasks).values({
        id,
        title,
        body,
        project_id,
        priority: (priority ?? "normal") as "low" | "normal" | "high" | "critical",
        author: author ?? "agent",
        status: "todo",
        created_at: now,
        updated_at: now,
      });
      return `Created: ${id} — ${title}`;
    }

    case "task_update": {
      const { id, status, body, priority } = args as {
        id: string;
        status?: string;
        body?: string;
        priority?: string;
      };
      await db
        .update(tasks)
        .set({
          ...(status ? { status: status as "todo" } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(priority ? { priority: priority as "low" } : {}),
          updated_at: new Date(),
        })
        .where(eq(tasks.id, id));
      return `Updated: ${id}`;
    }

    case "task_submit_review": {
      const { id, summary } = args as { id: string; summary: string };
      await db
        .update(tasks)
        .set({ status: "review", body: summary, updated_at: new Date() })
        .where(eq(tasks.id, id));
      return `Task ${id} in review. Reviewer notified if bridge configured.`;
    }

    case "task_check_review": {
      const { id } = args as { id: string };
      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
      if (!task) return `Task not found: ${id}`;
      return JSON.stringify({ status: task.status, title: task.title });
    }

    case "job_list": {
      const { limit } = args as { limit?: number };
      const rows = await db.query.jobs.findMany({ limit: limit ?? 20 });
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

    case "context_layer1": {
      const { project_id } = args as { project_id?: string };
      const config = loadConfig();
      const taskLimit = config.context.layer1_task_limit;
      const memLimit = config.context.layer1_memory_limit;

      const activeTasks = await db.query.tasks.findMany({
        limit: taskLimit,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filtered = activeTasks.filter(
        (t) =>
          !["done", "cancelled"].includes(t.status) && (!project_id || t.project_id === project_id),
      );

      const recentMems = await db.query.memories.findMany({
        limit: memLimit,
        orderBy: (m, { desc }) => [desc(m.created_at)],
      });

      const lastSession = await db.query.sessions.findFirst({
        orderBy: [desc(sessions.created_at)],
      });

      const lines = ["## Active Tasks"];
      if (filtered.length === 0) lines.push("  (none)");
      for (const t of filtered) {
        lines.push(`  [${t.id.slice(-6)}] ${t.status.padEnd(10)} ${t.title}`);
      }

      lines.push("\n## Recent Memory");
      if (recentMems.length === 0) lines.push("  (none)");
      for (const m of recentMems) {
        lines.push(`  [${m.id.slice(-6)}] ${m.content.slice(0, 70)} (${timeAgo(m.created_at)})`);
      }

      if (lastSession?.summary) {
        lines.push(`\n## Last Session (${lastSession.agent})`);
        lines.push(`  ${lastSession.summary}`);
      }

      lines.push("\nUse task_get([ids]) or memory_get([ids]) for full content.");
      return lines.join("\n");
    }

    case "session_event": {
      const { type, priority, data } = args as {
        type: string;
        priority?: number;
        data: Record<string, string>;
      };
      const sqlite = (db as unknown as { $client: Database }).$client;
      const id = ulid();
      const sessionId = process.env.ORC_SESSION_ID ?? "default";
      sqlite
        .query(
          "INSERT INTO session_events(id, session_id, type, priority, data) VALUES (?,?,?,?,?)",
        )
        .run(id, sessionId, type, priority ?? 3, JSON.stringify(data));
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
      const filtered = activeTasks.filter((t) => !["done", "cancelled"].includes(t.status));

      const sqlite = (db as unknown as { $client: Database }).$client;

      const events = sqlite
        .query(
          "SELECT type, priority, data FROM session_events WHERE session_id = ? ORDER BY priority ASC, created_at DESC LIMIT 50",
        )
        .all(sid) as Array<{ type: string; priority: number; data: string }>;

      const xml = buildSnapshot(filtered, events, maxBytes);

      const snapId = ulid();
      sqlite
        .query("INSERT INTO session_snapshots(id, session_id, xml) VALUES (?,?,?)")
        .run(snapId, sid, xml);

      return xml;
    }

    case "session_restore": {
      const { session_id } = args as { session_id?: string };
      const sid = session_id ?? process.env.ORC_SESSION_ID ?? "default";
      const sqlite = (db as unknown as { $client: Database }).$client;

      const snap = sqlite
        .query(
          "SELECT xml FROM session_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(sid) as { xml: string } | null;

      if (!snap) return "No session snapshot found. Starting fresh.";
      return `## Session Restored\n\n${snap.xml}`;
    }

    case "session_log": {
      const { agent, summary, project_id } = args as {
        agent: string;
        summary: string;
        project_id?: string;
      };
      const id = ulid();
      await db.insert(sessions).values({ id, agent, summary, project_id, created_at: new Date() });
      return `Session logged: ${id}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

type TaskRow = { id: string; title: string; status: string; priority: string };
type EventRow = { type: string; priority: number; data: string };

function buildSnapshot(tasks: TaskRow[], events: EventRow[], maxBytes: number): string {
  const taskXml = tasks
    .map(
      (t) =>
        `  <task id="${t.id.slice(-6)}" status="${t.status}" priority="${t.priority}">${escapeXml(t.title)}</task>`,
    )
    .join("\n");

  const grouped: Record<string, string[]> = {};
  for (const e of events) {
    if (!grouped[e.type]) grouped[e.type] = [];
    try {
      const d = JSON.parse(e.data) as Record<string, string>;
      grouped[e.type]?.push(
        Object.entries(d)
          .map(([k, v]) => `${k}=${v}`)
          .join(" "),
      );
    } catch {
      grouped[e.type]?.push(e.data);
    }
  }

  const eventXml = Object.entries(grouped)
    .map(
      ([type, items]) =>
        `  <${type}s>${items
          .slice(0, 5)
          .map((i) => `<item>${escapeXml(i)}</item>`)
          .join("")}</${type}s>`,
    )
    .join("\n");

  const xml = `<session>\n<tasks>\n${taskXml}\n</tasks>\n<events>\n${eventXml}\n</events>\n</session>`;

  if (Buffer.byteLength(xml) <= maxBytes) return xml;

  const compact = `<session>\n<tasks>\n${taskXml}\n</tasks>\n</session>`;
  return compact;
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
