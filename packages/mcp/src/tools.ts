import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
      "Search memories (3-layer BM25: porter → trigram → fallback). Returns compact index: IDs + snippets. " +
      "Filter by type (fact|decision|event|rule|discovery) or scope. Use memory_timeline for context, memory_get for full content.",
    inputSchema: z.object({
      query: z.string().describe("Search query — keywords, phrases, or natural language"),
      scope: z.string().optional().describe("Scope filter (e.g. project name)"),
      type: z
        .enum(["fact", "decision", "event", "rule", "discovery"])
        .optional()
        .describe("Filter by memory type"),
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
    description:
      "Store a fact, decision, or context entry. Use type to classify: " +
      "'decision' for choices made, 'rule' for conventions/constraints, 'discovery' for findings, " +
      "'event' for things that happened, 'fact' for general knowledge.",
    inputSchema: z.object({
      content: z.string().describe("Content to remember"),
      title: z.string().optional().describe("Short label (≤60 chars) for quick scanning"),
      type: z.enum(["fact", "decision", "event", "rule", "discovery"]).optional().default("fact"),
      scope: z.string().optional().describe("Scope (e.g. project name)"),
      tags: z.array(z.string()).optional(),
      importance: z.enum(["low", "normal", "high", "critical"]).optional().default("normal"),
    }),
  },
  {
    name: "memory_delete",
    description: "Delete a memory by ID. Irreversible.",
    inputSchema: z.object({
      id: z.string().describe("Memory ID to delete"),
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
    name: "context",
    description:
      "Compact context index — active tasks + important memories. ~200 tokens. Call at session start. " +
      "Use task_get or memory_get to drill into specific items.",
    inputSchema: z.object({
      project_id: z.string().optional(),
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
      project_id: z.string().optional(),
    }),
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];

export async function executeTool(name: ToolName, args: unknown): Promise<string> {
  const db = getDb();

  switch (name) {
    case "memory_search": {
      const { query, scope, type, limit } = args as {
        query: string;
        scope?: string;
        type?: "fact" | "decision" | "event" | "rule" | "discovery";
        limit?: number;
      };
      const results = searchLayer1(query, scope, limit, type);
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
      const titlePart = result.title ? ` "${result.title}"` : "";
      lines.push(`▶ [${result.id}]${titlePart} [${result.type}]\n${result.full_content}`);
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
      const { content, title, type, scope, tags, importance } = args as {
        content: string;
        title?: string;
        type?: string;
        scope?: string;
        tags?: string[];
        importance?: string;
      };
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
        created_at: now,
        updated_at: now,
      });
      const label = title ? ` "${title}"` : "";
      return `Stored: ${id}${label} [${type ?? "fact"}]`;
    }

    case "memory_delete": {
      const { id } = args as { id: string };
      const existing = await db.query.memories.findFirst({ where: eq(memories.id, id) });
      if (!existing) return `Memory not found: ${id}`;
      await db.delete(memories).where(eq(memories.id, id));
      return `Deleted: ${id}`;
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
        .map((t) => `[${t?.id}] ${t?.status} — ${t?.title}\n${t?.body ?? ""}`)
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

    case "context": {
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

      const allMems = await db.query.memories.findMany({
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

      const lines = ["## Active Tasks"];
      if (filtered.length === 0) lines.push("  (none)");
      for (const t of filtered) {
        lines.push(`  [${t.id.slice(-6)}] ${t.status.padEnd(10)} ${t.title}`);
      }

      lines.push("\n## Key Memory");
      if (recentMems.length === 0) lines.push("  (none)");
      for (const m of recentMems) {
        const typeLabel = m.type !== "fact" ? ` [${m.type}]` : "";
        const label = m.title ? ` "${m.title}"` : "";
        lines.push(
          `  [${m.id.slice(-6)}]${typeLabel}${label} ${m.content.slice(0, 60)} (${timeAgo(m.created_at)})`,
        );
      }

      if (lastSession?.summary) {
        lines.push(`\n## Last Session (${lastSession.agent})`);
        lines.push(`  ${lastSession.summary}`);
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
      const sqlite = getSqlite(db);
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

      const sqlite = getSqlite(db);

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
      const sqlite = getSqlite(db);

      const snap = sqlite
        .query<{ xml: string }, string>(
          "SELECT xml FROM session_snapshots WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(sid);

      if (!snap) return "No session snapshot found. Starting fresh.";
      return `## Session Restored\n\n${snap.xml}`;
    }

    case "session_log": {
      const { agent, agent_version, summary, session_id, project_id } = args as {
        agent: string;
        agent_version?: string;
        summary: string;
        session_id?: string;
        project_id?: string;
      };

      const sid = session_id ?? process.env.ORC_SESSION_ID ?? "default";
      const jobRunId = process.env.ORC_JOB_RUN_ID;
      const sqlite = getSqlite(db);

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
        project_id,
        job_run_id: jobRunId,
        created_at: new Date(),
      });
      return `Session logged: ${id}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

function getSqlite(db: ReturnType<typeof getDb>): Database {
  return (db as unknown as { $client: Database }).$client;
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
