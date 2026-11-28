import {
  createAgent,
  deleteAgent,
  discoverAgents,
  readAgent,
  updateAgent,
} from "@orc/core/agent-service";
import {
  BackgroundJobStatusSchema,
  getBackgroundJob,
  listBackgroundJobs,
  readBackgroundJobLog,
  startBackgroundJob,
  stopBackgroundJob,
} from "@orc/core/background-jobs";
import { ChannelSendSchema, ChannelUpdateSchema } from "@orc/core/channels";
import { AGENT_ID_PATTERN, CODING_AGENTS } from "@orc/core/coding-agents";
import { clearSetupDismissal, loadConfig, resolveApiBase } from "@orc/core/config";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  OrcError,
  ValidationError,
} from "@orc/core/errors";
import { ALIAS_PATTERN } from "@orc/core/exec-host";
import { isGitRemoteUrl } from "@orc/core/git-remote";
import {
  GithubSyncConfigSchema,
  type GithubSyncState,
  validateGithubTaskEdit,
} from "@orc/core/github-sync";
import { GoalSpecSchema } from "@orc/core/goal";
import {
  CommandSpecSchema,
  HumanRequestInputSchema,
  HumanRequestSchema,
  SecretClaimResultSchema,
} from "@orc/core/human-requests";
import { shortId, ulid } from "@orc/core/ids";
import { createLogger } from "@orc/core/logger";
import {
  createPackage,
  deletePackage,
  listPackages,
  packageRevision,
  readPackage,
  readPackageFile,
  updatePackage,
} from "@orc/core/package-service";
import { providerChatDefaults } from "@orc/core/provider-service";
import {
  MAX_EXPIRES_AT,
  SCRATCHPAD_KINDS,
  SCRATCHPAD_TAGS_MAX,
  SCRATCHPAD_TITLE_MAX,
  type Scratchpad,
  type ScratchpadContentUrl,
  ScratchpadContentUrlSchema,
  type ScratchpadKind,
  type ScratchpadListItem,
} from "@orc/core/scratchpad";
import { registerRedactedSecrets } from "@orc/core/secret-redactor";
import { ArchiveSearchSchema, SessionSyncInputSchema } from "@orc/core/session-archive";
import { SessionHandoffInputSchema, SessionHandoffUploadSchema } from "@orc/core/session-handoff";
import {
  SESSION_MESSAGE_MAX_BODY,
  SessionListResponseSchema,
  SessionListScopeSchema,
  SessionMessageModeSchema,
  SessionMessageResultSchema,
  SessionSpawnSchema,
  SessionStatusSchema,
  SessionUpdateSchema,
  SessionWaitManySchema,
  SessionWaitSchema,
} from "@orc/core/session-messages";
import { type SkillDownload, SkillDownloadSchema } from "@orc/core/skill-download";
import {
  createSkill as createSkillFs,
  type SkillFileInput,
  type SkillFull,
  type SkillRefContent,
} from "@orc/core/skill-service";
import { SkillUpdateSchema } from "@orc/core/skill-update";
import { DEFAULT_TTL_DAYS, TtlDaysSchema, ttlDaysLeft } from "@orc/core/ttl";
import type { TaskStatus } from "@orc/core/types";
import { AgentBackendSchema, TaskLinkTypeSchema, TaskStatusSchema } from "@orc/core/types";
import { AuditLog } from "@orc/db/audit";
import { getDb, getSqlite } from "@orc/db/client";
import { projectKbCount } from "@orc/db/kb";
import { KbDigestStore } from "@orc/db/kb-digest";
import {
  MEMORY_DESCRIPTION_MAX,
  MEMORY_PRIORITY_MAX,
  type MemoryListItem,
  type MemoryListSort,
  MemoryStore,
} from "@orc/db/memories";
import {
  comments,
  job_run_logs,
  job_runs,
  jobs,
  projects,
  sessions,
  task_links,
  tasks,
} from "@orc/db/schema";
import { ScratchpadStore } from "@orc/db/scratchpads";
import { SessionMessageStore } from "@orc/db/session-messages";
import { SkillHistory, type SkillListSort } from "@orc/db/skill-history";
import { withTaskAudit } from "@orc/db/task-audit";
import { executeJob } from "@orc/runner/executor";
import { addTaskComment, updateTaskStatus } from "@orc/task-service";

import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { orcApi, orcApiBase } from "./api-client.js";
import { executeKbTool, isKbTool, kbSearchLines, kbToolDefinitions } from "./kb-tools.js";
import { executePreviewTool, type PreviewScope, previewToolDefinitions } from "./preview-tools.js";
import type { McpProject } from "./project-scope.js";

const logger = createLogger("mcp:tools");
const SKILL_LIST_LIMIT = 30;
const MEMORY_LIST_LIMIT = 30;

const projectParam = z
  .string()
  .optional()
  .describe(
    "Project name (e.g. 'orc'). Overrides the connection's default project; otherwise uses activeProject from config.",
  );
/** Execution backends, not agent_list's role profiles: built-in harness ids plus custom Settings agents. */
const harnessParam = z
  .union([
    z.enum(CODING_AGENTS.map((agent) => agent.id) as [string, ...string[]]),
    z.string().regex(AGENT_ID_PATTERN),
  ])
  .optional()
  .describe(
    `Coding harness to run (${CODING_AGENTS.map((agent) => agent.id).join(", ")}, or a custom agent id from Settings). Omit for the Settings default, reported as defaults in the result.`,
  );
const sessionSendToolSchema = z
  .object({
    session_id: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Target: an ORC session id from session_start/session_list/session_status, a live id, or a unique native agent session id.",
      ),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(SESSION_MESSAGE_MAX_BODY)
      .describe("The note to send to the session."),
    mode: SessionMessageModeSchema.optional().describe(
      "queue (default) waits for its next safe point; steer injects into its running turn; interrupt stops the turn and delivers next.",
    ),
  })
  .strict();
const sessionSpawnToolSchema = SessionSpawnSchema.omit({ project_id: true, notify: true }).extend({
  project: projectParam,
  agent: harnessParam,
  notify: z
    .boolean()
    .optional()
    .describe(
      "Push the child's final reply, failure, stop or human question into this session (default true; coordinator connections default to false and use session_wait/session_status instead). On a coordinator connection, true makes ORC run the coordinator session's own turn to process the note.",
    ),
});
const sessionListToolSchema = z
  .object({
    scope: SessionListScopeSchema.optional().describe(
      'What to list: "all" (default, chats + discovered native sessions), "children" (sessions this session started), "chats" (ORC chats only), or "native" (discovered native sessions without an ORC chat).',
    ),
    project: z
      .string()
      .optional()
      .describe(
        'Project name or ID. Pass "all" to bypass connection default project, or "unassigned" for sessions without a project.',
      ),
    parent: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Filter by parent session id, or "self" for this calling session.'),
    agent: harnessParam,
    status: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe(
        'Filter by status: "active" (running|waiting|queued), "running", "waiting", "idle", "stopped", "queued", or "failed".',
      ),
    host: z.string().min(1).max(255).optional().describe('Execution host alias, or "local".'),
    q: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Substring filter across title, cwd, ids and summary."),
    include_hidden: z.boolean().optional().default(false),
    include_subagents: z.boolean().optional().default(false),
    sync: z
      .boolean()
      .optional()
      .default(false)
      .describe("Refresh discovered native sessions before listing."),
    limit: z.number().int().min(1).max(100).optional().default(25),
    offset: z.number().int().min(0).optional().default(0),
  })
  .strict();
const sessionUpdateToolSchema = SessionUpdateSchema.extend({
  session_id: z
    .string()
    .min(1)
    .max(200)
    .describe("Session id from session_start, session_list or session_status."),
});
const sessionOptionsToolSchema = z
  .object({
    agent: harnessParam,
    provider_id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional()
      .describe("Optional provider account id when inspecting models for an agent."),
    host: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Optional host alias when inspecting models."),
    include_models: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Also fetch discovered models, supported efforts and permission modes for the selected or default agent.",
      ),
  })
  .strict();
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
const channelScopeParams = z.object({
  project: projectParam,
  project_id: z.string().min(1).max(100).optional(),
});
const channelTargetsParams = channelScopeParams.extend({ connection: z.string().min(1).max(100) });
const channelSendParams = ChannelSendSchema.extend({ project: projectParam });
const channelReadParams = channelScopeParams.extend({ id: z.string().min(1).max(100) });
const channelEditParams = ChannelUpdateSchema.extend({
  id: z.string().min(1).max(100),
  project: projectParam,
});
const auditParams = scopeParams.extend({
  entity_type: z
    .enum([
      "memory",
      "skill",
      "kb",
      "notification",
      "human_request",
      "project_secret",
      "job_run",
      "task",
      "job",
      "rule",
      "settings",
      "terminal",
      "auth",
    ])
    .optional(),
  session_id: z.string().min(1).max(200).optional(),
  since: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const skillUpdateParams = SkillUpdateSchema.omit({ project_id: true })
  .extend(scopeParams.shape)
  .strict();
const skillHistoryParams = scopeParams.extend({ name: z.string().min(1).max(200) });
const skillFileWriteParams = skillHistoryParams
  .extend({
    path: z
      .string()
      .min(1)
      .max(1024)
      .describe("Skill-relative path, e.g. scripts/summary.py; not SKILL.md"),
    content: z
      .string()
      .max(8 * 1024 * 1024)
      .describe("Full new file text"),
    expected_content: z
      .string()
      .max(8 * 1024 * 1024)
      .nullable()
      .describe("Current file text from skill_read with this ref; null adds a new file"),
    reason: z.string().trim().min(1).max(2000),
    session_id: z.string().min(1).max(200).optional(),
  })
  .strict();
const skillRevertParams = skillHistoryParams.extend({
  change_id: z.string().min(1),
  expected_change_id: z.string().min(1),
  reason: z.string().trim().min(1).max(2000),
});
const humanCreateParams = HumanRequestInputSchema.safeExtend({
  project: projectParam,
});
const commandCreateParams = z
  .object({
    origin: HumanRequestInputSchema.shape.origin,
    title: HumanRequestInputSchema.shape.title,
    prompt: HumanRequestInputSchema.shape.prompt,
    command: CommandSpecSchema,
    project: projectParam,
    project_id: HumanRequestInputSchema.shape.project_id,
    expires_in_seconds: HumanRequestInputSchema.shape.expires_in_seconds,
  })
  .strict();
const humanGetParams = z
  .object({
    id: z.string().min(1).max(128),
    wait_seconds: z.number().int().min(0).max(30).default(0),
  })
  .strict();
const humanAckParams = z
  .object({ id: z.string().min(1).max(128), version: z.number().int().positive() })
  .strict();
const humanSnoozeParams = z
  .object({
    id: z.string().min(1).max(128),
    version: z.number().int().positive(),
    until: z.number().int().positive().max(8_640_000_000_000_000).optional(),
    after_seconds: z
      .number()
      .int()
      .min(1)
      .max(365 * 86400)
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.until !== undefined) !== (value.after_seconds !== undefined),
    "Supply either until or after_seconds",
  );
const humanUnsnoozeParams = z
  .object({
    id: z.string().min(1).max(128),
    version: z.number().int().positive().optional(),
  })
  .strict();
const digestCompleteParams = z
  .object({
    token: z.string().uuid(),
    outcome: z.enum(["applied", "no_change"]),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export const toolDefinitions = [
  ...previewToolDefinitions,
  {
    name: "command_request",
    description:
      "Ask the user to run a command in Notifications. Supply a script for the execution host's default shell (same as terminals), host (omit to use the global default execution host; otherwise an SSH alias configured for ORC, not a machine hostname; null for the API host), cwd and argument declarations. Reference each user-filled value as a quoted environment variable: $ORC_INPUT_NAME in bash/zsh, $env:ORC_INPUT_NAME in PowerShell; never ask for secrets in chat. Declare allow_secret_ref:true on an argument to let the user pick a saved project secret (project/<name>) instead of typing; only opted-in arguments resolve references, all others stay literal. References resolve server-side at Run time. The user can edit the script and explicitly Run. This call creates a durable request; poll human_request_get with wait_seconds:30 until answered (pending/running means keep waiting). The command result is returned to this requesting workflow, with supplied values redacted. Acknowledge after consuming it. Cancelled/expired/unavailable never authorize retries.",
    inputSchema: commandCreateParams,
  },
  {
    name: "channel_list",
    description:
      "Discover configured communication channels, readiness, provider capabilities and native message documentation. Configure connections in Settings > Channels; credentials are never returned.",
    inputSchema: channelScopeParams,
  },
  {
    name: "channel_targets",
    description:
      "List approved channel destinations and aliases such as me, subject to project restrictions.",
    inputSchema: channelTargetsParams,
  },
  {
    name: "channel_send",
    description:
      "Send a message through a configured channel. Common Markdown renders automatically. Optional overrides are the provider's native JSON payload: all message options pass through unchanged and explicit fields replace generated fields. ORC owns credentials and destination. Return a delivery receipt; accepted is provider acceptance, not human read. Use an idempotency key for retries. Read orc-platform references/channels.md for examples.",
    inputSchema: channelSendParams,
  },
  {
    name: "channel_message_get",
    description:
      "Inspect a channel delivery receipt. Unknown or partial delivery requires inspection before retrying; never assume exactly-once delivery.",
    inputSchema: channelReadParams,
  },
  {
    name: "channel_message_update",
    description:
      "Edit an accepted channel message using Markdown or native overrides. Keep the same number of provider message chunks.",
    inputSchema: channelEditParams,
  },
  {
    name: "human_request",
    description:
      "Ask the user for help in Notifications: a question, approval, reviewed command, or multi-field secret request. Use title for a short action name and prompt to explain why it is needed. For kind:secret supply 1-10 fields (key, label, optional description, required, multiline, link, reference_name) and optional save_to_project; never ask for credentials in chat. For kind:command supply the exact host, cwd, native-shell script and command.arguments with name, label, optional description and required. Creation never executes anything or grants OS privileges. Retain the id and poll human_request_get while pending/running, consume only in the requesting workflow, then acknowledge the returned version. Cancelled/expired/unavailable never authorize retries.",
    inputSchema: humanCreateParams,
  },
  {
    name: "human_request_get",
    description:
      "Read the state and answer of a human request created by this workflow. For kind:secret, the first answered read claims the one-time values (or saved project/<name> references) marked secret:true and clears them immediately; subsequent reads return consumed without values. Pending means wait; cancelled/expired/unavailable means do not proceed.",
    inputSchema: humanGetParams,
  },
  {
    name: "human_request_acknowledge",
    description:
      "After consuming the answer in your originating workflow, acknowledge its exact answered version. Cancelled, expired, unavailable, or denied requests never authorize execution. This does not execute anything.",
    inputSchema: humanAckParams,
  },
  {
    name: "project_secret_list",
    description:
      "List named project secret references (project/<name>) and metadata for a project. Returns names, descriptions, and last-used timestamps only — never secret values.",
    inputSchema: scopedProjectParams,
  },
  {
    name: "human_request_snooze",
    description:
      "Snooze a pending human request until a future timestamp (epoch ms via until) or duration (after_seconds) without answering, cancelling or changing its expiry. Only pending requests can be snoozed.",
    inputSchema: humanSnoozeParams,
  },
  {
    name: "human_request_unsnooze",
    description: "Wake a snoozed pending human request immediately so it returns to Needs you.",
    inputSchema: humanUnsnoozeParams,
  },
  {
    name: "skill_update",
    description:
      "Update effective SKILL.md instructions from verified lessons. Read current raw SKILL.md first and pass expected_content. Changes are audited with history; supporting authored files stay intact. Normal skill_read returns the edited version in scope.",
    inputSchema: skillUpdateParams,
  },
  {
    name: "skill_file_write",
    description:
      "Edit or add a supporting text file (script, reference, asset) of a user skill. To edit, read it with skill_read ref first and pass that text as expected_content; pass null to add a new file. Writes the installed file for every scope and is audited; SKILL.md goes through skill_update. Built-in and package skills are read-only.",
    inputSchema: skillFileWriteParams,
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
      "Review central audit entries (knowledge, task, job, rule, settings, terminal, auth events), optionally by entity_type or session_id. Removed memories survive in snapshot; result_ids identify replacements. Use with the delivery section of orc-sdlc references/review-and-delivery.md.",
    inputSchema: auditParams,
  },
  {
    name: "session_handoff",
    description:
      "Move a Claude Code or Codex session to ORC. FIRST commit and push the intended changes within the user's Git authorization. Report the pushed repository, branch and exact commit SHA, project name, source cwd and native session ID. Returns a single-use upload URL for native session files. Upload through HTTP; then use Sessions → Open in terminal. See orc-platform references/execution.md.",
    inputSchema: SessionHandoffInputSchema,
  },
  {
    name: "session_send",
    description:
      "Send a short note to another live or idle ORC session. Target with an ORC session id (session_start, session_list, session_status) or a unique native session id. mode queue (default) waits for the recipient's next safe point (or starts a turn when idle; unbound connections fall back to human relay); steer explicitly injects it into a running turn when the agent supports it, else queues; interrupt stops the running turn and delivers it as the next turn. Steer and interrupt require a bound calling session that started the target (or one of its ancestors). The receipt reports queued, steered, resumed, failed, or unsupported — do not poll; completion wakes you. It cannot approve tools or change configuration.",
    inputSchema: sessionSendToolSchema,
  },
  {
    name: "speak",
    description:
      "Say a short line to the user in this conversation. It is posted to the chat and, when voice mode is on, spoken aloud. Write plain spoken sentences: no code, paths, diffs or markdown.",
    inputSchema: z.object({ text: z.string().trim().min(1).max(4000) }),
  },
  {
    name: "session_start",
    description:
      "Start another agent session headlessly with a prompt and get its session_id at once. Runs with Settings defaults unless overridden with profile, agent, provider_id, model, effort, permission_mode, or send_while_running (call session_options to inspect available defaults, hosts, providers, profiles, and models). Pass project to run in that project's checkout (and its configured execution host when set), cwd to run in a specific folder (overrides project/parent folder and auto-detects project from folder), host to pick an execution host, and worktree to branch a new git worktree. With notify (default true; false for coordinators) ORC queues the child's final reply, failure, stop or human question for your next safe point without interrupting your turn.",
    inputSchema: sessionSpawnToolSchema,
  },
  {
    name: "session_status",
    description:
      "Status of an ORC chat or discovered native session: running, waiting (for a human question or approval), idle, failed or stopped; its last reply, queued messages, parent and children. Accepts chat id, live id, or unique native session id.",
    inputSchema: z
      .object({
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id from session_start or session_list"),
      })
      .strict(),
  },
  {
    name: "session_wait",
    description:
      "Block until one or several sessions stop running or wait for a human (until=idle), or post a new reply (until=message). Pass session_ids with mode all or any to wait on several sessions at once. Returns status and timed_out. Prefer notify on session_start when you have other work to do.",
    inputSchema: SessionWaitSchema.extend({
      session_id: z.string().min(1).max(200).optional().describe("One session to wait on"),
      session_ids: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(20)
        .optional()
        .describe("Several sessions to wait on together"),
      mode: z
        .enum(["all", "any"])
        .default("all")
        .describe("With session_ids: return when all of them, or the first one, settle"),
    }),
  },
  {
    name: "session_list",
    description:
      'List ORC chat sessions and discovered native coding-agent sessions (deduplicated, paginated). Defaults to scope "all" (filtered by connection default project if set; pass project "all" to see every project, or scope "children" for sessions this session started). Hidden sessions stay out unless include_hidden is true; use session_delete to hide a failed or stopped probe. Returns canonical session_id, source ("chat" | "native"), status, waiting_for, project_id, cwd, host, total, has_more, and next_offset.',
    inputSchema: sessionListToolSchema,
  },
  {
    name: "session_update",
    description:
      "Update a session's title, hidden state, linked task_id (discovered sessions), or ORC chat settings (model, effort, permission_mode, send_while_running). Accepts chat id, live id, or unique native session id.",
    inputSchema: sessionUpdateToolSchema,
  },
  {
    name: "session_options",
    description:
      "Inspect effective session defaults, configured execution hosts, provider accounts, composer profiles, and (when agent or include_models is set) discovered models, supported effort levels, and permission modes.",
    inputSchema: sessionOptionsToolSchema,
  },
  {
    name: "session_delete",
    description:
      "Remove a failed, stopped or finished session you started from the default session_list. It hides the session instead of destroying it: the transcript stays readable with session_read, session_status still finds it by id, and restore true brings it back. Only the session that started it (or an ancestor) can delete it.",
    inputSchema: z
      .object({
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id from session_start or session_list"),
        restore: z
          .boolean()
          .default(false)
          .describe("Bring a hidden session back into the default list"),
      })
      .strict(),
  },
  {
    name: "session_stop",
    description:
      "Stop the current turn of a session you started (or one of its descendants), and by default every session it started in turn. Queued children are cancelled. Sessions stay resumable; send a message to continue.",
    inputSchema: z
      .object({
        session_id: z
          .string()
          .min(1)
          .max(200)
          .describe("Session id from session_start or session_list"),
        cascade: z.boolean().default(true).describe("Also stop the sessions it started"),
      })
      .strict(),
  },
  {
    name: "session_search",
    description:
      "Search archived and indexed coding-session passages. Returns bounded evidence with session:<id>@<revision>#<ordinal> citations, not entire histories. Optional embeddings use Settings; keyword search remains available. Sync local files with the trusted orc-platform scripts/sync-sessions.py, following references/session-archive.md.",
    inputSchema: ArchiveSearchSchema.omit({ project_id: true, project_ids: true }).extend({
      project: projectParam,
    }),
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
      "Read a cited archived-session passage, or a bounded page of conversation turns. Pin the revision from session_search for stable evidence after more messages arrive. Unarchived sessions (ORC chats or discovered live native sessions) fall back to their live transcript.",
    inputSchema: z
      .object({
        id: z.string().trim().min(1).max(200),
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
      "List memories (name, description, priority, reads). Pass project to scope to one project; without " +
      "it, lists every project you can access, grouped by project. Defaults to the 30 most read; " +
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
    name: "pad_list",
    description:
      "List scratchpads (newest first, without content): working docs (markdown + mermaid), " +
      "Excalidraw diagrams and HTML pages a human or agent keeps and revisits. Omit project to list " +
      "every pad; unassigned:true lists pads without a project; session:'current' lists pads " +
      "linked to this agent session. expiry:'expiring' lists pads due within two days and " +
      "expiry:'expired' lists archived pads; pinned:true lists pinned pads. Read one with pad_get.",
    inputSchema: z.object({
      kind: z.enum(SCRATCHPAD_KINDS).optional(),
      project: z.string().min(1).optional().describe("Project name; omit for every project"),
      unassigned: z.boolean().optional().describe("Only pads without a project"),
      session: z
        .string()
        .optional()
        .describe("A native session id, or 'current' for this agent session"),
      tag: z.string().optional(),
      q: z.string().optional().describe("Search title and content"),
      expiry: z
        .enum(["expiring", "expired"])
        .optional()
        .describe("expiring = due within two days; expired = archived pads"),
      pinned: z.boolean().optional().describe("true lists pinned pads only"),
      limit: z.number().int().min(1).max(500).optional().describe("Max pads (default 50)"),
    }),
  },
  {
    name: "pad_get",
    description:
      "Read a scratchpad: header (kind, revision, link) then the raw file - markdown for doc, " +
      ".excalidraw JSON for diagram, HTML for html. via:'url' instead returns a short-lived " +
      "download_url (curl it, no auth needed) for large pads.",
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      via: z.enum(["inline", "url"]).optional().describe("inline (default) or url"),
    }),
  },
  {
    name: "pad_create",
    description:
      "Create a scratchpad. kind doc = markdown (```mermaid blocks render as diagrams), diagram = " +
      'an .excalidraw file ({"type":"excalidraw","elements":[...]}; omit content for an empty ' +
      "canvas), html = a standalone page shown in a sandboxed frame; if the human chooses to " +
      "render it with ORC access, `window.orc.fetch(path, init)` calls the ORC API as them " +
      "(check `window.orc` and fall back to sample data; pin CDN scripts with integrity). " +
      "Linked to this agent session " +
      "by default. Returns the id, revision and a deep link to share with the human. Most pads " +
      "are temporary: pass a ttl (1h, 7d); omit it only for a durable pad. pinned:true " +
      "exempts a pad from its expiry. For large content create it empty, then pad_update with via:'url'.",
    inputSchema: z.object({
      kind: z.enum(SCRATCHPAD_KINDS),
      title: z.string().trim().min(1).max(SCRATCHPAD_TITLE_MAX),
      content: z.string().optional(),
      project: z
        .string()
        .min(1)
        .optional()
        .describe("Project name; omit for a pad without a project"),
      tags: z.array(z.string().min(1).max(64)).max(SCRATCHPAD_TAGS_MAX).optional(),
      link_session: z
        .boolean()
        .optional()
        .describe("Link to this agent session (default true when the session is known)"),
      ttl: z
        .string()
        .trim()
        .min(1)
        .max(16)
        .optional()
        .describe("Expire after a duration such as 1h, 7d or 4w; omit for no expiry"),
      expires_at: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Expire at an epoch-seconds deadline instead of a ttl"),
      pinned: z.boolean().optional().describe("Never auto-expire this pad"),
      keep_alive: z
        .boolean()
        .optional()
        .describe("Extend the expiry from now on every edit (sliding ttl)"),
    }),
  },
  {
    name: "pad_update",
    description:
      "Update a scratchpad. Pass if_revision (from pad_get) so a human's concurrent edit is not " +
      "overwritten: it fails if the file changed since then (or, when you also set title, project " +
      "or tags, if anything changed), and you should re-read. content replaces the whole file. " +
      "project null removes the project link. ttl or expires_at sets an expiry; null clears it. " +
      "via:'url' instead returns an upload_url: PUT the raw file to it (curl -T file URL), " +
      "valid for one write at the current revision.",
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      title: z.string().trim().min(1).max(SCRATCHPAD_TITLE_MAX).optional(),
      content: z.string().optional(),
      project: z.string().min(1).nullable().optional().describe("Project name, or null to unlink"),
      tags: z.array(z.string().min(1).max(64)).max(SCRATCHPAD_TAGS_MAX).optional(),
      ttl: z
        .string()
        .trim()
        .min(1)
        .max(16)
        .nullable()
        .optional()
        .describe("Expire after a duration such as 1h or 7d; null clears the expiry"),
      expires_at: z
        .number()
        .int()
        .positive()
        .nullable()
        .optional()
        .describe("Epoch-seconds deadline; null clears the expiry"),
      pinned: z.boolean().optional().describe("Never auto-expire this pad"),
      keep_alive: z.boolean().optional().describe("Extend the expiry on each edit"),
      if_revision: z.number().int().min(1).optional(),
      via: z.enum(["inline", "url"]).optional().describe("url: return an upload_url instead"),
    }),
  },
  {
    name: "pad_delete",
    description:
      "Delete a scratchpad safely: it stays readable and listed with its deadline, then is " +
      "permanently removed after ttl_days (default 30). restore true cancels the deletion; " +
      "ttl_days 0 removes it immediately and cannot be undone.",
    inputSchema: z.object({
      id: z.string().min(1).max(64),
      ttl_days: TtlDaysSchema.describe("Days before permanent removal; 0 deletes immediately"),
      restore: z.boolean().default(false).describe("Cancel a scheduled deletion"),
    }),
  },
  {
    name: "task_list",
    description: "List active tasks - compact layer-1 index. Does NOT include body/comments.",
    inputSchema: z.object({
      project: projectParam,
      status: TaskStatusSchema.optional().describe(
        "Filter by status; omit for active tasks (excludes done and cancelled)",
      ),
      tag: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional().default(20),
    }),
  },
  {
    name: "github_sync",
    description:
      "Inspect or configure project GitHub issue sync and synchronize issues as native tasks. Status changes sync both ways; imports never auto-start agents. Requires the API process.",
    inputSchema: z.object({
      project: projectParam,
      config: GithubSyncConfigSchema.optional(),
      run: z.boolean().optional().default(true).describe("false: only inspect/save configuration"),
    }),
  },
  {
    name: "task_get",
    description:
      "Fetch current task details by IDs (title, status, progress, git links, body and the latest comments).",
    inputSchema: z.object({
      project: projectParam,
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
      "Update task status, fields or git links, or add a comment. Status transitions are validated; null clears a nullable field.",
    inputSchema: z.object({
      project: projectParam,
      id: z.string(),
      status: TaskStatusSchema.optional(),
      title: z.string().min(1).max(500).optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).nullable().optional(),
      due_at: z.string().datetime().nullable().optional(),
      skill_name: z.string().nullable().optional(),
      required_review: z.boolean().optional(),
      max_review_rounds: z.number().int().min(1).optional(),
      git_branch: z.string().min(1).max(1024).nullable().optional(),
      github_issue: z
        .string()
        .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/)
        .nullable()
        .optional(),
      github_pr: z
        .string()
        .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/)
        .nullable()
        .optional()
        .describe("Pull request URL, e.g. https://github.com/owner/repo/pull/12"),
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
    description: "List all jobs with their enabled state, trigger, run count and id.",
    inputSchema: z.object({
      limit: z.number().int().optional().default(20),
      project: projectParam,
    }),
  },
  {
    name: "job_run",
    description: "Trigger a job by name.",
    inputSchema: z.object({
      project: projectParam,
      name: z.string(),
    }),
  },
  {
    name: "job_status",
    description:
      "Get run status + exit code + error for a specific run ID; pass logs:true to include output lines.",
    inputSchema: z.object({
      project: projectParam,
      run_id: z.string(),
      logs: z.boolean().optional().default(false),
      stream: z.enum(["stdout", "stderr"]).optional(),
      log_limit: z.number().int().min(1).max(2000).optional().default(200),
    }),
  },
  {
    name: "shell_run",
    description:
      "Start a detached background shell command outside the agent/daemon process tree with persistent disk logs and exit metadata. Survives turn teardown and ORC daemon restarts; use for long builds, test gates (e.g. ci:pr), or training runs.",
    inputSchema: z.object({
      command: z.string().trim().min(1).max(16_000),
      cwd: z.string().trim().min(1).describe("Working directory for the command"),
      label: z.string().trim().min(1).max(200).optional(),
      project: projectParam,
    }),
  },
  {
    name: "shell_status",
    description:
      "Inspect a detached background shell job started with shell_run: returns status (running, completed, failed, stopped, interrupted_by_restart), exit_code, signal, log_path, and optional log tail.",
    inputSchema: z.object({
      job_id: z.string().trim().min(1),
      logs: z.boolean().optional().default(true),
      tail_lines: z.number().int().min(1).max(2000).optional().default(100),
      tail_bytes: z.number().int().min(256).max(256_000).optional(),
    }),
  },
  {
    name: "shell_list",
    description:
      "List detached background shell jobs (newest first), optionally filtered by status or session.",
    inputSchema: z.object({
      status: BackgroundJobStatusSchema.optional(),
      session_id: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().default(20),
    }),
  },
  {
    name: "shell_stop",
    description: "Stop a running detached background shell job and its process group.",
    inputSchema: z.object({
      job_id: z.string().trim().min(1),
    }),
  },
  {
    name: "task_link",
    description:
      "List, add or remove links between existing tasks (blocks, blocked_by, relates_to, duplicates, clones, subtask_of, parent_of). Blocker links gate when a task may start.",
    inputSchema: z.object({
      project: projectParam,
      id: z.string().describe("Task ID"),
      action: z.enum(["list", "add", "remove"]).default("list"),
      to_task_id: z.string().optional().describe("Target task for add"),
      link_type: TaskLinkTypeSchema.optional().describe("Link type for add"),
      link_id: z.string().optional().describe("Link ID for remove"),
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
    name: "project_list",
    description:
      "List all projects. Returns name, status, id, scope, execution host, description and any scheduled deletion date for each.",
    inputSchema: z.object({
      status: z.enum(["active", "archived", "paused"]).optional(),
    }),
  },
  {
    name: "project_create",
    description:
      "Create a project when project_list has no match to reuse. Returns the stable project id, " +
      "name and a UI link. Names are unique case-insensitively: a duplicate is rejected with the " +
      "existing project's id and name, so retrying a create never makes a second project.",
    inputSchema: z.object({
      name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .min(1)
        .max(100)
        .describe("Unique project name; letters, digits, '-' and '_' only"),
      description: z.string().max(2000).optional(),
      status: z.enum(["active", "archived", "paused"]).optional().describe("Default: active"),
      tags: z.array(z.string().min(1).max(64)).max(50).optional(),
      git_remote_url: z
        .string()
        .trim()
        .max(2048)
        .refine(
          (value) => !value || isGitRemoteUrl(value),
          "Enter a Git remote URL without passwords, access tokens, query parameters or fragments",
        )
        .optional()
        .describe("Optional repository remote, e.g. https://github.com/acme/shop.git"),
      scope: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .optional()
        .describe("Folder the project's work runs in; sessions in it map to this project"),
      host: z
        .string()
        .trim()
        .regex(ALIAS_PATTERN)
        .nullable()
        .optional()
        .describe(
          'Optional execution host for this project: an SSH alias, "local", or null to inherit Settings default',
        ),
    }),
  },
  {
    name: "project_delete",
    description:
      "Delete a project safely: it is archived now and permanently removed after ttl_days (default 30). " +
      "Until then restore true cancels the deletion and reactivates it. ttl_days 0 removes it immediately and cannot be undone. " +
      "At removal, tasks, jobs and sessions are kept but unassigned; memories, scratchpads, comments, project secrets and its workspace environment go with it. " +
      "Knowledge bases and assigned skills must be deleted or reassigned first. " +
      "Name the project explicitly: this tool never falls back to the active project.",
    inputSchema: z
      .object({
        project: projectParam.describe(
          "Project name to delete or restore; required (no activeProject fallback)",
        ),
        project_id: z.string().min(1).max(100).optional().describe("Explicit project id"),
        ttl_days: TtlDaysSchema.describe(
          "Days to keep the archived project restorable; 0 deletes it immediately",
        ),
        restore: z
          .boolean()
          .default(false)
          .describe("Cancel a scheduled deletion and reactivate the project"),
      })
      .strict(),
  },
  {
    name: "skill_list",
    description:
      "List installed skills (built-in + user) with name, description and read count. " +
      "Defaults to 30 skills per page; use offset for the next page and q for hybrid lexical search sorted by descending relevance score. " +
      "Only the selected project's skills and global (unassigned) skills are available. " +
      "Hidden built-ins are omitted; named reads and authored overrides remain available.",
    inputSchema: z.object({
      q: z
        .string()
        .max(500)
        .optional()
        .describe("Search names and descriptions with prefixes, stemming and typo tolerance"),
      offset: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe("Zero-based page offset (default 0)"),
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
          "Skill-relative file path, e.g. scripts/check.py or references/guide.md. Bare filenames read references/; SKILL.md reads the raw root SKILL.md.",
        ),
    }),
  },
  {
    name: "skill_create",
    description:
      "Create a user skill folder with SKILL.md and optional supporting files. Assigned to the selected project; with no project it is global.",
    inputSchema: z.object({
      name: z.string().describe("Skill name (used as directory name)"),
      project: projectParam,
      scope: z.literal("global").optional(),
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
      "Discover shared APM .agent.md role profiles usable across coding backends. Profiles are role definitions, not execution harnesses; session_start's agent parameter lists the harness ids. Includes malformed definitions with validation errors.",
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
    name: "agent_update",
    description:
      "Replace an agent definition. Read it with agent_read first and pass its raw and path; a changed agent is rejected.",
    inputSchema: z
      .object({
        id: z.string().min(1).max(1024),
        content: z
          .string()
          .min(1)
          .max(8 * 1024 * 1024)
          .describe("Complete new .agent.md"),
        expected_raw: z.string().max(8 * 1024 * 1024),
        expected_path: z.string().min(1).max(4096),
      })
      .strict(),
  },
  {
    name: "agent_delete",
    description:
      "Delete an agent definition (package resources are kept). Pass the raw content from agent_read to confirm the version being deleted.",
    inputSchema: z
      .object({ id: z.string().min(1).max(1024), expected_raw: z.string().max(8 * 1024 * 1024) })
      .strict(),
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
    name: "agent_package_update",
    description:
      "Replace a package's manifest and complete file set (add, edit or drop files). Read it with agent_package_read first and pass its revision; the previous version is archived.",
    inputSchema: z
      .object({
        name: z.string().min(1).max(200),
        content: z
          .string()
          .min(1)
          .max(8 * 1024 * 1024)
          .describe("Complete apm.yml or plugin.json"),
        files: z
          .array(
            z.object({
              path: z.string().min(1).max(1024),
              content: z.string().max(12 * 1024 * 1024),
              encoding: z.enum(["utf8", "base64"]).optional(),
            }),
          )
          .max(512)
          .describe("Every file the package keeps; omitted files are removed"),
        expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  },
  {
    name: "agent_package_delete",
    description:
      "Remove a package from the shared catalog (archived; installed project copies are kept). Pass the revision from agent_package_read.",
    inputSchema: z
      .object({
        name: z.string().min(1).max(200),
        expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
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
    name: "goal_create",
    description:
      "Start a goal: ORC loops a worker agent and an external success check until the check passes, " +
      "within a budget. A stalled metric switches to the next allowed agent, then a reviewer, then one " +
      "human request. Returns the goal id; watch it with goal_status.",
    inputSchema: z.object({
      objective: z.string().min(1).max(2000).describe("What must become true"),
      check: z
        .string()
        .min(1)
        .max(4000)
        .describe("Shell command whose exit 0 means the goal is met; runs in the task's worktree"),
      metric_pattern: z
        .string()
        .max(500)
        .optional()
        .describe("Regex with one capture group extracting a progress metric from check stdout"),
      agents: z
        .array(z.string())
        .min(1)
        .max(4)
        .optional()
        .describe("Allowed worker backends in ladder order (default: claude)"),
      iterations: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max check iterations (default 30)"),
      tokens: z.number().int().min(1).optional().describe("Max recorded worker tokens"),
      hours: z.number().min(0.1).max(168).optional().describe("Max wall-clock hours (default 6)"),
      stall_limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Unchanged-metric iterations before switching agent (default 3)"),
      skill: z.string().optional().describe("Worker skill (default orc-coder)"),
      project: projectParam,
      task: z.string().optional().describe("Attach to an existing task instead of creating one"),
    }),
  },
  {
    name: "goal_status",
    description:
      "A goal's live status: iteration, agent stage, stall count, tokens used, last check output, " +
      "and the check history. Pass the goal id or the task id.",
    inputSchema: z.object({
      id: z.string().optional().describe("Goal ID"),
      task: z.string().optional().describe("Task ID the goal is attached to"),
    }),
  },
  {
    name: "goal_stop",
    description: "Stop a goal's flow and mark it stopped.",
    inputSchema: z.object({ id: z.string().describe("Goal ID") }),
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
  previewScope?: PreviewScope;
  /** Connection default projects: autofill and list defaults, never a permission boundary. */
  projectScopes?: readonly McpProject[];
  publicApiBaseUrl?: string;
  projectsChanged?: () => void;
  skillDownload?: (name: string, ref: string, projectId: string | null) => SkillDownload;
  /** Mints a scratchpad content URL in-process; stdio MCP asks the API, which holds the key. */
  padContentUrl?: (
    id: string,
    mode: "download" | "upload",
    author: string,
    ifRevision?: number,
  ) => ScratchpadContentUrl;
  /**
   * Native session id of the calling agent. Stdio MCP reads it from the agent's environment;
   * HTTP MCP receives it from the `session` query parameter on the MCP URL.
   */
  agentSessionId?: string | null;
  /**
   * Set when the calling identity is an auto-created MCP coordinator session rather than an
   * explicitly bound conversation. Session tools report it so external clients can reference
   * it; speak stays limited to explicit bindings.
   */
  coordinatorSessionId?: string | null;
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

/** Where the human opens a pad; the API serves the web UI in an installed ORC. */
function padLink(id: string, options: ToolOptions): string {
  return new URL(
    `/knowledge/scratchpads/${id}`,
    options.publicApiBaseUrl ?? orcApiBase(),
  ).toString();
}

async function padContentUrl(
  id: string,
  mode: "download" | "upload",
  options: ToolOptions,
  ifRevision?: number,
): Promise<ScratchpadContentUrl> {
  const { author } = memoryWriter(options);
  if (options.padContentUrl) return options.padContentUrl(id, mode, author, ifRevision);
  // The API checks the revision in the same step that mints the URL.
  return ScratchpadContentUrlSchema.parse(
    await orcApi("POST", `/scratchpads/${encodeURIComponent(id)}/content-url`, {
      body: { mode, author, if_revision: ifRevision },
      timeoutMs: 15_000,
    }),
  );
}

function padProjectName(projectId: string | null): string {
  if (!projectId) return "none";
  return (
    getSqlite()
      .query<{ name: string }, [string]>("SELECT name FROM projects WHERE id=?")
      .get(projectId)?.name ?? projectId
  );
}

/** Expiry state shown in pad lists and headers; stale deletes still show their own deadline. */
function padExpiryParts(
  pad: Pick<
    Scratchpad,
    "expires_at" | "pinned" | "keep_alive" | "expiry_skipped_reason" | "archived_at"
  >,
): string[] {
  const parts: string[] = [];
  if (pad.pinned) parts.push("pinned");
  if (pad.expires_at && !pad.archived_at && pad.expires_at <= MAX_EXPIRES_AT)
    parts.push(`expires ${new Date(pad.expires_at * 1000).toISOString().slice(0, 10)}`);
  if (pad.keep_alive) parts.push("keep-alive");
  if (pad.expiry_skipped_reason) parts.push(`expiry skipped: ${pad.expiry_skipped_reason}`);
  return parts;
}

function formatPadLine(pad: ScratchpadListItem): string {
  const tags = pad.tags.length ? ` #${pad.tags.join(" #")}` : "";
  const updated = new Date(pad.updated_at * 1000).toISOString();
  const deletes = pad.delete_after
    ? `, deletes ${new Date(pad.delete_after * 1000).toISOString().slice(0, 10)}`
    : "";
  const expiry = padExpiryParts(pad);
  return `${pad.id} [${pad.kind}] ${pad.title} - rev ${pad.revision}, ${pad.size_bytes} B, project ${padProjectName(pad.project_id)}, updated ${updated} by ${pad.author}${tags}${deletes}${expiry.length ? `, ${expiry.join(", ")}` : ""}`;
}

function padHeader(pad: Scratchpad, options: ToolOptions): string {
  const expiry = padExpiryParts(pad);
  return [
    `# ${pad.title}`,
    `id: ${pad.id} | kind: ${pad.kind} | revision: ${pad.revision} | author: ${pad.author}`,
    `project: ${padProjectName(pad.project_id)} | session: ${pad.session_id ?? "none"} | tags: ${pad.tags.join(", ") || "none"}`,
    ...(expiry.length ? [`expiry: ${expiry.join(" | ")}`] : []),
    ...(pad.delete_after
      ? [
          `deletes: ${new Date(pad.delete_after * 1000).toISOString().slice(0, 10)} (${ttlDaysLeft(pad.delete_after)} days left; pad_delete restore true cancels)`,
        ]
      : []),
    `link: ${padLink(pad.id, options)}`,
  ].join("\n");
}

function padById(store: ScratchpadStore, id: string): Scratchpad {
  return store.get(id);
}

function padProject(project: string): string {
  const resolved = resolveProjectId(project);
  if (!resolved) throw new NotFoundError("Project", project);
  return resolved.id;
}

/** Memories belong to a project; there is no global memory. */
function memoryProject(project: string | undefined, options: ToolOptions): string {
  const resolved = resolveProjectId(project ?? options.projectScopes?.[0]?.name);
  if (!resolved) {
    const names = getSqlite()
      .query<{ name: string }, []>(
        "SELECT name FROM projects WHERE status != 'archived' ORDER BY name LIMIT 25",
      )
      .all()
      .map((row) => row.name);
    throw new ValidationError(
      names.length
        ? `Memories belong to a project: pass project (available: ${names.join(", ")}) or set activeProject in ORC config. project_list shows each id.`
        : "Memories belong to a project: no projects exist yet, so create one with project_create or pass project once it exists.",
    );
  }
  return resolved.id;
}

/** Linked resources a project delete would detach or destroy, for the safety gate. */
function projectResourceCounts(projectId: string) {
  const sqlite = getSqlite();
  const count = (sql: string) => sqlite.query<{ n: number }, [string]>(sql).get(projectId)?.n ?? 0;
  return {
    task: count("SELECT count(*) AS n FROM tasks WHERE project_id=?"),
    session:
      count("SELECT count(*) AS n FROM gateway_sessions WHERE project_id=?") +
      count(
        "SELECT count(*) AS n FROM chat_threads WHERE json_valid(data) AND json_extract(data, '$.projectId')=?",
      ),
    memory: count("SELECT count(*) AS n FROM memories WHERE project_id=?"),
    job: count("SELECT count(*) AS n FROM jobs WHERE project_id=?"),
    pad: count("SELECT count(*) AS n FROM scratchpads WHERE project_id=?"),
    "knowledge base": projectKbCount(sqlite, projectId),
    skill: count("SELECT count(*) AS n FROM skill_projects WHERE project_id=?"),
  };
}

function formatMemoryLine(memory: MemoryListItem): string {
  const priority = memory.priority === null ? "" : ` [p${memory.priority}]`;
  const reads = ` (${memory.read_count} ${memory.read_count === 1 ? "read" : "reads"})`;
  return `${memory.name.padEnd(28)}${priority}${reads} - ${memory.description}`;
}
/** SQLite unique violation on projects.name, possibly wrapped as an error cause. */
function isUniqueNameFailure(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    const code = (e as { code?: unknown }).code;
    if (
      code === "SQLITE_CONSTRAINT_UNIQUE" ||
      code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      /UNIQUE constraint failed: projects\.name/i.test(e.message)
    )
      return true;
  }
  return false;
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

function selectedProjectIds(
  project: string | undefined,
  options: ToolOptions,
): string[] | undefined {
  const resolved = resolveProjectId(project);
  if (resolved) return [resolved.id];
  return options.projectScopes?.map((item) => item.id);
}

function resolveSkillScope(
  input: z.infer<typeof scopeParams>,
  options: ToolOptions,
  name: string,
): string | null {
  if (input.scope === "global") return null;
  if (input.project !== undefined) return resolveScope(input);
  if (!options.projectScopes) return resolveScope(input);
  return new SkillHistory(getSqlite()).preferredProject(
    name,
    options.projectScopes.map((p) => p.id),
  );
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

function callerOwns(caller: string | null | undefined, claimed: string): boolean {
  if (!caller || caller === claimed) return true;
  try {
    const session = new SessionMessageStore(getSqlite()).resolveSender(caller);
    return session.session_id === claimed || session.native_id === claimed;
  } catch {
    return false;
  }
}

export type DetailedToolResult = {
  text: string;
  data?: Record<string, unknown>;
};

export async function executeToolDetailed(
  name: ToolName,
  args: unknown,
  options: ToolOptions = {},
): Promise<DetailedToolResult> {
  let data: Record<string, unknown> | undefined;
  const text = await runTool(name, args, options, (structured) => {
    data = structured;
  });
  return data !== undefined ? { text, data } : { text };
}

export async function executeTool(
  name: ToolName,
  args: unknown,
  options: ToolOptions = {},
): Promise<string> {
  return runTool(name, args, options);
}

async function runTool(
  name: ToolName,
  args: unknown,
  options: ToolOptions = {},
  setData?: (data: Record<string, unknown>) => void,
): Promise<string> {
  if (previewToolDefinitions.some((tool) => tool.name === name))
    return executePreviewTool(name, args, options.previewScope);
  if (name.startsWith("channel_")) {
    const schema =
      name === "channel_list"
        ? channelScopeParams
        : name === "channel_targets"
          ? channelTargetsParams
          : name === "channel_send"
            ? channelSendParams
            : name === "channel_message_get"
              ? channelReadParams
              : channelEditParams;
    const parsed = schema.parse(args);
    const scope = parsed.project
      ? resolveProjectId(parsed.project)?.id
      : (parsed.project_id ?? options.projectScopes?.[0]?.id ?? resolveProjectId()?.id ?? null);
    const query = scope ? `?project_id=${encodeURIComponent(scope)}` : "";
    if (name === "channel_list") {
      const [connections, providers] = await Promise.all([
        orcApi("GET", `/channels${query}`),
        orcApi("GET", "/channels/providers"),
      ]);
      return JSON.stringify({ connections, providers });
    }
    if (name === "channel_targets") {
      const input = channelTargetsParams.parse(args);
      return JSON.stringify(
        await orcApi("GET", `/channels/${encodeURIComponent(input.connection)}/targets${query}`),
      );
    }
    if (name === "channel_send") {
      const { project: _project, ...input } = channelSendParams.parse(args);
      return JSON.stringify(
        await orcApi("POST", "/channels/messages", { body: { ...input, project_id: scope } }),
      );
    }
    const input =
      name === "channel_message_get"
        ? channelReadParams.parse(args)
        : channelEditParams.parse(args);
    const path = `/channels/messages/${encodeURIComponent(input.id)}`;
    if (name === "channel_message_get")
      return JSON.stringify(await orcApi("GET", `${path}${query}`));
    const { id: _id, project: _project, ...body } = channelEditParams.parse(args);
    return JSON.stringify(await orcApi("PATCH", path, { body: { ...body, project_id: scope } }));
  }
  if (name === "human_request" || name === "command_request") {
    const { project, ...input } =
      name === "command_request"
        ? { ...commandCreateParams.parse(args), kind: "command" as const }
        : humanCreateParams.parse(args);
    const scope = project
      ? resolveProjectId(project)?.id
      : (input.project_id ?? options.projectScopes?.[0]?.id ?? resolveProjectId()?.id ?? null);
    if (!callerOwns(options.agentSessionId, input.origin.session_id))
      throw new ValidationError("Human request must belong to the calling agent session");
    return JSON.stringify(
      await orcApi("POST", "/human-requests", { body: { ...input, project_id: scope } }),
    );
  }
  if (name === "human_request_get" || name === "human_request_acknowledge") {
    const input =
      name === "human_request_get" ? humanGetParams.parse(args) : humanAckParams.parse(args);
    const path = `/human-requests/${encodeURIComponent(input.id)}`;
    const read = async () => {
      const request = HumanRequestSchema.parse(await orcApi("GET", path));
      if (!callerOwns(options.agentSessionId, request.input.origin.session_id))
        throw new ValidationError("Human request belongs to another agent session");
      return request;
    };
    let request = await read();
    if ("version" in input)
      return JSON.stringify(
        await orcApi("POST", `${path}/acknowledge`, { body: { version: input.version } }),
      );
    const deadline = Date.now() + input.wait_seconds * 1000;
    while (["pending", "running"].includes(request.status) && Date.now() < deadline) {
      await Bun.sleep(Math.min(500, deadline - Date.now()));
      request = await read();
    }
    if (request.input.kind === "secret") {
      if (request.status === "answered" && request.response?.kind === "secret") {
        if (request.response.consumed) {
          return JSON.stringify({
            ...request,
            secret: true,
            secret_delivery: { status: "consumed" },
          });
        }
        const claimed = SecretClaimResultSchema.parse(await orcApi("POST", `${path}/claim`));
        if (claimed.values) registerRedactedSecrets(Object.values(claimed.values));
        return JSON.stringify({
          ...claimed.request,
          secret: true,
          secret_delivery: claimed.stored
            ? {
                status: "delivered",
                stored: true,
                references: claimed.references ?? {},
              }
            : {
                status: "delivered",
                stored: false,
                values: claimed.values ?? {},
              },
        });
      }
      if (request.status === "delivered") {
        return JSON.stringify({
          ...request,
          secret: true,
          secret_delivery: { status: "consumed" },
        });
      }
    }
    return JSON.stringify(request);
  }
  if (name === "project_secret_list") {
    const input = scopedProjectParams.parse(args);
    const scope =
      input.project_id !== undefined
        ? input.project_id
        : input.project
          ? resolveProjectId(input.project)?.id
          : (options.projectScopes?.[0]?.id ?? resolveProjectId()?.id ?? null);
    if (!scope) throw new ValidationError("Select a project to list its secrets");
    return JSON.stringify(await orcApi("GET", `/projects/${encodeURIComponent(scope)}/secrets`));
  }
  if (name === "human_request_snooze" || name === "human_request_unsnooze") {
    const input =
      name === "human_request_snooze"
        ? humanSnoozeParams.parse(args)
        : humanUnsnoozeParams.parse(args);
    const path = `/human-requests/${encodeURIComponent(input.id)}`;
    const existing = HumanRequestSchema.parse(await orcApi("GET", `${path}/view`));
    if (!callerOwns(options.agentSessionId, existing.input.origin.session_id))
      throw new ValidationError("Human request belongs to another agent session");
    if (name === "human_request_snooze") {
      const snoozeInput = input as z.infer<typeof humanSnoozeParams>;
      return JSON.stringify(
        await orcApi("POST", `${path}/snooze`, {
          body: {
            version: snoozeInput.version,
            ...(snoozeInput.until !== undefined ? { until: snoozeInput.until } : {}),
            ...(snoozeInput.after_seconds !== undefined
              ? { after_seconds: snoozeInput.after_seconds }
              : {}),
          },
        }),
      );
    }
    const query = input.version !== undefined ? `?version=${input.version}` : "";
    return JSON.stringify(await orcApi("DELETE", `${path}/snooze${query}`));
  }
  if (name === "session_sync") {
    const grant = await orcApi<{ sync_url: string }>("POST", "/sessions/archive/sync", {
      body: SessionSyncInputSchema.parse(args),
    });
    if (options.publicApiBaseUrl)
      grant.sync_url = new URL(
        new URL(grant.sync_url).pathname,
        options.publicApiBaseUrl,
      ).toString();
    return JSON.stringify(grant);
  }
  if (name === "session_search") {
    const input = ArchiveSearchSchema.omit({ project_id: true, project_ids: true })
      .extend({ project: projectParam })
      .parse(args);
    const project = resolveProjectId(input.project);
    const params = new URLSearchParams({
      q: input.q,
      mode: input.mode,
      limit: String(input.limit),
      offset: String(input.offset),
      ...(project
        ? { project_id: project.id }
        : options.projectScopes
          ? { project_ids: options.projectScopes.map((p) => p.id).join(",") }
          : {}),
      ...(input.agent ? { agent: input.agent } : {}),
    });
    return JSON.stringify(await orcApi("GET", `/sessions/archive?${params}`));
  }
  if (name === "session_read") {
    const input = z
      .object({
        id: z.string().trim().min(1).max(200),
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
    try {
      return JSON.stringify(
        await orcApi(
          "GET",
          `/sessions/archive/${encodeURIComponent(input.id)}/${input.ordinal !== undefined ? "passage" : "transcript"}?${params}`,
        ),
      );
    } catch (err) {
      if (!(err instanceof OrcError) || err.statusCode !== 404 || input.ordinal !== undefined)
        throw err;
      const liveParams = new URLSearchParams({
        offset: String(input.offset),
        limit: String(input.limit),
      });
      const transcript = await orcApi<{
        total: number;
        offset: number;
        turns: {
          index: number;
          role: string;
          time: string | null;
          blocks: Array<
            | { type: "text"; text: string }
            | { type: "thinking"; text: string }
            | { type: "tool_use"; name: string; input?: string }
            | { type: "tool_result"; content: string }
          >;
        }[];
      }>("GET", `/sessions/live/${encodeURIComponent(input.id)}/transcript?${liveParams}`);
      const turns = transcript.turns.map((turn) => ({
        index: turn.index,
        role: turn.role,
        time: turn.time,
        content: turn.blocks
          .map((block) => {
            if (block.type === "text") return block.text;
            if (block.type === "tool_use") {
              return block.input ? `[tool:${block.name}] ${block.input}` : `[tool:${block.name}]`;
            }
            if (block.type === "tool_result") return `[result] ${block.content}`;
            return "";
          })
          .filter(Boolean)
          .join("\n"),
      }));
      return JSON.stringify({
        session_id: input.id,
        source: "live",
        total: transcript.total,
        offset: transcript.offset,
        turns,
      });
    }
  }
  if (isKbTool(name)) {
    const input = args as Record<string, unknown>;
    const project = typeof input.project === "string" ? input.project : undefined;
    return executeKbTool(
      name,
      input,
      resolveProjectId(project)?.id ?? null,
      options.projectScopes?.map((p) => p.id),
    );
  }
  if (name === "speak") {
    if (!options.agentSessionId || options.coordinatorSessionId)
      throw new ValidationError(
        "speak needs the calling conversation; reconnect MCP with ?session=<session id>",
      );
    const { posted, spoken } = await orcApi<{ posted: boolean; spoken: boolean }>(
      "POST",
      `/chat/threads/${encodeURIComponent(options.agentSessionId)}/speak`,
      { body: z.object({ text: z.string() }).parse(args) },
    );
    return spoken
      ? "Spoken."
      : posted
        ? "Posted to the chat; voice mode is off."
        : "Not delivered: this conversation is not responding.";
  }
  if (name === "session_send") {
    const { prompt, mode, session_id } = sessionSendToolSchema.parse(args);
    const input = { session_id, body: prompt, ...(mode ? { mode } : {}) };
    const mode_ = input.mode ?? "queue";
    if (!options.agentSessionId && mode_ !== "queue")
      throw new ForbiddenError(
        `session_send with mode "${mode_}" requires a bound calling session identity; reconnect MCP with ?session=<session id> or X-ORC-Session, or use mode "queue"`,
      );
    return JSON.stringify(
      SessionMessageResultSchema.parse(
        await orcApi("POST", "/session-messages", {
          body: input,
          ...(options.agentSessionId
            ? { headers: { "X-ORC-Session": options.agentSessionId } }
            : {}),
        }),
      ),
    );
  }
  if (name === "session_options") {
    const input = sessionOptionsToolSchema.parse(args);
    const [ssh, providerSettings, settings] = await Promise.all([
      orcApi<{ host: string | null; hosts: string[]; locked: boolean }>("GET", "/ssh"),
      orcApi<{
        defaultProviderId: string | null;
        providers: Array<{ id: string; name: string; agent: string; model?: string }>;
      }>("GET", "/settings/providers"),
      orcApi<{
        chat?: {
          agent?: string;
          model?: string;
          providerId?: string;
          permissionMode?: string;
          sendWhileRunning?: string;
        };
        composer_profiles?: Array<{
          id: string;
          name: string;
          agent: string;
          providerId?: string;
          model?: string;
          effort?: string;
          permissionMode?: string;
        }>;
      }>("GET", "/settings"),
    ]);
    const chatDefaults = providerChatDefaults();
    const targetAgent = input.agent ?? chatDefaults.agent;
    const includeModels = input.include_models || input.agent !== undefined;
    let models: { models: unknown[]; warning: string | null } | undefined;
    let capabilities: { backend: string; capabilities: Record<string, unknown> } | undefined;
    if (includeModels) {
      const modelParams = new URLSearchParams({
        agent: targetAgent,
        ...(input.provider_id ? { providerId: input.provider_id } : {}),
        ...(input.host ? { host: input.host } : {}),
      });
      const [modelsResult, capsResult] = await Promise.all([
        orcApi<{ models: unknown[]; warning: string | null }>(
          "GET",
          `/chat/models?${modelParams}`,
        ).catch(() => undefined),
        orcApi<{ backend: string; capabilities: Record<string, unknown> }>(
          "GET",
          `/chat/capabilities?agent=${encodeURIComponent(targetAgent)}`,
        ).catch(() => undefined),
      ]);
      models = modelsResult;
      capabilities = capsResult;
    }
    return JSON.stringify({
      defaults: {
        agent: chatDefaults.agent,
        model: chatDefaults.model || null,
        provider_id: chatDefaults.providerId ?? null,
        permission_mode: settings.chat?.permissionMode ?? "default",
        send_while_running: settings.chat?.sendWhileRunning ?? "queue",
        host: ssh.host,
      },
      agents: CODING_AGENTS.map((entry) => entry.id),
      hosts: ssh.hosts,
      providers: providerSettings.providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        agent: provider.agent,
        model: provider.model ?? null,
      })),
      profiles: settings.composer_profiles ?? [],
      ...(includeModels
        ? {
            agent: targetAgent,
            models: models?.models ?? [],
            models_warning: models?.warning ?? null,
            capabilities: capabilities?.capabilities ?? null,
          }
        : {}),
    });
  }
  if (name === "session_list") {
    const input = sessionListToolSchema.parse(args);
    const scope = input.scope ?? "all";
    if ((scope === "children" || input.parent === "self") && !options.agentSessionId) {
      throw new ValidationError(
        `session_list with scope "${scope}" needs the calling session identity; reconnect MCP with ?session=<session id>, pass X-ORC-Session, or run inside an agent session`,
      );
    }
    const params = new URLSearchParams({
      scope,
      limit: String(input.limit),
      offset: String(input.offset),
    });
    if (input.parent) params.set("parent", input.parent);
    if (input.project === "unassigned") {
      params.set("project_id", "unassigned");
    } else if (input.project && input.project !== "all") {
      params.set("project_id", padProject(input.project));
    } else if (
      input.project !== "all" &&
      scope !== "children" &&
      !input.parent &&
      options.projectScopes?.length
    ) {
      params.set("project_ids", options.projectScopes.map((p) => p.id).join(","));
    }
    if (input.agent) params.set("agent", input.agent);
    if (input.status) params.set("status", input.status);
    if (input.host) params.set("host", input.host);
    if (input.q) params.set("q", input.q);
    if (input.include_hidden) params.set("include_hidden", "true");
    if (input.include_subagents) params.set("include_subagents", "true");
    if (input.sync) params.set("sync", "true");
    const result = SessionListResponseSchema.parse(
      await orcApi("GET", `/sessions/live/list?${params}`, {
        ...(options.agentSessionId ? { headers: { "X-ORC-Session": options.agentSessionId } } : {}),
      }),
    );
    const coordinator = options.coordinatorSessionId ?? null;
    return JSON.stringify(
      coordinator ? { ...result, coordinator_session_id: coordinator } : result,
    );
  }
  if (name === "session_update") {
    const { session_id, ...patch } = sessionUpdateToolSchema.parse(args);
    return JSON.stringify(
      await orcApi("PATCH", `/sessions/live/${encodeURIComponent(session_id)}`, {
        body: patch,
        ...(options.agentSessionId ? { headers: { "X-ORC-Session": options.agentSessionId } } : {}),
      }),
    );
  }
  if (
    name === "session_start" ||
    name === "session_status" ||
    name === "session_wait" ||
    name === "session_delete" ||
    name === "session_stop"
  ) {
    if (!options.agentSessionId && name !== "session_status") {
      const message = `${name} needs the calling session identity; reconnect MCP with ?session=<session id>, pass X-ORC-Session, or run inside an agent session`;
      throw name === "session_stop" ? new ForbiddenError(message) : new ValidationError(message);
    }
    const headers = options.agentSessionId
      ? { "X-ORC-Session": options.agentSessionId }
      : undefined;
    const coordinator = options.coordinatorSessionId ?? null;
    if (name === "session_start") {
      const { project, ...input } = sessionSpawnToolSchema.parse(args);
      const defaults = providerChatDefaults();
      const defaultsInfo = {
        agent: defaults.agent,
        model: defaults.model,
        provider_id: defaults.providerId ?? null,
      };
      let status: z.infer<typeof SessionStatusSchema>;
      try {
        status = SessionStatusSchema.parse(
          await orcApi("POST", "/sessions/live/spawn", {
            body: {
              ...input,
              notify: input.notify ?? !coordinator,
              ...(project ? { project_id: padProject(project) } : {}),
            },
            ...(headers ? { headers } : {}),
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const payload = {
          error: message,
          ...(coordinator ? { coordinator_session_id: coordinator } : {}),
          defaults: defaultsInfo,
        };
        if (error instanceof OrcError) {
          throw new OrcError(JSON.stringify(payload), error.code, error.statusCode, {
            ...(error.details ?? {}),
            ...payload,
          });
        }
        throw new OrcError(JSON.stringify(payload), "VALIDATION_ERROR", 400, payload);
      }
      if (!coordinator) return JSON.stringify(status);
      return JSON.stringify({
        ...status,
        coordinator_session_id: coordinator,
        defaults: defaultsInfo,
      });
    }
    const scoped = async (id: string) => {
      const current = SessionStatusSchema.parse(
        await orcApi("GET", `/sessions/live/${encodeURIComponent(id)}/status`, {
          ...(headers ? { headers } : {}),
        }),
      );
      return current;
    };
    if (name === "session_delete") {
      const input = z
        .object({ session_id: z.string().min(1).max(200), restore: z.boolean().default(false) })
        .strict()
        .parse(args);
      await scoped(input.session_id);
      return JSON.stringify(
        await orcApi("PATCH", `/sessions/live/${encodeURIComponent(input.session_id)}`, {
          body: { hidden: !input.restore },
          ...(headers ? { headers } : {}),
        }),
      );
    }
    if (name === "session_wait") {
      const input = SessionWaitSchema.extend({
        session_id: z.string().min(1).max(200).optional(),
        session_ids: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
        mode: z.enum(["all", "any"]).default("all"),
      }).parse(args);
      const ids = input.session_ids ?? (input.session_id ? [input.session_id] : []);
      if (!ids.length) throw new ValidationError("Pass session_id or session_ids");
      for (const id of ids) await scoped(id);
      const wait = SessionWaitManySchema.parse({
        session_ids: ids,
        mode: input.mode,
        until: input.until,
        timeout_s: input.timeout_s,
      });
      const result = await orcApi<{ sessions: unknown[]; timed_out: boolean }>(
        "POST",
        "/sessions/live/wait",
        { body: wait, ...(headers ? { headers } : {}), timeoutMs: (wait.timeout_s + 30) * 1000 },
      );
      return JSON.stringify(
        input.session_ids
          ? result
          : { ...(result.sessions[0] as object), timed_out: result.timed_out },
      );
    }
    const { session_id, cascade } = z
      .object({ session_id: z.string().min(1).max(200), cascade: z.boolean().default(true) })
      .passthrough()
      .parse(args);
    const current = await scoped(session_id);
    if (name === "session_status") return JSON.stringify(current);
    return JSON.stringify(
      SessionStatusSchema.parse(
        await orcApi(
          "POST",
          `/sessions/live/${encodeURIComponent(session_id)}/stop?cascade=${cascade}`,
          { ...(headers ? { headers } : {}) },
        ),
      ),
    );
  }
  if (name === "session_handoff") {
    const input = SessionHandoffInputSchema.parse(args);
    const config = loadConfig();
    const response = await fetch(`${resolveApiBase(config)}/api/session-handoffs`, {
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
    case "skill_file_write": {
      const { name: skillName, project, scope, ...input } = skillFileWriteParams.parse(args);
      if (input.path === "SKILL.md")
        throw new ValidationError("Edit SKILL.md with skill_update so the change stays scoped");
      const history = new SkillHistory(getSqlite(db));
      if (!history.visible(skillName, resolveSkillScope({ project, scope }, options, skillName)))
        throw new NotFoundError("Skill", skillName);
      const skill = history.writeFile({
        name: skillName,
        path: input.path,
        content: input.content,
        expectedContent: input.expected_content,
        reason: input.reason,
        author: process.env.ORC_AGENT ?? "agent",
        sessionId: input.session_id ?? process.env.ORC_SESSION_ID,
      });
      return `${input.expected_content === null ? "Added" : "Updated"} ${input.path} in ${skill.name}`;
    }
    case "skill_history": {
      const input = skillHistoryParams.parse(args);
      return JSON.stringify({
        changes: new SkillHistory(getSqlite(db)).history(
          input.name,
          resolveSkillScope(input, options, input.name),
        ),
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
          ...(input.scope !== "global" && options.projectScopes
            ? { projectIds: options.projectScopes.map((p) => p.id) }
            : {}),
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
      // A project-less caller (for example an external coordinator with no
      // activeProject) gets every memory it can already access, grouped by
      // project, instead of the dead-end "pass project" error.
      // A connection scoped to several projects keeps that scope (the server also
      // fills project with the first one); otherwise project is authoritative.
      const projectIds =
        project !== undefined
          ? [memoryProject(project, options)]
          : options.projectScopes
            ? options.projectScopes.map((item) => item.id)
            : undefined;
      const matched = new MemoryStore(getSqlite(db)).list(projectIds ?? null, { q, sort });
      const shown = matched.slice(0, limit ?? MEMORY_LIST_LIMIT);
      setData?.({ memories: shown, total: matched.length });
      const projectNames = new Map(
        getSqlite(db)
          .query<{ id: string; name: string }, []>("SELECT id, name FROM projects")
          .all()
          .map((row) => [row.id, row.name]),
      );
      const groupByProject = !projectIds || projectIds.length > 1;
      const more =
        matched.length > shown.length
          ? [`Showing ${shown.length} of ${matched.length}; use q to search or raise limit.`]
          : [];
      return [
        shown
          .map((memory) => {
            const label = groupByProject
              ? ` [project: ${projectNames.get(memory.project_id) ?? memory.project_id}]`
              : "";
            return `${formatMemoryLine(memory)}${label}`;
          })
          .join("\n") || "No memories found.",
        ...more,
      ].join("\n");
    }

    case "memory_read": {
      const { name: memoryName, project } = args as { name: string; project?: string };
      const ids = selectedProjectIds(project, options) ?? [memoryProject(project, options)];
      const owner = ids.find((id) =>
        getSqlite(db)
          .query("SELECT 1 FROM memories WHERE project_id=? AND name=?")
          .get(id, memoryName),
      );
      const memory = new MemoryStore(getSqlite(db)).read(
        owner ?? (ids[0] as string),
        memoryName,
        "mcp",
      );
      const priority = memory.priority === null ? "" : ` (priority ${memory.priority})`;
      setData?.({
        name: memory.name,
        description: memory.description,
        content: memory.content,
        priority: memory.priority,
        project_id: memory.project_id,
      });
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
        project_id: memoryProject(input.project, options),
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
      new MemoryStore(getSqlite(db)).update(memoryProject(project, options), memoryName, fields, {
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
      new MemoryStore(getSqlite(db)).remove(memoryProject(project, options), memoryName, {
        ...memoryWriter(options),
        reason,
      });
      return `Deleted memory ${memoryName}; memory_revert can restore it`;
    }

    case "memory_history": {
      const { name: memoryName, project } = args as { name: string; project?: string };
      return JSON.stringify({
        changes: new MemoryStore(getSqlite(db)).history(
          memoryProject(project, options),
          memoryName,
        ),
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
        memoryProject(input.project, options),
        input.name,
        input.change_id,
        input.expected_change_id,
        { ...memoryWriter(options), reason: input.reason },
      );
      return memory ? `Reverted memory ${memory.name}` : `Reverted: memory ${input.name} removed`;
    }

    case "pad_list": {
      const input = args as {
        kind?: ScratchpadKind;
        project?: string;
        unassigned?: boolean;
        session?: string;
        tag?: string;
        q?: string;
        expiry?: "expiring" | "expired";
        pinned?: boolean;
        limit?: number;
      };
      const session =
        input.session === "current" ? (options.agentSessionId ?? undefined) : input.session;
      if (input.session === "current" && !session)
        throw new ValidationError("This agent's session id is unknown; pass a session id");
      const scopes = options.projectScopes?.map((p) => p.id);
      const pads = new ScratchpadStore(getSqlite(db))
        .list({
          kind: input.kind,
          project_id: input.unassigned
            ? null
            : input.project
              ? resolveProjectId(input.project)?.id
              : undefined,
          session_id: session,
          tag: input.tag,
          q: input.q,
          expiry: input.expiry,
          pinned: input.pinned,
        })
        // A project-scoped connection sees its projects' pads and pads without a project.
        .filter((pad) => !scopes || !pad.project_id || scopes.includes(pad.project_id));
      const shown = pads.slice(0, input.limit ?? 50);
      return [
        shown.map(formatPadLine).join("\n") || "No scratchpads found.",
        ...(pads.length > shown.length
          ? [`Showing ${shown.length} of ${pads.length}; filter or raise limit.`]
          : []),
      ].join("\n");
    }

    case "pad_get": {
      const { id, via } = args as { id: string; via?: "inline" | "url" };
      const pad = padById(new ScratchpadStore(getSqlite(db)), id);
      if (via === "url") return JSON.stringify(await padContentUrl(id, "download", options));
      return `${padHeader(pad, options)}\n---\n${pad.content}`;
    }

    case "pad_create": {
      const input = args as {
        kind: ScratchpadKind;
        title: string;
        content?: string;
        project?: string;
        tags?: string[];
        link_session?: boolean;
        ttl?: string;
        expires_at?: number;
        pinned?: boolean;
        keep_alive?: boolean;
      };
      const writer = memoryWriter(options);
      const pad = new ScratchpadStore(getSqlite(db)).create({
        kind: input.kind,
        title: input.title,
        content: input.content,
        project_id: input.project ? padProject(input.project) : null,
        session_id: input.link_session === false ? null : writer.session_id,
        tags: input.tags,
        author: writer.author,
        ttl: input.ttl,
        expires_at: input.expires_at,
        pinned: input.pinned,
        keep_alive: input.keep_alive,
      });
      return `Created ${pad.kind} scratchpad ${pad.id} (revision ${pad.revision}): ${padLink(pad.id, options)}`;
    }

    case "pad_update": {
      const { id, via, project, ...fields } = args as {
        id: string;
        title?: string;
        content?: string;
        project?: string | null;
        tags?: string[];
        ttl?: string | null;
        expires_at?: number | null;
        pinned?: boolean;
        keep_alive?: boolean;
        if_revision?: number;
        via?: "inline" | "url";
      };
      const store = new ScratchpadStore(getSqlite(db));
      padById(store, id);
      if (via === "url") {
        if (
          fields.content !== undefined ||
          fields.title !== undefined ||
          fields.tags !== undefined ||
          fields.ttl !== undefined ||
          fields.expires_at !== undefined ||
          fields.pinned !== undefined ||
          fields.keep_alive !== undefined ||
          project !== undefined
        )
          throw new ValidationError(
            "via:'url' only returns an upload URL; update metadata in a separate call",
          );
        return JSON.stringify(await padContentUrl(id, "upload", options, fields.if_revision));
      }
      const pad = store.update(id, {
        ...fields,
        ...(project === undefined
          ? {}
          : { project_id: project === null ? null : padProject(project) }),
        author: memoryWriter(options).author,
      });
      return `Updated scratchpad ${pad.id} to revision ${pad.revision}: ${padLink(pad.id, options)}`;
    }

    case "pad_delete": {
      const { id, ttl_days, restore } = args as {
        id: string;
        ttl_days?: number;
        restore?: boolean;
      };
      const store = new ScratchpadStore(getSqlite(db));
      padById(store, id);
      if (restore) {
        store.restore(id);
        return `Restored scratchpad ${id}; active with no scheduled deletion`;
      }
      const deleted = store.delete(id, ttl_days ?? DEFAULT_TTL_DAYS);
      if (!deleted) return `Deleted scratchpad ${id}`;
      const until = new Date((deleted.delete_after ?? 0) * 1000).toISOString().slice(0, 10);
      return `Scheduled deletion of scratchpad ${id} in ${ttlDaysLeft(deleted.delete_after ?? 0)} days (${until}); pad_list shows it until then. pad_delete restore true cancels.`;
    }

    case "task_list": {
      const { project, status, tag, limit } = args as {
        project?: string;
        status?: TaskStatus;
        tag?: string;
        limit?: number;
      };
      const projectIds = selectedProjectIds(project, options);
      const conditions = [];
      if (status) {
        conditions.push(eq(tasks.status, status));
      }
      if (projectIds) conditions.push(inArray(tasks.project_id, projectIds));
      if (!status) conditions.push(notInArray(tasks.status, ["done", "cancelled"]));
      if (tag)
        conditions.push(
          sql`EXISTS (SELECT 1 FROM json_each(${tasks.tags}) WHERE json_each.value = ${tag})`,
        );
      const rows = await db.query.tasks.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        limit: limit ?? 20,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filtered = status
        ? rows
        : rows.filter((t) => !["done", "cancelled"].includes(t.status));
      setData?.({
        tasks: filtered.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          progress: t.progress,
          project_id: t.project_id,
          tags: t.tags,
          git_branch: t.git_branch,
          github_pr: t.github_pr,
          github_issue: t.github_issue,
          ...(t.github_sync ? { github_sync: t.github_sync } : {}),
        })),
        count: filtered.length,
      });
      if (filtered.length === 0) return status ? `No ${status} tasks.` : "No active tasks.";
      return filtered
        .map(
          (t) =>
            `[${t.id}] ${t.status.padEnd(18)} ${t.priority.padEnd(8)} ${t.progress}% ${t.title}` +
            (t.github_sync
              ? ` [GitHub #${t.github_sync.number}${t.github_sync.error ? "; sync error" : ""}]`
              : "") +
            (options.projectScopes && options.projectScopes.length > 1
              ? ` [project: ${options.projectScopes.find((p) => p.id === t.project_id)?.name}]`
              : ""),
        )
        .join("\n");
    }

    case "task_get": {
      const { ids } = args as { ids: string[] };
      const rows = await Promise.all(
        ids.map((id) => db.query.tasks.findFirst({ where: eq(tasks.id, id) })),
      );
      const found = rows.filter((t): t is NonNullable<typeof t> => Boolean(t));
      if (found.length === 0) {
        setData?.({ tasks: [] });
        return `Task not found: ${ids.join(", ")}`;
      }
      const entries = await Promise.all(
        found.map(async (t) => {
          const recent = await db.query.comments.findMany({
            where: and(eq(comments.resource_type, "task"), eq(comments.resource_id, t.id)),
            orderBy: [desc(comments.created_at)],
            limit: 20,
          });
          const chronological = recent.reverse();
          const data: Record<string, unknown> = {
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            progress: t.progress,
            project_id: t.project_id,
            body: t.body ?? null,
            tags: t.tags,
            git_branch: t.git_branch,
            github_pr: t.github_pr,
            github_issue: t.github_issue,
            github_sync: t.github_sync ?? null,
            comments: chronological.map((c) => ({
              id: c.id,
              author: c.author,
              content: c.content,
              created_at: c.created_at.toISOString(),
            })),
          };
          const links = [
            t.git_branch && `Branch: ${t.git_branch}`,
            t.github_pr && `PR: ${t.github_pr}`,
            t.github_issue && `Issue: ${t.github_issue}`,
            t.github_sync &&
              `GitHub sync: ${t.github_sync.error ?? (t.status !== t.github_sync.status ? "status pending" : "synced")}`,
          ].filter(Boolean);
          const thread = chronological.map(
            (c) => `- ${c.created_at.toISOString()} ${c.author}: ${c.content}`,
          );
          const section = [
            `[${t.id}] ${t.status} - ${t.title}`,
            `Progress: ${t.progress}%`,
            ...links,
            t.body ?? "",
            ...(thread.length > 0 ? ["", `Comments (latest ${thread.length}):`, ...thread] : []),
          ].join("\n");
          return { section, data };
        }),
      );
      setData?.({ tasks: entries.map((entry) => entry.data) });
      return entries.map((entry) => entry.section).join("\n\n");
    }

    case "github_sync": {
      const input = args as {
        project?: string;
        config?: z.infer<typeof GithubSyncConfigSchema>;
        run?: boolean;
      };
      const target = resolveProjectId(input.project ?? options.projectScopes?.[0]?.name);
      if (!target) throw new NotFoundError("Project", input.project ?? "active project");
      if (input.config)
        await orcApi("PATCH", `/projects/${encodeURIComponent(target.id)}`, {
          body: { github_sync: input.config },
        });
      if (input.run !== false) {
        const result = await orcApi<GithubSyncState>(
          "POST",
          `/projects/${encodeURIComponent(target.id)}/github-sync`,
        );
        return JSON.stringify(result);
      }
      const current = await db.query.projects.findFirst({ where: eq(projects.id, target.id) });
      return JSON.stringify({
        config: current?.github_sync ?? null,
        state: current?.github_sync_state ?? null,
      });
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
      const resolved = resolveProjectId(project ?? options.projectScopes?.[0]?.name);
      const id = ulid();
      const now = new Date();
      withTaskAudit(getSqlite(), [id], () => {
        db.insert(tasks)
          .values({
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
            origin_session_id: options.agentSessionId ?? null,
            created_at: now,
            updated_at: now,
          })
          .run();
      });
      const proj = resolved ? ` (${resolved.name})` : "";
      import("@orc/runner/task-loop")
        .then((m) => m.triggerTaskCheck())
        .catch((err) => logger.warn("triggerTaskCheck failed", { err }));
      return `Created: ${id} - ${title}${proj}`;
    }

    case "task_update": {
      const {
        id,
        status,
        comment,
        project: _project,
        ...fields
      } = args as {
        id: string;
        project?: string;
        status?: TaskStatus;
        comment?: string;
        title?: string;
        body?: string;
        priority?: "low" | "normal" | "high" | "critical";
        progress?: number;
        tags?: string[] | null;
        due_at?: string | null;
        skill_name?: string | null;
        required_review?: boolean;
        max_review_rounds?: number;
        git_branch?: string | null;
        github_issue?: string | null;
        github_pr?: string | null;
        agent_backend?: string;
        agent_model?: string;
      };
      const existing = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
      if (!existing) throw new NotFoundError("Task", id);
      validateGithubTaskEdit(existing, fields);
      if (status && status !== existing.status) {
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
      const editable = [
        "title",
        "body",
        "priority",
        "progress",
        "tags",
        "due_at",
        "skill_name",
        "required_review",
        "max_review_rounds",
        "git_branch",
        "github_issue",
        "github_pr",
        "agent_backend",
        "agent_model",
      ] as const;
      const changes = Object.fromEntries(
        editable.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]),
      );
      if (Object.keys(changes).length > 0) {
        const { due_at, ...rest } = changes as typeof fields;
        await db
          .update(tasks)
          .set({
            ...rest,
            ...(due_at !== undefined ? { due_at: due_at ? new Date(due_at) : null } : {}),
            updated_at: new Date(),
          })
          .where(eq(tasks.id, id));
      }
      import("@orc/runner/task-loop")
        .then((m) => m.triggerTaskCheck())
        .catch((err) => logger.warn("triggerTaskCheck failed", { err }));
      return `Updated: ${id}`;
    }

    case "job_list": {
      const { limit, project } = args as { limit?: number; project?: string };
      const projectIds = selectedProjectIds(project, options);
      const conditions = projectIds ? [inArray(jobs.project_id, projectIds)] : [];
      const rows = await db.query.jobs.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        limit: limit ?? 20,
      });
      setData?.({
        jobs: rows.map((j) => ({
          id: j.id,
          name: j.name,
          enabled: j.enabled,
          trigger_type: j.trigger_type,
          run_count: j.run_count,
          project_id: j.project_id,
        })),
      });
      if (rows.length === 0) return "No jobs defined.";
      return rows
        .map(
          (j) =>
            `${j.enabled ? "●" : "○"} ${j.name.padEnd(24)} ${j.trigger_type.padEnd(12)} runs:${j.run_count} [id: ${j.id}]` +
            (options.projectScopes && options.projectScopes.length > 1
              ? ` [project: ${options.projectScopes.find((p) => p.id === j.project_id)?.name}]`
              : ""),
        )
        .join("\n");
    }

    case "shell_run": {
      const { command, cwd, label, project } = args as {
        command: string;
        cwd: string;
        label?: string;
        project?: string;
      };
      const projectId = project
        ? resolveProjectId(project)?.id
        : (options.projectScopes?.[0]?.id ?? resolveProjectId()?.id);
      const job = startBackgroundJob({
        command,
        cwd,
        ...(label ? { label } : {}),
        ...(options.agentSessionId ? { session_id: options.agentSessionId } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      });
      return JSON.stringify(job);
    }

    case "shell_status": {
      const {
        job_id,
        logs = true,
        tail_lines = 100,
        tail_bytes,
      } = args as {
        job_id: string;
        logs?: boolean;
        tail_lines?: number;
        tail_bytes?: number;
      };
      const job = getBackgroundJob(job_id);
      if (!job) throw new NotFoundError("BackgroundJob", job_id);
      if (!logs) return JSON.stringify(job);
      const log = readBackgroundJobLog(job_id, { tail_lines, tail_bytes });
      return JSON.stringify({
        ...job,
        log_tail: log.text,
        log_truncated: log.truncated,
        log_size_bytes: log.size_bytes,
      });
    }

    case "shell_list": {
      const { status, session_id, limit } = args as {
        status?: "running" | "completed" | "failed" | "stopped" | "interrupted_by_restart";
        session_id?: string;
        limit?: number;
      };
      return JSON.stringify({
        jobs: listBackgroundJobs({
          status,
          session_id,
          limit,
          ...(options.projectScopes ? { project_ids: options.projectScopes.map((p) => p.id) } : {}),
        }),
      });
    }

    case "shell_stop": {
      const { job_id } = args as { job_id: string };
      const existing = getBackgroundJob(job_id);
      if (!existing) throw new NotFoundError("BackgroundJob", job_id);
      const stopped = await stopBackgroundJob(job_id);
      if (!stopped) throw new NotFoundError("BackgroundJob", job_id);
      return JSON.stringify(stopped);
    }

    case "job_run": {
      const { name, project } = args as { name: string; project?: string };
      const target = resolveProjectId(project);
      const job = await db.query.jobs.findFirst({
        where: and(eq(jobs.name, name), target ? eq(jobs.project_id, target.id) : undefined),
      });
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
      const { run_id, logs, stream, log_limit } = args as {
        run_id: string;
        logs?: boolean;
        stream?: "stdout" | "stderr";
        log_limit?: number;
      };
      const run = await db.query.job_runs.findFirst({
        where: eq(job_runs.id, run_id),
      });
      if (!run) return `Run not found: ${run_id}`;
      const lines = logs
        ? await db.query.job_run_logs.findMany({
            where: stream
              ? and(eq(job_run_logs.run_id, run_id), eq(job_run_logs.stream, stream))
              : eq(job_run_logs.run_id, run_id),
            orderBy: [desc(job_run_logs.ts)],
            limit: log_limit ?? 200,
          })
        : [];
      return JSON.stringify({
        status: run.status,
        exit_code: run.exit_code,
        error: run.error_msg,
        ...(logs ? { logs: lines.reverse().map((l) => ({ stream: l.stream, line: l.line })) } : {}),
      });
    }

    case "task_link": {
      const { id, action, to_task_id, link_type, link_id } = args as {
        id: string;
        action?: "list" | "add" | "remove";
        to_task_id?: string;
        link_type?: z.infer<typeof TaskLinkTypeSchema>;
        link_id?: string;
      };
      const task = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
      if (!task) throw new NotFoundError("Task", id);
      if (action === "add") {
        if (!to_task_id || !link_type)
          throw new ValidationError("Adding a link requires to_task_id and link_type");
        if (to_task_id === id) throw new ValidationError("Cannot link a task to itself");
        const target = await db.query.tasks.findFirst({ where: eq(tasks.id, to_task_id) });
        if (!target) throw new NotFoundError("Task", to_task_id);
        const existing = await db.query.task_links.findFirst({
          where: and(eq(task_links.from_task_id, id), eq(task_links.to_task_id, to_task_id)),
        });
        if (existing) throw new ValidationError("Link already exists between these tasks");
        const linkId = ulid();
        await db.insert(task_links).values({
          id: linkId,
          from_task_id: id,
          to_task_id,
          link_type,
          created_at: new Date(),
        });
        import("@orc/runner/task-loop")
          .then((m) => m.triggerTaskCheck())
          .catch((err) => logger.warn("triggerTaskCheck failed", { err }));
        return `Linked ${id} ${link_type} ${to_task_id} [link: ${linkId}]`;
      }
      if (action === "remove") {
        if (!link_id) throw new ValidationError("Removing a link requires link_id");
        const link = await db.query.task_links.findFirst({ where: eq(task_links.id, link_id) });
        if (!link || (link.from_task_id !== id && link.to_task_id !== id))
          throw new NotFoundError("TaskLink", link_id);
        await db.delete(task_links).where(eq(task_links.id, link_id));
        import("@orc/runner/task-loop")
          .then((m) => m.triggerTaskCheck())
          .catch((err) => logger.warn("triggerTaskCheck failed", { err }));
        return `Removed link ${link_id}`;
      }
      const rows = await db.query.task_links.findMany({
        where: sql`${task_links.from_task_id} = ${id} OR ${task_links.to_task_id} = ${id}`,
      });
      if (rows.length === 0) return `No links for task ${id}.`;
      return rows
        .map((l) => `[link: ${l.id}] ${l.from_task_id} ${l.link_type} ${l.to_task_id}`)
        .join("\n");
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
      const scopeIds = options.projectScopes?.map((p) => p.id);

      const taskConditions = [];
      if (scopeIds) taskConditions.push(inArray(tasks.project_id, scopeIds));
      else if (scoped) taskConditions.push(sql`${tasks.project_id} IS ${scopeId}`);
      taskConditions.push(notInArray(tasks.status, ["done", "cancelled"]));
      const activeTasks = await db.query.tasks.findMany({
        where: taskConditions.length > 0 ? and(...taskConditions) : undefined,
        limit: taskLimit,
        orderBy: (t, { desc }) => [desc(t.updated_at)],
      });
      const filtered = activeTasks.filter((t) => !["done", "cancelled"].includes(t.status));

      const projectMemories = scopeIds
        ? new MemoryStore(getSqlite(db)).list(scopeIds, { sort: "priority" }).slice(0, memLimit)
        : scopeId
          ? new MemoryStore(getSqlite(db)).context(scopeId, memLimit)
          : [];

      const lastSession = await db.query.sessions.findFirst({
        where: scopeIds
          ? inArray(sessions.project_id, scopeIds)
          : scoped
            ? sql`${sessions.project_id} IS ${scopeId}`
            : undefined,
        orderBy: [desc(sessions.created_at)],
      });

      const lines: string[] = [];
      if (options.projectScopes && options.projectScopes.length > 1) {
        lines.push(`## Projects: ${options.projectScopes.map((p) => p.name).join(", ")}`);
      } else if (resolved) {
        lines.push(`## Project: ${resolved.name} [id: ${resolved.id}]`);
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
        const owner =
          scopeIds && scopeIds.length > 1
            ? ` [project: ${options.projectScopes?.find((p) => p.id === m.project_id)?.name}]`
            : "";
        lines.push(`  ${m.name}${priority}${owner} - ${m.description}`);
      }

      if (lastSession?.summary) {
        lines.push(`\n## Last Session (${lastSession.agent})`);
        lines.push(`  ${lastSession.summary}`);
      }

      const sqlite = getSqlite();
      const activeCount = sqlite
        .query(
          "SELECT COUNT(*) as count FROM gateway_sessions WHERE role = 'worker' AND status = 'running'" +
            (scopeIds
              ? ` AND project_id IN (${scopeIds.map(() => "?").join(",")})`
              : scoped
                ? " AND project_id IS ?"
                : ""),
        )
        .get(...(scopeIds ?? (scoped ? [scopeId] : []))) as { count: number } | null;
      if (activeCount && activeCount.count > 0) {
        lines.push(`\n## Agent Loop: ${activeCount.count} active worker(s)`);
      }

      setData?.({
        project: resolved ? { id: resolved.id, name: resolved.name } : null,
        tasks: filtered.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          progress: t.progress,
          project_id: t.project_id,
        })),
        memories: projectMemories,
        last_session: lastSession
          ? { id: lastSession.id, agent: lastSession.agent, summary: lastSession.summary ?? null }
          : null,
        active_workers: activeCount?.count ?? 0,
      });
      lines.push("\nUse task_get([ids]) or memory_read(name) for full content.");
      return lines.join("\n");
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
      setData?.({
        projects: rows.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          description: p.description ?? null,
          tags: p.tags,
          scope: p.scope ?? null,
          host: p.host ?? null,
          delete_after: p.delete_after?.toISOString() ?? null,
        })),
      });
      if (rows.length === 0) return "No projects found.";
      return rows
        .map((p) => {
          const hostTag = p.host ? ` [host: ${p.host}]` : "";
          const deletes = p.delete_after
            ? ` [deletes: ${p.delete_after.toISOString().slice(0, 10)}]`
            : "";
          const desc = p.description ? `  ${p.description.slice(0, 60)}` : "";
          return `${p.name.padEnd(24)} ${p.status} [id: ${p.id}]${hostTag}${deletes}${desc}`;
        })
        .join("\n");
    }

    case "project_create": {
      const { name, description, status, tags, git_remote_url, scope, host } = args as {
        name: string;
        description?: string;
        status?: "active" | "archived" | "paused";
        tags?: string[];
        git_remote_url?: string;
        scope?: string;
        host?: string | null;
      };
      const duplicate = () => {
        const row = getSqlite()
          .query<{ id: string; name: string }, [string]>(
            "SELECT id, name FROM projects WHERE name = ? COLLATE NOCASE LIMIT 1",
          )
          .get(name);
        return row
          ? new ConflictError(
              `Project ${row.name} already exists [id: ${row.id}]. Reuse that id or choose another name; no duplicate was created.`,
            )
          : null;
      };
      const now = new Date();
      const id = ulid();
      try {
        // The existing index is case-sensitive: serialize the NOCASE check and insert.
        getSqlite()
          .transaction(() => {
            const conflict = duplicate();
            if (conflict) throw conflict;
            db.insert(projects)
              .values({
                id,
                name,
                description: description ?? null,
                status: status ?? "active",
                git_remote_url: git_remote_url?.trim() || null,
                scope: scope ?? null,
                host: host ?? null,
                tags: tags ?? null,
                created_at: now,
                updated_at: now,
              })
              .run();
          })
          .immediate();
      } catch (error) {
        // Lost a race against a concurrent create: the unique index on name caught it.
        const raced = isUniqueNameFailure(error) ? duplicate() : null;
        if (raced) throw raced;
        throw error;
      }
      if (scope || host !== undefined) options.projectsChanged?.();
      clearSetupDismissal();
      const link = new URL(
        `/tasks?project=${encodeURIComponent(name)}`,
        options.publicApiBaseUrl ?? orcApiBase(),
      ).toString();
      return `Created project ${name} [id: ${id}]\nlink: ${link}`;
    }

    case "project_delete": {
      const input = args as {
        project?: string;
        project_id?: string;
        ttl_days?: number;
        restore?: boolean;
      };
      if (!input.project_id && !input.project)
        throw new ValidationError(
          "Pass project (name) or project_id; project_delete never uses the active project implicitly",
        );
      const id = input.project_id ?? resolveProjectId(input.project)?.id;
      if (!id) throw new ValidationError("Pass project (name) or project_id");
      const row = getSqlite()
        .query<{ id: string; name: string; status: string }, [string]>(
          "SELECT id, name, status FROM projects WHERE id=?",
        )
        .get(id);
      if (!row) throw new NotFoundError("Project", id);
      const link = new URL(
        `/tasks?project=${encodeURIComponent(row.name)}`,
        options.publicApiBaseUrl ?? orcApiBase(),
      ).toString();
      if (input.restore) {
        await orcApi("POST", `/projects/${encodeURIComponent(id)}/restore`);
        options.projectsChanged?.();
        return `${
          row.status === "archived" ? "Restored" : "Kept"
        } project ${row.name} [id: ${id}]; active with no scheduled deletion\nlink: ${link}`;
      }
      const ttlDays = input.ttl_days ?? DEFAULT_TTL_DAYS;
      const resources = projectResourceCounts(id);
      const linked = Object.entries(resources).filter(([, n]) => n > 0) as [string, number][];
      const describe = linked.map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`).join(", ");
      if (ttlDays === 0) {
        await orcApi("DELETE", `/projects/${encodeURIComponent(id)}?ttl_days=0`);
        options.projectsChanged?.();
        return `Deleted project ${row.name} [id: ${id}]${
          linked.length ? `; removed or detached ${describe}` : ""
        }`;
      }
      const scheduled = (await orcApi(
        "DELETE",
        `/projects/${encodeURIComponent(id)}?ttl_days=${ttlDays}`,
      )) as { delete_after?: string } | null;
      options.projectsChanged?.();
      const until = scheduled?.delete_after ? new Date(scheduled.delete_after) : null;
      return (
        `Scheduled deletion of project ${row.name} [id: ${id}] in ${ttlDays} days` +
        `${until ? ` (${until.toISOString().slice(0, 10)})` : ""}; it is archived now.` +
        `${linked.length ? ` Kept until then: ${describe}.` : ""} ` +
        `Use project_delete restore true to cancel.\nlink: ${link}`
      );
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
      const resolved = resolveProjectId(project ?? options.projectScopes?.[0]?.name);
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
          withTaskAudit(sqlite, [id], () => {
            db.insert(tasks)
              .values({
                id,
                title: item.title,
                body: item.body,
                project_id: resolved?.id,
                priority: (item.priority ?? "normal") as "low" | "normal" | "high" | "critical",
                author: author ?? "agent",
                origin_session_id: options.agentSessionId ?? null,
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
          });
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
      const scopeIds = selectedProjectIds(project, options);
      const lim = limit ?? 10;
      const parts: string[] = [];
      if (!resources || resources.includes("knowledge")) {
        try {
          const kbLines = await kbSearchLines(
            query,
            resolved?.id ?? null,
            Math.ceil(lim / 2),
            scopeIds,
          );
          if (kbLines.length > 0) parts.push("## Knowledge", ...kbLines);
        } catch (error) {
          logger.warn("Knowledge search failed", { error });
          parts.push("## Knowledge unavailable; memory and task results remain available.");
        }
      }
      if (!resources || resources.includes("memories")) {
        const memResults = new MemoryStore(getSqlite(db))
          .list(scopeIds ?? resolved?.id ?? null, { q: query })
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
            if (scopeIds) {
              sql += ` AND t.project_id IN (${scopeIds.map(() => "?").join(",")})`;
              params.push(...scopeIds);
            }
            sql += " ORDER BY rank LIMIT ?";
            params.push(taskLim);
            taskRows = sqlite.query(sql).all(...params) as typeof taskRows;
          } catch {
            const likeSql = `SELECT id, title, status FROM tasks WHERE (title LIKE ? OR body LIKE ?)${scopeIds ? ` AND project_id IN (${scopeIds.map(() => "?").join(",")})` : ""} ORDER BY updated_at DESC LIMIT ?`;
            const likeParams: (string | number)[] = [`%${query}%`, `%${query}%`];
            if (scopeIds) likeParams.push(...scopeIds);
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
      const {
        q,
        source,
        sort,
        limit,
        offset = 0,
        reload,
        project,
        scope,
      } = args as {
        q?: string;
        source?: "builtin" | "user";
        sort?: SkillListSort;
        limit?: number;
        offset?: number;
        reload?: boolean;
        project?: string;
        scope?: "global";
      };
      const matched = new SkillHistory(getSqlite(db)).list(resolveScope({ project, scope }), {
        q,
        source,
        sort,
        reload,
        // An explicit project wins over the connection defaults.
        ...(project === undefined && scope !== "global" && options.projectScopes
          ? { projectIds: options.projectScopes.map((p) => p.id) }
          : {}),
      });
      const pageSize = limit ?? SKILL_LIST_LIMIT;
      const skills = matched.slice(offset, offset + pageSize);
      const result = skills
        .map((s) => {
          const src = s.source === "user" ? " [user]" : "";
          const reads = ` (${s.read_count} ${s.read_count === 1 ? "read" : "reads"})`;
          const desc = s.description ? ` - ${s.description.slice(0, 80)}` : "";
          const score = s.score === undefined ? "" : ` [score: ${s.score.toFixed(4)}]`;
          return `${s.name.padEnd(28)}${src}${reads}${score}${desc}`;
        })
        .join("\n");
      const nextOffset = offset + pageSize < matched.length ? offset + pageSize : null;
      return [
        result || "No skills found.",
        `Showing ${skills.length} of ${matched.length}; total=${matched.length}, offset=${offset}, limit=${pageSize}, next_offset=${nextOffset ?? "null"}`,
      ].join("\n");
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
      const skillScope = resolveSkillScope({ project, scope }, options, sName);
      if (!skillHistory.visible(sName, skillScope)) return `Skill not found: ${sName}`;
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
        project,
        scope,
      } = args as {
        name: string;
        content: string;
        files?: SkillFileInput[];
        project?: string;
        scope?: "global";
      };
      try {
        const projectId = resolveScope({ project, scope });
        const skill = createSkillFs(cName, cContent, files, { authored: true });
        if (projectId !== null)
          new SkillHistory(getSqlite(db)).setProjects(skill.name, [projectId]);
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
    case "agent_update": {
      const input = args as {
        id: string;
        content: string;
        expected_raw: string;
        expected_path: string;
      };
      return JSON.stringify(
        updateAgent(input.id, {
          content: input.content,
          expectedRaw: input.expected_raw,
          expectedPath: input.expected_path,
        }),
      );
    }
    case "agent_delete": {
      const { id, expected_raw } = args as { id: string; expected_raw: string };
      const agent = readAgent(id);
      if (!agent) throw new NotFoundError("Agent", id);
      if (agent.raw !== expected_raw)
        throw new ConflictError("This agent changed since you read it. Reread it before deleting.");
      deleteAgent(id);
      return `Deleted agent ${id}`;
    }
    case "agent_package_list":
      return JSON.stringify(listPackages());
    case "agent_package_read": {
      const { name, ref } = args as { name: string; ref?: string };
      if (ref) return JSON.stringify(readPackageFile(name, ref));
      const pkg = readPackage(name);
      return JSON.stringify(pkg ? { ...pkg, revision: packageRevision(pkg) } : pkg);
    }
    case "agent_package_update": {
      const { name, content, files, expected_revision } = args as {
        name: string;
        content: string;
        files: SkillFileInput[];
        expected_revision: string;
      };
      const pkg = updatePackage(name, { content, files, expectedRevision: expected_revision });
      return JSON.stringify({ ...pkg, revision: packageRevision(pkg) });
    }
    case "agent_package_delete": {
      const { name, expected_revision } = args as { name: string; expected_revision: string };
      deletePackage(name, expected_revision);
      return `Deleted package ${name}`;
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

    case "goal_create": {
      const a = args as {
        objective: string;
        check: string;
        metric_pattern?: string;
        agents?: string[];
        iterations?: number;
        tokens?: number;
        hours?: number;
        stall_limit?: number;
        skill?: string;
        project?: string;
        task?: string;
      };
      if (a.task) {
        const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, a.task) });
        if (!owner) return `Task not found: ${a.task}`;
      }
      const resolved = resolveProjectId(a.project ?? options.projectScopes?.[0]?.name);
      const spec = GoalSpecSchema.parse({
        objective: a.objective,
        check: a.check,
        ...(a.metric_pattern ? { metric_pattern: a.metric_pattern } : {}),
        ...(a.agents ? { agents: a.agents } : {}),
        budget: {
          ...(a.iterations !== undefined ? { iterations: a.iterations } : {}),
          ...(a.tokens !== undefined ? { tokens: a.tokens } : {}),
          ...(a.hours !== undefined ? { hours: a.hours } : {}),
        },
        ...(a.stall_limit !== undefined ? { stall_limit: a.stall_limit } : {}),
        ...(a.skill ? { skill: a.skill } : {}),
        ...(resolved ? { project_id: resolved.id } : {}),
        ...(a.task ? { task_id: a.task } : {}),
      });
      const { createGoal } = await import("@orc/runner/goal-service");
      const goal = await createGoal(spec);
      return `Goal ${goal.id} started on task ${goal.task_id} (${goal.run?.status ?? "active"}). Watch it with goal_status.`;
    }

    case "goal_status": {
      const { id, task } = args as { id?: string; task?: string };
      const { getGoal, getTaskGoal } = await import("@orc/runner/goal-service");
      if (id) {
        const found = await getGoal(id);
        if (!found) return `Goal not found: ${id}`;
        return JSON.stringify(found);
      }
      if (task) {
        const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, task) });
        if (!owner) return `Task not found: ${task}`;
        const goal = await getTaskGoal(task);
        return goal ? JSON.stringify(goal) : `No goal on task ${task}.`;
      }
      return "Pass a goal id or a task id.";
    }

    case "goal_stop": {
      const { id } = args as { id: string };
      const { getGoal, stopGoal } = await import("@orc/runner/goal-service");
      const found = await getGoal(id);
      if (!found) return `Goal not found: ${id}`;
      const goal = await stopGoal(id);
      return `Goal ${goal.id} stopped.`;
    }

    case "flow_status": {
      const { task: taskId } = args as { task: string };
      const owner = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
      if (!owner) {
        setData?.({ task_id: taskId, found: false, run: null });
        return `Task not found: ${taskId}`;
      }
      const { getLatestFlowRunForTask } = await import("@orc/runner/flow-runner");
      const run = getLatestFlowRunForTask(taskId);
      if (!run) {
        setData?.({ task_id: taskId, found: true, run: null });
        return `No flow run for task ${taskId}.`;
      }

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
      setData?.({
        id: run.id,
        task_id: taskId,
        flow_name: run.flow_name,
        flow_source: run.flow_source,
        status: run.status,
        halt_description: run.halt_description ?? null,
        node_executions: run.node_executions,
        active: run.active,
        visits: run.visits,
        vars: Object.fromEntries(shownVars),
        nodes: run.nodes,
      });
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
      const broken = listBrokenFlows();
      setData?.({ flows, broken });
      if (flows.length === 0) return "No flows found.";
      const lines = flows.map(
        (f) =>
          `${f.name} [${f.source}${f.shadows ? `, shadows ${f.shadows}` : ""}]  entry:${f.entry}  ` +
          `${f.node_count} nodes, ${f.edge_count} edges` +
          (f.description ? `\n  ${f.description}` : ""),
      );
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
      if (!flow) {
        setData?.({ name: flowName, found: false });
        return `Flow not found: ${flowName}`;
      }
      setData?.({
        name: flow.name,
        source: flow.source,
        version: flow.version,
        description: flow.description,
        path: flow.path ?? null,
        definition: flow.definition,
      });
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
      if (start && ["done", "cancelled"].includes(target.status))
        return `Error: task is ${target.status}; move it back to todo before starting a flow on it.`;

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
