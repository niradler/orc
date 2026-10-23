import { createHash } from "node:crypto";
import { createAgent, discoverAgents, readAgent } from "@orc/core/agent-service";
import { loadConfig } from "@orc/core/config";
import { NotFoundError, ValidationError } from "@orc/core/errors";
import { shortId, ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import {
  createPackage,
  listPackages,
  readPackage,
  readPackageFile,
} from "@orc/core/package-service";
import { ArchiveSearchSchema, SessionSyncInputSchema } from "@orc/core/session-archive";
import { SessionHandoffInputSchema, SessionHandoffUploadSchema } from "@orc/core/session-handoff";
import { type SkillDownload, SkillDownloadSchema } from "@orc/core/skill-download";
import {
  createSkill as createSkillFs,
  type SkillFileInput,
  type SkillFull,
  type SkillRefContent,
  skillValidationIssues,
  skillWarnings,
} from "@orc/core/skill-service";
import { SkillUpdateSchema } from "@orc/core/skill-update";
import type { TaskStatus } from "@orc/core/types";
import { AgentBackendSchema } from "@orc/core/types";
import { AuditLog } from "@orc/db/audit";
import { getDb, getSqlite } from "@orc/db/client";
import { KbDigestStore } from "@orc/db/kb-digest";
import {
  MEMORY_DESCRIPTION_MAX,
  MEMORY_PRIORITY_MAX,
  type MemoryListItem,
  type MemoryListSort,
  MemoryStore,
} from "@orc/db/memories";
import { job_runs, jobs, projects, sessions, tasks } from "@orc/db/schema";
import { SkillHistory, type SkillListSort } from "@orc/db/skill-history";
import { executeJob } from "@orc/runner/executor";
import { addTaskComment, updateTaskStatus } from "@orc/task-service";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { orcApi } from "./api-client.js";
import { executeKbTool, isKbTool, kbSearchLines, kbToolDefinitions } from "./kb-tools.js";

const logger = createLogger("mcp:tools");
const SKILL_LIST_LIMIT = 30;
const MEMORY_LIST_LIMIT = 30;

const projectParam = z
  .string()
  .optional()
  .describe("Project name (e.g. 'orc'). Defaults to activeProject from config if not set.");
const memoryNameParam = z.string().min(1).max(64).describe("Memory name, e.g. 'api-port'");
const memoryPriorityParam = z
  .number()
  .int()
  .min(0)
  .max(MEMORY_PRIORITY_MAX)
  .nullable()
  .optional()
  .describe("0-100: how important and broadly relevant; higher loads first in context");
const scopedProjectParams = z.object({
  project: projectParam,
  project_id: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Explicit project ID; null selects unassigned. Takes precedence over project/default.",
    ),
});

const scopeParams = z.object({ project: projectParam, scope: z.literal("global").optional() });
const auditParams = scopeParams.extend({
  entity_type: z.enum(["memory", "skill", "kb"]).optional(),
  session_id: z.string().min(1).max(200).optional(),
  since: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const skillUpdateParams = SkillUpdateSchema.omit({ project_id: true })
  .extend(scopeParams.shape)
  .strict();
const skillHistoryParams = scopeParams.extend({ name: z.string().min(1).max(200) });
const skillRevertParams = skillHistoryParams.extend({
  change_id: z.string().min(1),
  expected_change_id: z.string().min(1),
  reason: z.string().trim().min(1).max(2000),
});
const digestCompleteParams = z
  .object({
    token: z.string().uuid(),
    outcome: z.enum(["applied", "no_change"]),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export const toolDefinitions = [
  {
    name: "skill_update",
    description:
      "Update effective SKILL.md instructions from verified lessons. Read current raw SKILL.md first and pass expected_content. Changes are audited with history; supporting authored files stay intact. Normal skill_read returns the edited version in scope.",
    inputSchema: skillUpdateParams,
  },
  {
    name: "skill_history",
    description: "Read instruction change history, including prior raw content for manual revert.",
    inputSchema: skillHistoryParams,
  },
  {
    name: "skill_revert",
    description:
      "Manually revert a skill change. Pin expected_change_id from the current mutation and give a reason.",
    inputSchema: skillRevertParams,
  },
  {
    name: "digest_complete",
    description:
      "Finish an assigned knowledge base digest run after handling its open comments and new input. Pass the assigned token; this records the run and advances what the next run looks at. Never call for unrelated work.",
    inputSchema: digestCompleteParams,
  },
  {
    name: "audit_list",
    description:
      "Review central knowledge audit entries, optionally by session_id. Removed memories survive in snapshot; result_ids identify replacements. Use with the delivery section of orc-sdlc references/review-and-delivery.md.",
    inputSchema: auditParams,
  },
  {
    name: "session_handoff",
    description:
      "Move a Claude Code or Codex session to ORC. FIRST commit and push the intended changes within the user's Git authorization. Report the pushed repository, branch and exact commit SHA, project name, source cwd and native session ID. Returns a single-use upload URL for native session files. Upload through HTTP; then use Sessions → Open in terminal. See orc-platform references/execution.md.",
    inputSchema: SessionHandoffInputSchema,
  },
  {
    name: "session_search",
    description:
      "Search archived and indexed coding-session passages. Returns bounded evidence with session:<id>@<revision>#<ordinal> citations, not entire histories. Optional embeddings use Settings; keyword search remains available. Sync local files with the trusted orc-platform scripts/sync-sessions.py, following references/session-archive.md.",
    inputSchema: ArchiveSearchSchema.omit({ project_id: true }).extend({ project: projectParam }),
  },
  {
    name: "session_sync",
    description:
      "Request a one-hour, project-scoped upload capability for local Claude/Codex session sync. Use when the user asks to upload local project/all-agent histories to ORC. Pass projects for that requested scope; omit for all existing projects. Download trusted orc-platform scripts/sync-sessions.py via skill_read download:true and run according to references/session-archive.md and --help. Pass returned grant privately via --grant-stdin/--grant-file, never URL/token argv or printed output. This only authorizes archival upload/deduplication, not transcript reads or terminal launch.",
    inputSchema: SessionSyncInputSchema,
  },
  {
    name: "session_read",
    description:
      "Read a cited archived-session passage, or a bounded page of conversation turns. Pin the revision from session_search for stable evidence after more messages arrive.",
    inputSchema: z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        revision: z.number().int().min(1).optional(),
        ordinal: z.number().int().min(0).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(30),
      })
      .strict(),
  },
  {
    name: "memory_list",
    description:
      "List this project's memories (name, description, priority, reads). Defaults to the 30 most read; " +
      "q searches name and description. Read one with memory_read. Memories are short project facts; " +
      "procedures and long guidance are skills.",
    inputSchema: z.object({
      q: z.string().optional().describe("Search name and description"),
      sort: z
        .enum(["reads", "recent", "priority"])
        .optional()
        .describe(
          "reads (default): most read; recent: last read or updated; priority: highest first",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(`Max memories to return (default ${MEMORY_LIST_LIMIT})`),
      project: projectParam,
    }),
  },
  {
    name: "memory_read",
    description: "Read a memory by name. Counts a read, which ranks the memory higher in lists.",
    inputSchema: z.object({ name: memoryNameParam, project: projectParam }),
  },
  {
    name: "memory_create",
    description:
      "Save a short project fact worth knowing next session: a name (lowercase-hyphenated, unique in " +
      "the project), a description (≤300 chars) saying when it matters, and content (≤800 chars by default). " +
      "Longer guidance or a procedure belongs in a skill (skill_create). Check memory_list first and " +
      "memory_update an existing memory instead of creating a near-duplicate.",
    inputSchema: z.object({
      name: memoryNameParam,
      description: z
        .string()
        .min(1)
        .max(MEMORY_DESCRIPTION_MAX)
        .describe("When this memory matters"),
      content: z.string().min(1).describe("The fact itself"),
      priority: memoryPriorityParam,
      project: projectParam,
    }),
  },
  {
    name: "memory_update",
    description:
      "Update a memory's description, content or priority. Only the fields you pass change; " +
      "priority null clears the score. The previous state stays in memory_history.",
    inputSchema: z.object({
      name: memoryNameParam,
      description: z.string().min(1).max(MEMORY_DESCRIPTION_MAX).optional(),
      content: z.string().min(1).optional(),
      priority: memoryPriorityParam,
      reason: z.string().max(2000).optional().describe("Why it changed"),
      project: projectParam,
    }),
  },
  {
    name: "memory_delete",
    description: "Delete a memory that is wrong or no longer useful. memory_revert can restore it.",
    inputSchema: z.object({
      name: memoryNameParam,
      reason: z.string().max(2000).optional(),
      project: projectParam,
    }),
  },
  {
    name: "memory_history",
    description: "Changes to a memory, newest first, with the state before and after each change.",
    inputSchema: z.object({ name: memoryNameParam, project: projectParam }),
  },
  {
    name: "memory_revert",
    description:
      "Restore the state from before a change (reverting a creation deletes the memory). " +
      "expected_change_id must be the latest change from memory_history.",
    inputSchema: z.object({
      name: memoryNameParam,
      change_id: z.string().min(1),
      expected_change_id: z.string().min(1),
      reason: z.string().trim().min(1).max(2000),
      project: projectParam,
    }),
  },
  {
    name: "task_list",
    description: "List active tasks - compact layer-1 index. Does NOT include body/comments.",
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
    description: "Fetch current task details by IDs (title, status, progress and body).",
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
      skill_name: z
        .string()
        .optional()
        .describe("Skill to use for agent execution (e.g. orc-sdlc)"),
      required_review: z
        .boolean()
        .optional()
        .default(true)
        .describe("Require human review before done"),
      agent_backend: AgentBackendSchema.optional().describe(
        "Agent backend for task execution (e.g. claude, codex, gemini, a2a)",
      ),
      agent_model: z
        .string()
        .optional()
        .describe("Model override for the agent (e.g. gpt-5.4, o3-mini)"),
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
      progress: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Observed task progress, from 0 to 100"),
      agent_backend: AgentBackendSchema.optional().describe(
        "Agent backend for task execution (e.g. claude, acpx, a2a, gemini)",
      ),
      agent_model: z
        .string()
        .optional()
        .describe("Model override for the agent (e.g. gpt-5.4, o3-mini)"),
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
            skill_name: z.string().optional().describe("Skill for agent execution"),
            required_review: z.boolean().optional().default(true),
            agent_backend: AgentBackendSchema.optional(),
            agent_model: z.string().optional().describe("Model override for the agent"),
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
      "Ordinary search: knowledge base documents first, then memories and tasks. Read full documents with kb_read.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      resources: z
        .array(z.enum(["knowledge", "tasks", "memories"]))
        .optional()
        .default(["knowledge", "tasks", "memories"]),
      project: projectParam,
      limit: z.number().int().min(1).max(20).optional().default(10),
    }),
  },
  ...kbToolDefinitions,
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
      "Compact context index - active tasks + the project's memories by priority. Call at session start. " +
      "Pass project name or explicit project_id (null selects unassigned) to scope, or omit to use activeProject from config. " +
      "Use task_get or memory_read to drill into specific items.",
    inputSchema: scopedProjectParams,
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
      data: z.record(z.string(), z.string()).describe("Event payload - tool, path, content, etc."),
    }),
  },
  {
    name: "session_snapshot",
    description:
      "Build ≤2KB XML snapshot of current session state. Call from PreCompact hook before context window compacts.",
    inputSchema: z.object({
      session_id: z.string().optional(),
      project_id: z.string().min(1).nullable().optional(),
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
    name: "skill_list",
    description:
      "List installed skills (built-in + user) with name, description and read count. " +
      "Defaults to the 30 most-read skills; use q for full-text search across all skills. " +
      "Hidden built-ins are omitted; named reads and authored overrides remain available.",
    inputSchema: z.object({
      q: z.string().optional().describe("Full-text search on name and description"),
      source: z.enum(["builtin", "user"]).optional().describe("Filter by source"),
      sort: z
        .enum(["reads", "recent"])
        .optional()
        .describe("reads (default): most read first; recent: last read, updated or created first"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(`Max skills to return (default ${SKILL_LIST_LIMIT})`),
      reload: z.boolean().optional().describe("Force cache rebuild"),
      project: projectParam,
      scope: z.literal("global").optional(),
    }),
  },
  {
    name: "skill_read",
    description:
      "Read a skill by name. Returns SKILL.md instructions and an inventory of supporting files. " +
      "Pass ref with a skill-relative path to load supporting files. For scripts/assets use download:true with ref to get a signed ten-minute URL and SHA-256 instead of reconstructing file content. Downloading never executes scripts.",
    inputSchema: z.object({
      name: z.string().describe("Skill name"),
      project: projectParam,
      scope: z.literal("global").optional(),
      download: z
        .boolean()
        .optional()
        .describe("With ref, return a signed download URL instead of file content"),
      ref: z
        .string()
        .optional()
        .describe(
          "Skill-relative file path, e.g. scripts/check.py or references/guide.md. Bare filenames read references/.",
        ),
    }),
  },
  {
    name: "skill_create",
    description:
      "Create a user skill folder with SKILL.md and optional Markdown, scripts, templates and assets in ~/.orc/skills/<name>/.",
    inputSchema: z.object({
      name: z.string().describe("Skill name (used as directory name)"),
      content: z.string().describe("Full SKILL.md content including frontmatter"),
      files: z
        .array(
          z.object({
            path: z.string().describe("Path relative to the skill root"),
            content: z.string(),
            encoding: z.enum(["utf8", "base64"]).optional(),
          }),
        )
        .max(512)
        .optional(),
    }),
  },
  {
    name: "agent_list",
    description:
      "Discover shared APM .agent.md profiles usable across coding backends. Includes malformed definitions with validation errors.",
    inputSchema: z.object({}),
  },
  {
    name: "agent_read",
    description:
      "Read a shared APM agent profile: original YAML/Markdown, role, model, tools and handoffs. A profile is separate from its execution backend.",
    inputSchema: z.object({
      id: z.string().describe("Agent ID from agent_list, including package prefix when present"),
    }),
  },
  {
    name: "agent_create",
    description:
      "Create a shared, validated APM .agent.md definition available to every connected coding agent.",
    inputSchema: z.object({
      id: z.string(),
      content: z.string().describe("Original .agent.md including YAML frontmatter"),
    }),
  },
  {
    name: "agent_package_list",
    description: "List shared OpenAPM and Agent Plugins packages and their source formats.",
    inputSchema: z.object({}),
  },
  {
    name: "agent_package_read",
    description:
      "Read the original package manifest and file inventory, or one package-relative resource with ref. Binary resources return base64.",
    inputSchema: z.object({ name: z.string(), ref: z.string().optional() }),
  },
  {
    name: "agent_package_import",
    description:
      "Import an intact OpenAPM or portable Agent Plugins package. Preserves original manifests, resources and relative links. OpenAPM primitives are validated; portable plugin skill failures are isolated during discovery. Does not execute scripts or resolve dependencies.",
    inputSchema: z.object({
      name: z.string(),
      content: z.string().describe("Original apm.yml or plugin.json"),
      format: z.enum(["apm", "agent-plugin"]).optional(),
      files: z
        .array(
          z.object({
            path: z.string(),
            content: z.string(),
            encoding: z.enum(["utf8", "base64"]).optional(),
          }),
        )
        .max(512),
    }),
  },
  {
    name: "flow_report",
    description:
      "Report your outcome as a flow node. Call this when your node's work is done — it is what routes " +
      "the flow to the next node. Only the outcomes your node declares are accepted (your prompt lists them). " +
      "Pass vars when the flow's routing needs values from you.",
    inputSchema: z.object({
      task: z.string().describe("Task ID you are working on"),
      outcome: z.string().describe("One of the outcomes your node prompt listed"),
      node: z
        .string()
        .optional()
        .describe("Your node id — required when several nodes are active on this task"),
      summary: z
        .string()
        .optional()
        .describe("What you did or found. Recorded in the ledger for later nodes to read."),
      vars: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Values the flow's edges route on (e.g. { security_ok: false })"),
    }),
  },
  {
    name: "flow_status",
    description:
      "Inspect a task's flow run: which nodes are active, the ledger of node outcomes so far, " +
      "visit counts, and why it halted if it did.",
    inputSchema: z.object({
      task: z.string().describe("Task ID"),
    }),
  },
  {
    name: "flow_list",
    description:
      "List available flow graphs (built-in + user). A flow defines the nodes, conditional edges and loops " +
      "a task runs through. Use flow_read for the full definition.",
    inputSchema: z.object({
      q: z.string().optional().describe("Keyword search on name and description"),
      source: z.enum(["builtin", "user", "project"]).optional(),
    }),
  },
  {
    name: "flow_read",
    description: "Read a flow definition by name — its nodes, edges, limits and entry point.",
    inputSchema: z.object({
      name: z.string().describe("Flow name (e.g. 'orc-default')"),
    }),
  },
  {
    name: "flow_create",
    description:
      "Create a reusable user flow from a JSON definition. Written to ~/.orc/flows/<name>/flow.json. " +
      "Validated before it is saved: unknown edge targets, unreachable nodes, a flow that can never finish, " +
      "or a terminal with outgoing edges are all rejected. For a one-off graph use flow_attach with a definition instead.",
    inputSchema: z.object({
      definition: z
        .record(z.string(), z.unknown())
        .describe("Full flow definition: { name, description, entry, limits, nodes, edges }"),
      overwrite: z.boolean().optional().describe("Replace an existing user flow of the same name"),
      shadow_builtin: z
        .boolean()
        .optional()
        .describe(
          "Deliberately shadow a built-in flow of the same name. Without this, reusing a builtin's name is rejected — " +
            "shadowing orc-default silently re-pipelines every task.",
        ),
    }),
  },
  {
    name: "flow_attach",
    description:
      "Attach a flow to a task: either a named flow, or an inline definition for a bespoke graph for this " +
      "task alone. Use this to build a custom multi-node pipeline per task. Takes effect on the task's next " +
      "flow run — pass start:true to begin immediately.",
    inputSchema: z.object({
      task: z.string().describe("Task ID"),
      name: z.string().optional().describe("Named flow to attach"),
      definition: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Inline flow definition for this task only. Takes precedence over name."),
      start: z.boolean().optional().describe("Start the flow now instead of waiting for the loop"),
    }),
  },
] as const;

export type ToolName = (typeof toolDefinitions)[number]["name"];

export type ToolOptions = {
  publicApiBaseUrl?: string;
  skillDownload?: (name: string, ref: string, projectId: string | null) => SkillDownload;
  /**
   * Native session id of the calling agent. Stdio MCP runs inside the agent's process tree and
   * reads it from the environment; HTTP MCP cannot see it, so it stays unset there.
   */
  agentSessionId?: string | null;
};

/** The agent session that launched this process, when the agent exposes it. */
export function agentSessionFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ORC_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || null;
}

function memoryWriter(options: ToolOptions): { author: string; session_id: string | null } {
  return {
    author: [process.env.ORC_AGENT, process.env.CLAUDE_MODEL].filter(Boolean).join("/") || "agent",
    session_id: options.agentSessionId ?? null,
  };
}

/** Memories belong to a project; there is no global memory. */
function memoryProject(project: string | undefined): string {
  const resolved = resolveProjectId(project);
  if (!resolved)
    throw new ValidationError(
      "Memories belong to a project: pass project or set activeProject in ORC config",
    );
  return resolved.id;
}

function formatMemoryLine(memory: MemoryListItem): string {
  const priority = memory.priority === null ? "" : ` [p${memory.priority}]`;
  const reads = ` (${memory.read_count} ${memory.read_count === 1 ? "read" : "reads"})`;
  return `${memory.name.padEnd(28)}${priority}${reads} - ${memory.description}`;
}
function resolveProjectId(projectName?: string): { id: string; name: string } | null {
  const name = projectName || loadConfig().activeProject;
  if (!name) return null;
  const sqlite = getSqlite();
  const row = sqlite
    .query<{ id: string; name: string }, string>(
      "SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE LIMIT 1",
    )
    .get(name);
  if (!row) throw new NotFoundError("Project", name);
  return row;
}

function resolveScope(input: z.infer<typeof scopeParams>): string | null {
  return input.scope === "global" ? null : (resolveProjectId(input.project)?.id ?? null);
}

function resolveScopedProject(input: z.infer<typeof scopedProjectParams>): string | null {
  if (input.project_id !== undefined) {
    if (
      input.project_id !== null &&
      !getSqlite().query("SELECT id FROM projects WHERE id=?").get(input.project_id)
    )
      throw new NotFoundError("Project", input.project_id);
    return input.project_id;
  }
  return resolveProjectId(input.project)?.id ?? null;
}

export async function executeTool(
  name: ToolName,
  args: unknown,
  options: ToolOptions = {},
): Promise<string> {
  if (name === "session_sync")
    return JSON.stringify(
      await orcApi("POST", "/sessions/archive/sync", { body: SessionSyncInputSchema.parse(args) }),
    );
  if (name === "session_search") {
    const input = ArchiveSearchSchema.omit({ project_id: true })
      .extend({ project: projectParam })
      .parse(args);
    const project = resolveProjectId(input.project);
    const params = new URLSearchParams({
      q: input.q,
      mode: input.mode,
      limit: String(input.limit),
      offset: String(input.offset),
      ...(project ? { project_id: project.id } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
    });
    return JSON.stringify(await orcApi("GET", `/sessions/archive?${params}`));
  }
  if (name === "session_read") {
    const input = z
      .object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        revision: z.number().int().min(1).optional(),
        ordinal: z.number().int().min(0).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(30),
      })
      .parse(args);
    if (input.ordinal !== undefined && input.revision === undefined)
      throw new ValidationError("Passage reads require the cited revision");
    const params = new URLSearchParams({
      ...(input.revision ? { revision: String(input.revision) } : {}),
      ...(input.ordinal !== undefined
        ? { ordinal: String(input.ordinal) }
        : { offset: String(input.offset), limit: String(input.limit) }),
    });
    return JSON.stringify(
      await orcApi(
        "GET",
        `/sessions/archive/${input.id}/${input.ordinal !== undefined ? "passage" : "transcript"}?${params}`,
      ),
    );
  }
  if (isKbTool(name)) {
    const input = args as Record<string, unknown>;
    const project = typeof input.project === "string" ? input.project : undefined;
    return executeKbTool(name, input, resolveProjectId(project)?.id ?? null);
  }
  if (name === "session_handoff") {
    const input = SessionHandoffInputSchema.parse(args);
    const config = loadConfig();
    const hostname =
      config.api.host === "0.0.0.0" || config.api.host === "::" ? "127.0.0.1" : config.api.host;
    const base = process.env.ORC_API_BASE ?? `http://${hostname}:${config.api.port}`;
    const response = await fetch(`${base.replace(/\/$/, "")}/api/session-handoffs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.api.secret ?? ""}`,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60_000),
    });
    const body: unknown = await response.json();
    if (!response.ok)
      throw new ValidationError(
        `Handoff request failed (${response.status}); verify project scope, pushed branch and API access`,
      );
    const handoff = SessionHandoffUploadSchema.parse(body);
    if (options.publicApiBaseUrl) {
      const upload = new URL(handoff.upload_url);
      handoff.upload_url = new URL(
        `${upload.pathname}${upload.search}`,
        options.publicApiBaseUrl,
      ).toString();
    }
    return JSON.stringify(handoff);
  }
  const db = getDb();

  switch (name) {
    case "skill_update": {
      const { project, scope, ...input } = skillUpdateParams.parse(args);
      return JSON.stringify(
        new SkillHistory(getSqlite(db)).update({
          ...input,
          project_id: resolveScope({ project, scope }),
          author: input.author ?? process.env.ORC_AGENT ?? "agent",
          session_id: input.session_id ?? process.env.ORC_SESSION_ID,
        }),
      );
    }
    case "skill_history": {
      const input = skillHistoryParams.parse(args);
      return JSON.stringify({
        changes: new SkillHistory(getSqlite(db)).history(input.name, resolveScope(input)),
      });
    }
    case "skill_revert": {
      const input = skillRevertParams.parse(args);
      return JSON.stringify(
        new SkillHistory(getSqlite(db)).revert(
          input.name,
          resolveScope(input),
          input.change_id,
          input.expected_change_id,
          input.reason,
        ),
      );
    }
    case "digest_complete": {
      const input = digestCompleteParams.parse(args);
      const actor =
        [process.env.ORC_AGENT, process.env.CLAUDE_MODEL].filter(Boolean).join("/") || "agent";
      new KbDigestStore(getSqlite(db)).complete(input.token, input.outcome, input.note, actor);
      return "Digest completed";
    }
    case "audit_list": {
      const input = auditParams.parse(args);
      return JSON.stringify({
        entries: new AuditLog(getSqlite(db)).list({
          projectId: resolveScope(input),
          entityType: input.entity_type,
          sessionId: input.session_id,
          since: input.since,
          limit: input.limit,
        }),
      });
    }
    case "memory_list": {
      const { q, sort, limit, project } = args as {
        q?: string;
        sort?: MemoryListSort;
        limit?: number;
        project?: string;
      };
      const projectId = memoryProject(project);
      const matched = new MemoryStore(getSqlite(db)).list(projectId, { q, sort });
      const shown = matched.slice(0, limit ?? MEMORY_LIST_LIMIT);
      const more =
        matched.length > shown.length
          ? [`Showing ${shown.length} of ${matched.length}; use q to search or raise limit.`]
          : [];
      return [shown.map(formatMemoryLine).join("\n") || "No memories found.", ...more].join("\n");
    }

    case "memory_read": {
      const { name: memoryName, project } = args as { name: string; project?: string };
      const memory = new MemoryStore(getSqlite(db)).read(memoryProject(project), memoryName, "mcp");
      const priority = memory.priority === null ? "" : ` (priority ${memory.priority})`;
      return `# ${memory.name}${priority}\n${memory.description}\n\n${memory.content}`;
    }

    case "memory_create": {
      const input = args as {
        name: string;
        description: string;
        content: string;
        priority?: number | null;
        project?: string;
      };
      const memory = new MemoryStore(getSqlite(db)).create({
        ...input,
        project_id: memoryProject(input.project),
        ...memoryWriter(options),
      });
      return `Created memory ${memory.name}`;
    }

    case "memory_update": {
      const {
        name: memoryName,
        project,
        reason,
        ...fields
      } = args as {
        name: string;
        description?: string;
        content?: string;
        priority?: number | null;
        reason?: string;
        project?: string;
      };
      new MemoryStore(getSqlite(db)).update(memoryProject(project), memoryName, fields, {
        ...memoryWriter(options),
        reason,
      });
      return `Updated memory ${memoryName}`;
    }

    case "memory_delete": {
      const {
        name: memoryName,
        project,
        reason,
      } = args as {
        name: string;
        reason?: string;
        project?: string;
      };
      new MemoryStore(getSqlite(db)).remove(memoryProject(project), memoryName, {
        ...memoryWriter(options),
        reason,
      });
      return `Deleted memory ${memoryName}; memory_revert can restore it`;
    }

    case "memory_history": {
      const { name: memoryName, project } = args as { name: string; project?: string };
      return JSON.stringify({
        changes: new MemoryStore(getSqlite(db)).history(memoryProject(project), memoryName),
      });
    }

    case "memory_revert": {
      const input = args as {
        name: string;
        change_id: string;
        expected_change_id: string;
        reason: string;
        project?: string;
      };
      const memory = new MemoryStore(getSqlite(db)).revert(
        memoryProject(input.project),
        input.name,
        input.change_id,
        input.expected_change_id,
        { ...memoryWriter(options), reason: input.reason },
      );
      return memory ? `Reverted memory ${memory.name}` : `Reverted: memory ${input.name} removed`;
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
        .map(
          (t) =>
            `[${t.id}] ${t.status.padEnd(18)} ${t.priority.padEnd(8)} ${t.progress}% ${t.title}`,
        )
        .join("\n");
    }

    case "task_get": {
      const { ids } = args as { ids: string[] };
      const rows = await Promise.all(
        ids.map((id) => db.query.tasks.findFirst({ where: eq(tasks.id, id) })),
      );
      return rows
        .filter(Boolean)
        .map(
          (t) =>
            `[${t?.id}] ${t?.status} - ${t?.title}\nProgress: ${t?.progress}%\n${t?.body ?? ""}`,
        )
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
        skill_name,
        required_review,
        agent_backend,
        agent_model,
        max_review_rounds,
      } = args as {
        title: string;
        body?: string;
        project?: string;
        priority?: string;
        author?: string;
        tags?: string[];
        skill_name?: string;
        required_review?: boolean;
        agent_backend?: string;
        agent_model?: string;
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
        skill_name,
        required_review: required_review ?? true,
        agent_backend: agent_backend as string | undefined,
        agent_model,
        max_review_rounds: max_review_rounds ?? 3,
        created_at: now,
        updated_at: now,
      });
      const proj = resolved ? ` (${resolved.name})` : "";
      import("@orc/runner/task-loop")
        .then((m) => m.triggerTaskCheck())
        .catch((err) => logger.warn("triggerTaskCheck failed", { err }));
      return `Created: ${id} - ${title}${proj}`;
    }

    case "task_update": {
      const { id, status, body, priority, comment, progress, agent_backend, agent_model } =
        args as {
          id: string;
          status?: string;
          body?: string;
          priority?: string;
          comment?: string;
          progress?: number;
          agent_backend?: string;
          agent_model?: string;
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
      if (
        body !== undefined ||
        progress !== undefined ||
        priority ||
        agent_backend !== undefined ||
        agent_model !== undefined
      ) {
        await db
          .update(tasks)
          .set({
            ...(body !== undefined ? { body } : {}),
            ...(progress !== undefined ? { progress } : {}),
            ...(priority ? { priority: priority as "low" } : {}),
            ...(agent_backend !== undefined ? { agent_backend } : {}),
            ...(agent_model !== undefined ? { agent_model } : {}),
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
      const run = await db.query.job_runs.findFirst({
        where: eq(job_runs.id, run_id),
      });
      if (!run) return `Run not found: ${run_id}`;
      return JSON.stringify({
        status: run.status,
        exit_code: run.exit_code,
        error: run.error_msg,
      });
    }

    case "context": {
      const input = scopedProjectParams.parse(args);
      const config = loadConfig();
      const taskLimit = config.context.layer1_task_limit;
      const memLimit = config.context.layer1_memory_limit;
      const explicitScope = input.project_id !== undefined;
      const projectId = explicitScope ? resolveScopedProject(input) : undefined;
      const resolved = explicitScope
        ? projectId == null
          ? null
          : await db.query.projects.findFirst({
              where: eq(projects.id, projectId),
            })
        : resolveProjectId(input.project);
      const scoped = explicitScope || Boolean(resolved);
      const scopeId = resolved?.id ?? null;

      const taskConditions = [];
      if (scoped) taskConditions.push(sql`${tasks.project_id} IS ${scopeId}`);
      const activeTasks = await db.query.tasks.findMany({
        where: taskConditions.length > 0 ? and(...taskConditions) : undefined,
        limit: taskLimit,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filtered = activeTasks.filter((t) => !["done", "cancelled"].includes(t.status));

      const projectMemories = scopeId
        ? new MemoryStore(getSqlite(db)).context(scopeId, memLimit)
        : [];

      const lastSession = await db.query.sessions.findFirst({
        where: scoped ? sql`${sessions.project_id} IS ${scopeId}` : undefined,
        orderBy: [desc(sessions.created_at)],
      });

      const lines: string[] = [];
      if (resolved) {
        lines.push(`## Project: ${resolved.name}`);
      } else if (explicitScope) {
        lines.push("## Project: Unassigned");
      }

      lines.push(scoped ? "\n## Active Tasks" : "## Active Tasks");
      if (filtered.length === 0) lines.push("  (none)");
      for (const t of filtered) {
        lines.push(`  [${t.id}] ${t.status.padEnd(10)} ${t.title}`);
      }

      lines.push("\n## Memories");
      if (projectMemories.length === 0) lines.push("  (none)");
      for (const m of projectMemories) {
        const priority = m.priority === null ? "" : ` [p${m.priority}]`;
        lines.push(`  ${m.name}${priority} - ${m.description}`);
      }

      if (lastSession?.summary) {
        lines.push(`\n## Last Session (${lastSession.agent})`);
        lines.push(`  ${lastSession.summary}`);
      }

      const sqlite = getSqlite();
      const activeCount = sqlite
        .query(
          "SELECT COUNT(*) as count FROM gateway_sessions WHERE role = 'worker' AND status = 'running'" +
            (scoped ? " AND project_id IS ?" : ""),
        )
        .get(...(scoped ? [scopeId] : [])) as { count: number } | null;
      if (activeCount && activeCount.count > 0) {
        lines.push(`\n## Agent Loop: ${activeCount.count} active worker(s)`);
      }

      lines.push("\nUse task_get([ids]) or memory_read(name) for full content.");
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
      const { session_id, project_id } = args as {
        session_id?: string;
        project_id?: string | null;
      };
      const config = loadConfig();
      const maxBytes = config.context.snapshot_max_bytes;
      const sid = session_id ?? process.env.ORC_SESSION_ID ?? "default";

      const activeTasks = await db.query.tasks.findMany({
        ...(project_id !== undefined ? { where: sql`${tasks.project_id} IS ${project_id}` } : {}),
        limit: 10,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filteredTasks = activeTasks.filter((t) => !["done", "cancelled"].includes(t.status));

      const sqlite = getSqlite();

      type EventRow = {
        type: string;
        priority: number;
        data: string;
        data_hash?: string;
      };
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

      for (const e of events) {
        try {
          const d = JSON.parse(e.data) as Record<string, string>;
          if (e.type === "file" && d.path) files.add(d.path);
          if (e.type === "task" && d.id) taskIds.add(d.id);
        } catch {}
      }

      const parts = [summary];
      if (files.size > 0) parts.push(`Files: ${[...files].join(", ")}`);
      if (taskIds.size > 0) parts.push(`Tasks: ${[...taskIds].join(", ")}`);
      const memoryNames = [
        ...new Set(new MemoryStore(sqlite).sessionChanges(sid).map((c) => c.memory_name)),
      ];
      if (memoryNames.length > 0) parts.push(`Memories: ${memoryNames.join(", ")}`);

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
          skill_name?: string;
          required_review?: boolean;
          agent_backend?: string;
          agent_model?: string;
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

      const sqlite = getSqlite();
      // Atomic batch: all tasks + their dependency links commit together or not
      // at all. bun:sqlite transactions are synchronous, so drizzle inserts run
      // via .run() (sync) on the same underlying connection inside the txn.
      const runBatch = sqlite.transaction(() => {
        for (const item of items) {
          const id = ulid();
          mapping[item.ref] = id;
          db.insert(tasks)
            .values({
              id,
              title: item.title,
              body: item.body,
              project_id: resolved?.id,
              priority: (item.priority ?? "normal") as "low" | "normal" | "high" | "critical",
              author: author ?? "agent",
              status: "todo",
              tags: item.tags,
              skill_name: item.skill_name,
              required_review: item.required_review ?? true,
              agent_backend: item.agent_backend as string | undefined,
              agent_model: item.agent_model,
              max_review_rounds: item.max_review_rounds ?? 3,
              created_at: now,
              updated_at: now,
            })
            .run();
        }

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
      });
      runBatch();

      const lines = items.map((item) => `  ${item.ref} → ${mapping[item.ref]} - ${item.title}`);
      import("@orc/runner/task-loop")
        .then((m) => m.triggerTaskCheck())
        .catch((err) => logger.warn("triggerTaskCheck failed", { err }));
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
      if (!resources || resources.includes("knowledge")) {
        try {
          const kbLines = await kbSearchLines(query, resolved?.id ?? null, Math.ceil(lim / 2));
          if (kbLines.length > 0) parts.push("## Knowledge", ...kbLines);
        } catch (error) {
          logger.warn("Knowledge search failed", { error });
          parts.push("## Knowledge unavailable; memory and task results remain available.");
        }
      }
      if (!resources || resources.includes("memories")) {
        const memResults = new MemoryStore(getSqlite(db))
          .list(resolved?.id ?? null, { q: query })
          .slice(0, Math.ceil(lim / 2));
        if (memResults.length > 0) {
          // memory_read takes a name plus a project name, so print both.
          const projectNames = new Map(
            getSqlite(db)
              .query<{ id: string; name: string }, []>("SELECT id, name FROM projects")
              .all()
              .map((row) => [row.id, row.name]),
          );
          parts.push("## Memories");
          for (const m of memResults)
            parts.push(
              `  [memory] ${m.name} (project: ${projectNames.get(m.project_id) ?? m.project_id}) ${m.description}`,
            );
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
            parts.push(`  [task] ${t.id} ${t.status} - ${t.title}`);
          }
        }
      }

      return parts.length > 0 ? parts.join("\n") : "No results found.";
    }

    case "skill_list": {
      const { q, source, sort, limit, reload, project, scope } = args as {
        q?: string;
        source?: "builtin" | "user";
        sort?: SkillListSort;
        limit?: number;
        reload?: boolean;
        project?: string;
        scope?: "global";
      };
      const matched = new SkillHistory(getSqlite(db)).list(resolveScope({ project, scope }), {
        q,
        source,
        sort,
        reload,
      });
      const skills = matched.slice(0, limit ?? SKILL_LIST_LIMIT);
      const issues = [
        ...skillValidationIssues().map((issue) => `Invalid skill: ${issue.path}: ${issue.error}`),
        ...skillWarnings().map((w) => `Skill warning: ${w.path}: ${w.message}`),
      ];
      const result = skills
        .map((s) => {
          const src = s.source === "user" ? " [user]" : "";
          const reads = ` (${s.read_count} ${s.read_count === 1 ? "read" : "reads"})`;
          const desc = s.description ? ` - ${s.description.slice(0, 80)}` : "";
          return `${s.name.padEnd(28)}${src}${reads}${desc}`;
        })
        .join("\n");
      const more =
        matched.length > skills.length
          ? [`Showing ${skills.length} of ${matched.length}; use q to search or raise limit.`]
          : [];
      return [result || "No skills found.", ...more, ...issues].join("\n");
    }

    case "skill_read": {
      const {
        name: sName,
        ref,
        project,
        scope,
        download,
      } = args as {
        name: string;
        ref?: string;
        project?: string;
        scope?: "global";
        download?: boolean;
      };
      const skillHistory = new SkillHistory(getSqlite(db));
      const skillScope = resolveScope({ project, scope });
      if (download) {
        if (!ref) throw new ValidationError("download:true requires a skill-relative ref");
        const result = options.skillDownload
          ? options.skillDownload(sName, ref, skillScope)
          : SkillDownloadSchema.parse(
              await orcApi("POST", `/skills/${encodeURIComponent(sName)}/download`, {
                body: {
                  ref,
                  ...(skillScope === null ? { scope: "global" } : { project_id: skillScope }),
                },
                timeoutMs: 15_000,
              }),
            );
        skillHistory.recordRead(sName, skillScope, "mcp", ref);
        return JSON.stringify(result);
      }
      const result = skillHistory.read(sName, skillScope, ref);
      if (!result) return `Skill not found: ${sName}`;
      skillHistory.recordRead(sName, skillScope, "mcp", ref);
      if (ref) {
        const rc = result as SkillRefContent;
        const encoding = rc.encoding === "base64" ? "\nEncoding: base64" : "";
        return `# ${rc.name}${encoding}\n\n${rc.content}`;
      }
      const skill = result as SkillFull;
      let out = `# ${skill.name}\n${skill.description}\nSkill entry point: ${skill.path}\n\n${skill.content}`;
      if (skill.files.length > 0) {
        out += `\n\nSupporting files (paths relative to the skill root; load with skill_read ref):\n${skill.files.map((r) => `- ${r.name} (${r.path})`).join("\n")}`;
        out +=
          "\nFor original script/asset bytes, call skill_read with ref and download:true; fetch the signed URL to a local file and verify sha256. Downloading does not execute it.";
      }
      return out;
    }

    case "skill_create": {
      const {
        name: cName,
        content: cContent,
        files,
      } = args as { name: string; content: string; files?: SkillFileInput[] };
      try {
        const skill = createSkillFs(cName, cContent, files, { authored: true });
        return `Created skill: ${skill.name} at ${skill.path}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "agent_list":
      return JSON.stringify(discoverAgents());
    case "agent_read": {
      const { id } = args as { id: string };
      const agent = readAgent(id);
      return agent ? JSON.stringify(agent) : `Agent not found: ${id}`;
    }
    case "agent_create": {
      const { id, content } = args as { id: string; content: string };
      return JSON.stringify(createAgent(id, content));
    }
    case "agent_package_list":
      return JSON.stringify(listPackages());
    case "agent_package_read": {
      const { name, ref } = args as { name: string; ref?: string };
      return JSON.stringify(ref ? readPackageFile(name, ref) : readPackage(name));
    }
    case "agent_package_import": {
      const { name, content, files, format } = args as {
        name: string;
        content: string;
        files: SkillFileInput[];
        format?: "apm" | "agent-plugin";
      };
      return JSON.stringify(createPackage(name, content, files, format));
    }
    case "flow_report": {
      const {
        task: taskId,
        outcome,
        node,
        summary,
        vars,
      } = args as {
        task: string;
        outcome: string;
        node?: string;
        summary?: string;
        vars?: Record<string, unknown>;
      };
      const { reportNodeOutcome } = await import("@orc/runner/flow-runner");
      const result = await reportNodeOutcome({
        taskId,
        outcome,
        ...(node !== undefined ? { nodeId: node } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(vars !== undefined ? { vars } : {}),
      });
      if (!result.ok) return `Error: ${result.error}`;
      return (
        `Reported "${outcome}"${node ? ` for node ${node}` : ""}.` +
        (result.nextNodes.length > 0
          ? ` The flow moved on to: ${result.nextNodes.join(", ")}.`
          : " The flow routes when your session ends — finish up and stop.")
      );
    }

    case "flow_status": {
      const { task: taskId } = args as { task: string };
      const { getLatestFlowRunForTask } = await import("@orc/runner/flow-runner");
      const run = getLatestFlowRunForTask(taskId);
      if (!run) return `No flow run for task ${taskId}.`;

      const lines = [
        `Flow: ${run.flow_name} (${run.flow_source})  run ${run.id}`,
        `Status: ${run.status}${run.halt_description ? ` — ${run.halt_description}` : ""}`,
        `Node executions: ${run.node_executions}`,
      ];
      if (run.active.length > 0) {
        lines.push(`Active: ${run.active.map((a) => `${a.nodeId}#${a.attempt}`).join(", ")}`);
      }
      const visits = Object.entries(run.visits);
      if (visits.length > 0) {
        lines.push(`Visits: ${visits.map(([n, c]) => `${n}×${c}`).join(", ")}`);
      }
      const shownVars = Object.entries(run.vars).filter(
        ([k]) => !["task_id", "task_title", "project_id"].includes(k),
      );
      if (shownVars.length > 0) {
        lines.push(
          `Vars: ${shownVars.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ")}`,
        );
      }
      if (run.nodes.length > 0) {
        lines.push("", "Ledger:");
        for (const n of run.nodes) {
          const verdict = n.outcome ? `→ ${n.outcome}` : `(${n.status})`;
          lines.push(`  ${n.node_id}#${n.attempt} [${n.status}] ${verdict}`);
          if (n.summary) lines.push(`    ${n.summary.split("\n")[0]}`);
          if (n.error) lines.push(`    error: ${n.error}`);
        }
      }
      return lines.join("\n");
    }

    case "flow_list": {
      const { q, source } = args as {
        q?: string;
        source?: "builtin" | "user" | "project";
      };
      const { listFlows, listBrokenFlows } = await import("@orc/core/flow-service");
      const flows = listFlows({
        ...(q ? { q } : {}),
        ...(source ? { source } : {}),
      });
      if (flows.length === 0) return "No flows found.";
      const lines = flows.map(
        (f) =>
          `${f.name} [${f.source}${f.shadows ? `, shadows ${f.shadows}` : ""}]  entry:${f.entry}  ` +
          `${f.node_count} nodes, ${f.edge_count} edges` +
          (f.description ? `\n  ${f.description}` : ""),
      );
      const broken = listBrokenFlows();
      if (broken.length > 0) {
        lines.push("", "Invalid flows (ignored):");
        for (const b of broken) lines.push(`  ${b.name}: ${b.errors.join("; ")}`);
      }
      return lines.join("\n");
    }

    case "flow_read": {
      const { name: flowName } = args as { name: string };
      const { readFlow } = await import("@orc/core/flow-service");
      const flow = readFlow(flowName);
      if (!flow) return `Flow not found: ${flowName}`;
      return [
        `# ${flow.name} [${flow.source}] v${flow.version}`,
        flow.description,
        flow.path ? `path: ${flow.path}` : "path: (built in)",
        "",
        JSON.stringify(flow.definition, null, 2),
      ].join("\n");
    }

    case "flow_create": {
      const { definition, overwrite, shadow_builtin } = args as {
        definition: Record<string, unknown>;
        overwrite?: boolean;
        shadow_builtin?: boolean;
      };
      const { createFlow } = await import("@orc/core/flow-service");
      try {
        const flow = createFlow(definition, {
          overwrite: overwrite ?? false,
          shadowBuiltin: shadow_builtin ?? false,
        });
        return `Created flow: ${flow.name} at ${flow.path} (${flow.node_count} nodes, ${flow.edge_count} edges)`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    case "flow_attach": {
      const {
        task: taskId,
        name: flowName,
        definition,
        start,
      } = args as {
        task: string;
        name?: string;
        definition?: Record<string, unknown>;
        start?: boolean;
      };
      if (!flowName && !definition) return "Error: pass either name or definition.";

      const target = await db.query.tasks.findFirst({
        where: eq(tasks.id, taskId),
      });
      if (!target) return `Task not found: ${taskId}`;

      if (definition) {
        const { parseFlowDefinition } = await import("@orc/core/flow");
        const parsed = parseFlowDefinition(definition);
        if (!parsed.ok) return `Error: invalid flow definition:\n  ${parsed.errors.join("\n  ")}`;
        await db
          .update(tasks)
          .set({
            flow_override: parsed.definition,
            flow_name: null,
            updated_at: new Date(),
          })
          .where(eq(tasks.id, taskId));
      } else {
        const { readFlow } = await import("@orc/core/flow-service");
        if (!readFlow(flowName as string)) return `Flow not found: ${flowName}`;
        await db
          .update(tasks)
          .set({
            flow_name: flowName,
            flow_override: null,
            updated_at: new Date(),
          })
          .where(eq(tasks.id, taskId));
      }

      const label = definition
        ? `inline flow "${(definition.name as string) ?? "custom"}"`
        : `flow "${flowName}"`;
      if (!start)
        return `Attached ${label} to task ${shortId(taskId)}. It runs on the next loop cycle.`;

      const { startFlowForTask } = await import("@orc/runner/flow-runner");
      const started = await startFlowForTask(taskId);
      return started.ok
        ? `Attached ${label} and started run ${started.flowRunId}.`
        : `Attached ${label}, but could not start it: ${started.error}`;
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
        `  <task id="${shortId(t.id)}" status="${t.status}" priority="${t.priority}">${escapeXml(t.title)}</task>`,
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
