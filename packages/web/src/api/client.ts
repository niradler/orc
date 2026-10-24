import type { ChatHistoryPage, ChatModels, ChatThread } from "@orc/core/chat";
import type {
  KbComment,
  KbCommentClose,
  KbCommentCounts,
  KbCommentCreate,
  KbCommentStatus,
  KbCreate,
  KbDigest,
  KbDigestRun,
  KbDigestSet,
  KbDoclingState,
  KbDocument,
  KbDocumentCreate,
  KbDocumentListing,
  KbDocumentUpdate,
  KbDocumentWithContent,
  KbMaintenanceQueue,
  KbParserInfo,
  KbRevision,
  KbScope,
  KbSearchRequest,
  KbSearchResult,
  KbSettings,
  KbSettingsPatch,
  KbSource,
  KbSourceScan,
  KbStatus,
  KbUpdate,
  KbUsageStats,
  KnowledgeBase,
} from "@orc/core/kb";
import type { PackageDiscovery } from "@orc/core/primitive-types";
import type { RuleEventCapability } from "@orc/core/rule-events";
import type { ArchiveSearchResult, ArchiveSession, ArchiveUpload } from "@orc/core/session-archive";
import type { SessionHandoff } from "@orc/core/session-handoff";
import {
  API_ACCESS_CHANGED,
  readApiSecret,
  type WorkspacePreferences,
} from "../lib/api-credentials";

export type { PackageDiscovery } from "@orc/core/primitive-types";

import type {
  AuditEntry,
  LocalSkillAgentListing,
  LocalSkillImportItem,
  LocalSkillImportResult,
  PullCommentInput,
  PullReview,
  RestartResponse,
  ScopeQuery,
  SkillChange,
  SkillDiscovery,
  SkillImportInput,
  SkillImportOrigin,
  SkillSyncInput,
  SkillSyncResult,
  SkillUpdate,
  SkillVisibility,
} from "@orc/sdk/types";

export type {
  LocalSkill,
  LocalSkillAgentListing,
  PullCommentInput,
  PullReview,
  SkillDiscovery,
  SkillImportInput,
  SkillImportOrigin,
} from "@orc/sdk/types";

import type { RulePolicy, RuleRevision } from "@orc/core/rule-types";

// Browser-compatible ORC API client.
// Types imported from @orc/sdk for end-to-end type safety.
// Dev: Vite proxies /api/* → http://localhost:7701/api/*
// Override via localStorage: orc_api_url, orc_api_secret

export type {
  AgentBackendInfo,
  AgentFull,
  AgentProfile,
  BrokenAgent,
  BrokenFlow,
  Comment,
  CreateJobInput,
  CreateProjectInput,
  CreateSkillInput,
  CreateTaskInput,
  CreateTaskLinkInput,
  FlowFull,
  FlowMeta,
  FlowNodeRun,
  FlowRun,
  FlowSource,
  HealthResponse,
  Job,
  JobRun,
  JobRunLog,
  JobStatus,
  JobTriggerType,
  LiveSession,
  LiveSessionHit,
  PackageFull,
  PackageMeta,
  Project,
  ProjectStatus,
  ProjectSummary,
  ResumeFlowInput,
  Session,
  SessionDetail,
  SessionEvent,
  SessionSearchResult,
  SessionSyncResult,
  SkillFileInput,
  SkillFull,
  SkillMeta,
  SkillRefContent,
  SkillSource,
  Task,
  TaskLink,
  TaskLinkType,
  TaskPriority,
  TaskStatus,
  TranscriptBlock,
  TranscriptPage,
  TranscriptTurn,
  UpdateJobInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@orc/sdk/types";

import type {
  AgentBackendInfo,
  AgentFull,
  AgentProfile,
  BrokenAgent,
  BrokenFlow,
  Comment,
  CreateJobInput,
  CreateProjectInput,
  CreateSkillInput,
  CreateTaskInput,
  CreateTaskLinkInput,
  FlowFull,
  FlowMeta,
  FlowRun,
  FlowSource,
  HealthResponse,
  Job,
  JobRun,
  JobRunLog,
  LiveSession,
  PackageFull,
  PackageMeta,
  Project,
  ProjectSummary,
  ResumeFlowInput,
  Session,
  SessionDetail,
  SessionSearchResult,
  SessionSyncResult,
  SkillFileInput,
  SkillFull,
  SkillMeta,
  SkillRefContent,
  Task,
  TaskLink,
  TranscriptPage,
  UpdateJobInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@orc/sdk/types";

export const getApiUrl = (): string => localStorage.getItem("orc_api_url") ?? "/api";

export const getApiSecret = (): string => readApiSecret(getApiUrl());

export type TerminalKind = "shell" | "claude" | "codex" | "cursor" | "gemini" | "copilot";
export type AgentSetup = {
  name: string;
  packages: string[];
  backend: "claude" | "codex" | "copilot";
  tool: "apm" | "skills";
  cwd: string;
  agent?: string;
  model?: string;
  prompt: string;
  operation?: "run" | "install";
};

export type Terminal = {
  id: string;
  name: string;
  kind: TerminalKind;
  cwd: string | null;
  status: "running" | "exited";
  exit_code: number | null;
  pid: number | null;
  live_session_id: string | null;
  host: string | null;
  created_at: string;
};

export type TerminalsInfo = {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  launchers: TerminalKind[];
  host: string | null;
  terminals: Terminal[];
};

export type HostDirectoryListing = {
  host: string | null;
  path: string;
  parent: string | null;
  directories: string[];
};

export type SshState = {
  host: string | null;
  remote_port: number | null;
  hosts: string[];
  locked: boolean;
  supported: boolean;
  unsupported_reason: string | null;
  secret_set: boolean;
};

export type SshTest = {
  ok: boolean;
  host: string;
  error: string | null;
  os: string | null;
  home: string | null;
  shell: string | null;
  binaries: Record<string, string | null>;
  claude_logged_in: boolean | null;
  api_key_forwarded: boolean;
};

export type CreateTerminalInput = {
  kind: TerminalKind;
  host?: string | null;
  cwd?: string;
  name?: string;
  live_session_id?: string;
  worktree?: boolean;
  setup?: AgentSetup;
};

export type Worktree = {
  path: string;
  branch: string | null;
  head: string | null;
  main: boolean;
  dirty: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  merged?: boolean;
  upstream_gone?: boolean;
  stale?: boolean;
  active_terminal?: string | null;
};

export type WorktreeListing = { root: string | null; worktrees: Worktree[] };
export type GitStatus = {
  root: string | null;
  branch: string | null;
  files: {
    path: string;
    index: string;
    working: string;
    original: string | null;
  }[];
  branches: string[];
};
export type GithubItem = {
  repo: string;
  number: number;
  title: string;
  url: string;
  kind: "issue" | "pr";
  state: string;
  branch: string | null;
  assignees: string[];
  task_ids: string[];
  ci?: { state: "success" | "failure" | "pending" | "none"; total: number; url: string } | null;
};
export type GithubFeed = {
  auth: "gh" | "token" | "none";
  login: string | null;
  items: GithubItem[];
  errors: { repo: string; error: string }[];
  truncated: boolean;
  unavailable_reason?: "no_remote" | "detached_head";
};
export type ManagedWebhook = {
  id: string;
  name: string;
  provider: "generic" | "github";
  job_id: string | null;
  project_id: string | null;
  subscriptions: {
    job_id: string;
    name: string;
    enabled: boolean;
    events: string[];
    actions: string[];
  }[];
  token: string;
  events: string[];
  actions: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
};
export type WebhookDelivery = {
  id: string;
  webhook_id: string;
  delivery_key: string;
  event: string;
  action: string | null;
  repository: string | null;
  payload_hash: string;
  status: "ignored" | "running" | "success" | "failed";
  job_run_id: string | null;
  runs: {
    job_id: string;
    job_run_id: string;
    status: string;
    task_id: string | null;
    session_id: string | null;
  }[];
  error: string | null;
  created_at: string;
  updated_at: string;
};
export type CreateWebhookInput = {
  name: string;
  provider: "generic" | "github";
  job_id?: string;
  project_id?: string | null;
  events?: string[];
  actions?: string[];
  enabled?: boolean;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---- Memories: short per-project facts; identity is (project_id, name) ----

export const MEMORY_DESCRIPTION_MAX = 300;
export const MEMORY_PRIORITY_MAX = 100;
/** Content limit comes from the server config (memory.max_content_chars). */
export type MemoryLimits = { description_max: number; content_max: number; priority_max: number };
/** Memory writes from the dashboard are made by a person, not an agent. */
const UI_AUTHOR = "human";

export type MemorySort = "reads" | "recent" | "priority";
export type MemoryReadSource = "mcp" | "cli" | "api" | "ui";

export type Memory = {
  project_id: string;
  name: string;
  description: string;
  content: string;
  /** 0-100, higher loads first in context; null = not scored. */
  priority: number | null;
  author: string;
  session_id: string | null;
  created_at: number;
  updated_at: number;
};

export type MemoryListItem = Omit<Memory, "content"> & {
  key: string;
  read_count: number;
  reads_by_source: Record<MemoryReadSource, number>;
  last_read_at: number | null;
  activity_at: number;
};

export type MemorySnapshot = Pick<Memory, "description" | "content" | "priority">;

export type MemoryChange = {
  id: string;
  project_id: string;
  memory_name: string;
  action: "memory.created" | "memory.updated" | "memory.deleted" | "memory.reverted";
  previous: MemorySnapshot | null;
  current: MemorySnapshot | null;
  reason: string | null;
  author: string;
  session_id: string | null;
  created_at: number;
};

export type MemoryListParams = {
  project_id?: string;
  q?: string;
  sort?: MemorySort;
  limit?: number;
};

export type CreateMemoryInput = {
  project_id: string;
  name: string;
  description: string;
  content: string;
  priority?: number | null;
};

export type UpdateMemoryInput = {
  project_id: string;
  description?: string;
  content?: string;
  priority?: number | null;
  reason?: string;
};

export type RevertMemoryInput = {
  project_id: string;
  change_id: string;
  expected_change_id: string;
  reason: string;
};

export type GlobalSearchHit = {
  kind: "task" | "project" | "job" | "memory" | "session";
  id: string;
  title: string;
  detail: string;
  project_id: string | null;
  project_name: string | null;
};

export function terminalSocketUrl(
  id: string,
  ticket: string,
  apiUrl: string = getApiUrl(),
  location: Pick<Location, "protocol" | "host"> = window.location,
): string {
  const path = `/terminals/${encodeURIComponent(id)}/ws?ticket=${encodeURIComponent(ticket)}`;
  const base = apiUrl.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(base)) return `${base.replace(/^http/i, "ws")}${path}`;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const prefix = base.startsWith("/") || base === "" ? base : `/${base}`;
  return `${scheme}//${location.host}${prefix}${path}`;
}

const enc = encodeURIComponent;

/** Auth plus the read source, so knowledge usage stats attribute browser reads to the UI. */
function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "X-Orc-Source": "ui" };
  const secret = getApiSecret();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
  opts?: { nullOn404?: boolean; signal?: AbortSignal | undefined },
): Promise<T> {
  let url = `${getApiUrl()}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const q = params.toString();
    if (q) url += `?${q}`;
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(),
  };
  const res = await fetch(url, {
    method,
    headers,
    signal: opts?.signal,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) window.dispatchEvent(new Event(API_ACCESS_CHANGED));
  if (res.status === 204) return null as T;
  // "Not there yet" is a normal state for some resources (a task that has never
  // run a flow), so callers can ask for null instead of a thrown error and skip
  // string-matching the message to tell absence from failure.
  if (res.status === 404 && opts?.nullOn404) return null as T;
  const json = (await res.json()) as unknown;
  if (!res.ok) {
    const e = json as { error?: unknown; code?: unknown };
    const msg = typeof e.error === "string" ? e.error : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, typeof e.code === "string" ? e.code : null);
  }
  return json as T;
}

// ---- API client ----

export const api = {
  chat: {
    models: (agent: string, threadId?: string) =>
      req<ChatModels>("GET", "/chat/models", undefined, { agent, threadId }),
    list: () =>
      req<{ threads: { id: string; title: string; updatedAt: number }[] }>("GET", "/chat/threads"),
    get: (id: string) => req<ChatThread>("GET", `/chat/threads/${id}`),
    configure: (id: string, agentOptions: ChatThread["config"]["agentOptions"]) =>
      req<ChatThread>("PATCH", `/chat/threads/${id}/config`, { agentOptions }),
    history: (id: string, before: number) =>
      req<ChatHistoryPage>("GET", `/chat/threads/${id}/history`, undefined, { before }),
    resume: (sourceSessionId: string) =>
      req<ChatThread>("POST", "/chat/threads", { sourceSessionId }),
    permission: (runId: string, requestId: string, decision: "approved" | "denied") =>
      req<{ ok: boolean }>("POST", `/chat/runs/${runId}/permission`, { requestId, decision }),
    answer: (runId: string, requestId: string, answers: Record<string, string[]>) =>
      req<{ ok: boolean }>("POST", `/chat/runs/${runId}/answer`, { requestId, answers }),
  },
  settings: {
    get: () => req<WorkspacePreferences>("GET", "/settings"),
    save: (preferences: WorkspacePreferences) =>
      req<WorkspacePreferences>("PATCH", "/settings", preferences),
  },
  search: (q: string, project_id?: string) =>
    req<{ results: GlobalSearchHit[] }>("GET", "/search", undefined, { q, project_id }),
  rules: {
    list: () =>
      req<{
        enabled: boolean;
        events: Record<string, RuleEventCapability[]>;
        adapters: { backend: string; interception: string }[];
        history: RuleRevision[];
        decisions: {
          id: string;
          revision_id: string;
          session_id: string;
          phase: string;
          tool: string | null;
          result: string;
          created_at: number;
        }[];
        actions: {
          id: string;
          job_id: string;
          status: string;
          run_id: string | null;
          error: string | null;
        }[];
      }>("GET", "/rules"),
    activate: (policy: RulePolicy, expected_id: string | null, reason: string) =>
      req<RuleRevision>("POST", "/rules/activate", {
        policy,
        expected_id,
        reason,
      }),
    revert: (id: string, reason: string) =>
      req<RuleRevision>("POST", "/rules/revert", { id, reason }),
  },
  health: {
    check: (signal?: AbortSignal) =>
      req<HealthResponse>("GET", "/health", undefined, undefined, { signal }),
  },
  system: {
    restart: () => req<RestartResponse>("POST", "/system/restart", {}),
  },

  tasks: {
    list: (params?: { status?: string; project_id?: string; tag?: string; limit?: number }) =>
      req<{ tasks: Task[]; total: number }>(
        "GET",
        "/tasks",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<Task>("GET", `/tasks/${id}`),
    create: (data: CreateTaskInput) => req<Task>("POST", "/tasks", data),
    startFlow: (id: string, name: string) =>
      req<{ started: boolean; error: string | null }>("POST", `/tasks/${id}/flow`, {
        name,
        start: true,
      }),
    update: (id: string, data: UpdateTaskInput) => req<Task>("PATCH", `/tasks/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/tasks/${id}`),
    addComment: (id: string, content: string, author = "human") =>
      req<Comment>("POST", `/tasks/${id}/comments`, { content, author }),
    listComments: (id: string) => req<{ comments: Comment[] }>("GET", `/tasks/${id}/comments`),
    listLinks: (id: string) => req<{ links: TaskLink[] }>("GET", `/tasks/${id}/links`),
    addLink: (id: string, data: CreateTaskLinkInput) =>
      req<TaskLink>("POST", `/tasks/${id}/links`, data),
    deleteLink: (id: string, linkId: string) => req<null>("DELETE", `/tasks/${id}/links/${linkId}`),
    // null (not an error) when the task has never run a flow.
    flow: (id: string) =>
      req<FlowRun | null>("GET", `/tasks/${id}/flow`, undefined, undefined, {
        nullOn404: true,
      }),
    resumeFlow: (id: string, data: ResumeFlowInput) =>
      req<{ ok: boolean; next_nodes: string[] }>("POST", `/tasks/${id}/flow/resume`, data),
    haltFlow: (id: string, reason?: string) =>
      req<{ halted: boolean }>("POST", `/tasks/${id}/flow/halt`, { reason }),
  },

  backends: {
    list: () => req<{ backends: AgentBackendInfo[]; default_backend: string }>("GET", "/backends"),
  },

  flows: {
    list: (params?: { q?: string; source?: FlowSource }) =>
      req<{ flows: FlowMeta[]; broken: BrokenFlow[]; default_flow: string }>(
        "GET",
        "/flows",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (name: string) => req<FlowFull>("GET", `/flows/${encodeURIComponent(name)}`),
  },

  memories: {
    limits: () => req<MemoryLimits>("GET", "/memory-limits"),
    list: (params: MemoryListParams) =>
      req<{ memories: MemoryListItem[]; total: number }>("GET", "/memories", undefined, params),
    get: (projectId: string, name: string) =>
      req<Memory>("GET", `/memories/${encodeURIComponent(name)}`, undefined, {
        project_id: projectId,
      }),
    create: (data: CreateMemoryInput) =>
      req<Memory>("POST", "/memories", { ...data, author: UI_AUTHOR }),
    update: (name: string, data: UpdateMemoryInput) =>
      req<Memory>("PATCH", `/memories/${encodeURIComponent(name)}`, {
        ...data,
        author: UI_AUTHOR,
      }),
    delete: (projectId: string, name: string) =>
      req<null>("DELETE", `/memories/${encodeURIComponent(name)}`, undefined, {
        project_id: projectId,
        author: UI_AUTHOR,
      }),
    history: (projectId: string, name: string) =>
      req<{ changes: MemoryChange[] }>(
        "GET",
        `/memories/${encodeURIComponent(name)}/history`,
        undefined,
        { project_id: projectId },
      ),
    revert: (name: string, input: RevertMemoryInput) =>
      req<{ memory: Memory | null }>("POST", `/memories/${encodeURIComponent(name)}/revert`, input),
  },

  jobs: {
    list: (params?: { enabled?: boolean; project_id?: string; limit?: number }) =>
      req<{ jobs: Job[] }>(
        "GET",
        "/jobs",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<Job>("GET", `/jobs/${id}`),
    create: (data: CreateJobInput) => req<Job>("POST", "/jobs", data),
    update: (id: string, data: UpdateJobInput) => req<Job>("PATCH", `/jobs/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/jobs/${id}`),
    trigger: (id: string) => req<{ run_id: string }>("POST", `/jobs/${id}/trigger`),
    runs: (id: string, limit = 10) =>
      req<{ runs: JobRun[] }>("GET", `/jobs/${id}/runs`, undefined, { limit }),
    runLogs: (
      id: string,
      runId: string,
      params?: { stream?: "stdout" | "stderr"; limit?: number },
    ) =>
      req<{ logs: JobRunLog[] }>(
        "GET",
        `/jobs/${id}/runs/${runId}/logs`,
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
  },

  webhooks: {
    list: (project_id?: string) =>
      req<{ webhooks: ManagedWebhook[] }>("GET", "/webhooks", undefined, { project_id }),
    create: (data: CreateWebhookInput) =>
      req<ManagedWebhook & { secret: string }>("POST", "/webhooks", data),
    update: (id: string, data: Partial<CreateWebhookInput>) =>
      req<ManagedWebhook>("PATCH", `/webhooks/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/webhooks/${id}`),
    rotate: (id: string) => req<{ secret: string }>("POST", `/webhooks/${id}/rotate-secret`),
    deliveries: (id: string) =>
      req<{ deliveries: WebhookDelivery[] }>("GET", `/webhooks/${id}/deliveries`),
  },

  projects: {
    list: (params?: { status?: string; tag?: string; limit?: number }) =>
      req<{ projects: Project[] }>(
        "GET",
        "/projects",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<Project>("GET", `/projects/${id}`),
    getByName: (name: string) =>
      req<Project>("GET", `/projects/by-name/${encodeURIComponent(name)}`),
    summary: (id: string) => req<ProjectSummary>("GET", `/projects/${id}/summary`),
    create: (data: CreateProjectInput) => req<Project>("POST", "/projects", data),
    update: (id: string, data: UpdateProjectInput) =>
      req<Project>("PATCH", `/projects/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/projects/${id}`),
    addComment: (id: string, content: string, author = "human") =>
      req<Comment>("POST", `/projects/${id}/comments`, { content, author }),
    listComments: (id: string) => req<{ comments: Comment[] }>("GET", `/projects/${id}/comments`),
  },

  sessions: {
    archive: (params: {
      q?: string;
      project_id?: string;
      agent?: string;
      offset?: number;
      limit?: number;
    }) => req<ArchiveSearchResult>("GET", "/sessions/archive", undefined, params),
    archiveUpload: (input: ArchiveUpload) =>
      req<{ session: ArchiveSession; outcome: string }>("POST", "/sessions/archive/upload", input),
    archiveIndex: (project_id?: string) =>
      req<{ indexed: number; failed: number; skipped: number }>("POST", "/sessions/archive/index", {
        project_id,
      }),
    archiveTranscript: (
      id: string,
      params?: { revision?: number; offset?: number; limit?: number },
    ) => req<TranscriptPage>("GET", `/sessions/archive/${id}/transcript`, undefined, params),
    archiveResume: (
      id: string,
      input: {
        revision?: number;
        repository?: string;
        branch?: string;
        commit?: string;
        subdirectory?: string;
      },
    ) => req<SessionHandoff>("POST", `/sessions/archive/${id}/resume`, input),
    list: (params?: {
      agent?: string;
      job_run_id?: string;
      project_id?: string;
      order?: "asc" | "desc";
      limit?: number;
      offset?: number;
    }) =>
      req<{ sessions: Session[]; total: number }>(
        "GET",
        "/sessions",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<SessionDetail>("GET", `/sessions/${id}`),
    sync: () => req<{ results: SessionSyncResult[] }>("POST", "/sessions/live/sync"),
    search: (params: { q: string; agent?: string; limit?: number }) =>
      req<SessionSearchResult>(
        "GET",
        "/sessions/live/search",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    transcript: (id: string, params?: { offset?: number; limit?: number; q?: string }) =>
      req<TranscriptPage>(
        "GET",
        `/sessions/live/${id}/transcript`,
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    live: (params?: { agent?: string; task_id?: string; active?: boolean; limit?: number }) =>
      req<{ sessions: LiveSession[] }>(
        "GET",
        "/sessions/live",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    linkTask: (id: string, task_id: string | null) =>
      req<LiveSession>("PATCH", `/sessions/live/${id}`, { task_id }),
  },

  skills: {
    visibility: () => req<SkillVisibility>("GET", "/skills/settings/visibility"),
    setVisibility: (policy: Partial<SkillVisibility>) =>
      req<SkillVisibility>("PUT", "/skills/settings/visibility", policy),
    updateInstructions: (name: string, input: Omit<SkillUpdate, "skill_name">) =>
      req<SkillFull>("PUT", `/skills/${encodeURIComponent(name)}/instructions`, input),
    history: (name: string, scope: ScopeQuery = {}) =>
      req<{ changes: SkillChange[] }>(
        "GET",
        `/skills/${encodeURIComponent(name)}/history`,
        undefined,
        scope,
      ),
    revert: (
      name: string,
      input: {
        project_id: string | null;
        change_id: string;
        expected_change_id: string;
        reason: string;
      },
    ) => req<SkillFull>("POST", `/skills/${encodeURIComponent(name)}/revert`, input),

    discover: (source: string) => req<SkillDiscovery>("POST", "/skills/discover", { source }),
    import: (input: SkillImportInput) =>
      req<{ skills: SkillFull[] }>("POST", "/skills/import", input),
    origin: (name: string) =>
      req<SkillImportOrigin | null>("GET", `/skills/${encodeURIComponent(name)}/origin`),
    localAgents: () => req<{ agents: LocalSkillAgentListing[] }>("GET", "/skills/local-agents"),
    importLocal: (skills: LocalSkillImportItem[]) =>
      req<LocalSkillImportResult>("POST", "/skills/local-agents/import", { skills }),
    sync: (name: string, input: SkillSyncInput = {}) =>
      req<SkillSyncResult>("POST", `/skills/${encodeURIComponent(name)}/sync`, input),
    editFile: (name: string, input: { path: string; content: string; expectedContent: string }) =>
      req<SkillFull>("PUT", `/skills/${encodeURIComponent(name)}/file`, input),
    list: (params?: {
      q?: string;
      source?: "builtin" | "user";
      include_hidden?: boolean;
      reload?: boolean;
      project_id?: string;
      scope?: "global";
      limit?: number;
      offset?: number;
    }) =>
      req<{
        skills: SkillMeta[];
        broken: BrokenAgent[];
        total: number;
        offset: number;
        limit: number;
        next_offset: number | null;
      }>(
        "GET",
        "/skills",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (name: string, ref?: string, scope: ScopeQuery = {}) =>
      req<SkillFull | SkillRefContent>("GET", `/skills/${encodeURIComponent(name)}`, undefined, {
        ...scope,
        ref,
      }),
    create: (data: CreateSkillInput) => req<SkillFull>("POST", "/skills", data),
  },
  agents: {
    list: () => req<{ agents: AgentProfile[]; broken: BrokenAgent[] }>("GET", "/agents"),
    get: (id: string) => req<AgentFull>("GET", `/agents/${encodeURIComponent(id)}`),
    create: (input: { id: string; content: string }) => req<AgentFull>("POST", "/agents", input),
    delete: (id: string) => req<null>("DELETE", `/agents/${encodeURIComponent(id)}`),
    update: (id: string, input: { content: string; expectedRaw: string; expectedPath: string }) =>
      req<AgentFull>("PUT", `/agents/${encodeURIComponent(id)}`, input),
  },
  agentPackages: {
    acquire: (source: string) =>
      req<{ token: string; source: string; packages: PackageDiscovery["packages"] }>(
        "POST",
        "/agent-packages/acquire",
        { source },
      ),
    importAcquired: (input: { token: string; path: string }) =>
      req<PackageFull>("POST", "/agent-packages/import-acquired", input),
    list: () => req<{ packages: PackageMeta[]; broken: BrokenAgent[] }>("GET", "/agent-packages"),
    get: (name: string, ref?: string) =>
      req<(PackageFull & { revision?: string }) | SkillRefContent>(
        "GET",
        `/agent-packages/${encodeURIComponent(name)}`,
        undefined,
        ref ? { ref } : undefined,
      ),
    create: (input: {
      name: string;
      content: string;
      files: SkillFileInput[];
      format?: "apm" | "agent-plugin";
      skills?: string[];
      imported?: boolean;
    }) => req<PackageFull>("POST", "/agent-packages", input),
    update: (
      name: string,
      input: {
        content: string;
        files: SkillFileInput[];
        expectedRevision: string;
        skills?: string[];
      },
    ) => req<PackageFull>("PUT", `/agent-packages/${encodeURIComponent(name)}`, input),
    discover: (source: string) =>
      req<PackageDiscovery>("POST", "/agent-packages/discover", { source }),
    importGit: (input: {
      source: string;
      commit: string;
      path: string;
      format: "apm" | "agent-plugin";
    }) => req<PackageFull>("POST", "/agent-packages/import-git", input),
    exportArtifact: (name: string) =>
      req<{ filename: string; content: string; format: string }>(
        "POST",
        `/agent-packages/${encodeURIComponent(name)}/export`,
      ),
  },
  agentSetups: {
    list: () => req<{ setups: AgentSetup[]; broken: BrokenAgent[] }>("GET", "/agent-setups"),
    create: (input: AgentSetup) => req<AgentSetup>("POST", "/agent-setups", input),
    command: (input: AgentSetup) =>
      req<{ command: string; shell: string; notice: string }>(
        "POST",
        "/agent-setups/command",
        input,
      ),
  },
  packageTools: {
    list: () => req<{ apm: boolean; skills: boolean; bun: boolean }>("GET", "/package-tools"),
  },

  audit: {
    list: (scope: ScopeQuery = {}) =>
      req<{ entries: AuditEntry[] }>("GET", "/audit", undefined, scope),
  },

  kb: {
    list: (opts: { scope?: KbScope; project_id?: string } = {}) =>
      req<{ knowledge_bases: KnowledgeBase[] }>("GET", "/kb/bases", undefined, opts),
    get: (id: string) => req<KnowledgeBase>("GET", `/kb/bases/${enc(id)}`),
    create: (input: KbCreate) => req<KnowledgeBase>("POST", "/kb/bases", input),
    update: (id: string, input: KbUpdate) =>
      req<KnowledgeBase>("PATCH", `/kb/bases/${enc(id)}`, input),
    remove: (id: string) => req<null>("DELETE", `/kb/bases/${enc(id)}`),
    usage: (id: string) => req<KbUsageStats>("GET", `/kb/bases/${enc(id)}/usage`),
    maintenance: (id: string) => req<KbMaintenanceQueue>("GET", `/kb/bases/${enc(id)}/maintenance`),
    documents: (kbId: string) => req<KbDocumentListing>("GET", `/kb/bases/${enc(kbId)}/documents`),
    createDocument: (kbId: string, input: KbDocumentCreate) =>
      req<KbDocument>("POST", `/kb/bases/${enc(kbId)}/documents`, input),
    /** XHR rather than fetch so the UI can show per-file upload progress. */
    upload: (
      kbId: string,
      input: {
        file: File;
        title?: string;
        path?: string;
        labels?: string[];
        document_id?: string;
        expected_revision?: number;
      },
      onProgress?: (fraction: number) => void,
    ) => {
      const form = new FormData();
      form.set("file", input.file, input.file.name);
      if (input.title) form.set("title", input.title);
      if (input.path) form.set("path", input.path);
      if (input.labels?.length) form.set("labels", input.labels.join(","));
      if (input.document_id) form.set("document_id", input.document_id);
      if (input.expected_revision !== undefined)
        form.set("expected_revision", String(input.expected_revision));
      return new Promise<KbDocument>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${getApiUrl()}/kb/bases/${enc(kbId)}/upload`);
        for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress?.(e.loaded / e.total);
        };
        xhr.onerror = () => reject(new ApiError("Upload failed: network error", 0, null));
        xhr.onload = () => {
          let json: unknown = null;
          try {
            json = JSON.parse(xhr.responseText);
          } catch {
            // Non-JSON bodies only come from proxies; the status carries the failure.
          }
          if (xhr.status >= 200 && xhr.status < 300) return resolve(json as KbDocument);
          const e = (json ?? {}) as { error?: unknown; code?: unknown };
          reject(
            new ApiError(
              typeof e.error === "string" ? e.error : `HTTP ${xhr.status}`,
              xhr.status,
              typeof e.code === "string" ? e.code : null,
            ),
          );
        };
        xhr.send(form);
      });
    },
    document: (id: string, opts: { heading?: string } = {}) =>
      req<KbDocumentWithContent>("GET", `/kb/documents/${enc(id)}`, undefined, opts),
    updateDocument: (id: string, input: KbDocumentUpdate) =>
      req<KbDocument>("PATCH", `/kb/documents/${enc(id)}`, input),
    removeDocument: (id: string) => req<null>("DELETE", `/kb/documents/${enc(id)}`),
    revisions: (id: string) =>
      req<{ revisions: KbRevision[] }>("GET", `/kb/documents/${enc(id)}/revisions`),
    revision: (id: string, revision: number) =>
      req<KbRevision & { content: string | null }>(
        "GET",
        `/kb/documents/${enc(id)}/revisions/${revision}`,
      ),
    /** The original upload as a Blob (the endpoint needs the Authorization header). */
    original: async (id: string) => {
      const res = await fetch(`${getApiUrl()}/kb/documents/${enc(id)}/original`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status, null);
      return res.blob();
    },
    reparse: (id: string) => req<KbDocument>("POST", `/kb/documents/${enc(id)}/reparse`),
    documentUsage: (id: string) => req<KbUsageStats>("GET", `/kb/documents/${enc(id)}/usage`),
    citation: (handle: string) => req<KbDocumentWithContent>("GET", `/kb/citations/${enc(handle)}`),
    comments: (
      kbId: string,
      filter: { document_id?: string; status?: KbCommentStatus; limit?: number } = {},
    ) =>
      req<{ comments: KbComment[]; counts: KbCommentCounts }>(
        "GET",
        `/kb/bases/${enc(kbId)}/comments`,
        undefined,
        filter,
      ),
    addComment: (kbId: string, input: KbCommentCreate) =>
      req<KbComment>("POST", `/kb/bases/${enc(kbId)}/comments`, input),
    closeComment: (id: string, input: KbCommentClose) =>
      req<KbComment>("POST", `/kb/comments/${enc(id)}/close`, input),
    reopenComment: (id: string) => req<KbComment>("POST", `/kb/comments/${enc(id)}/reopen`),
    digestTemplate: () => req<{ instructions: string }>("GET", "/kb/digest-template"),
    digest: (kbId: string) =>
      req<{ digest: KbDigest | null }>("GET", `/kb/bases/${enc(kbId)}/digest`),
    setDigest: (kbId: string, input: KbDigestSet) =>
      req<KbDigest>("PUT", `/kb/bases/${enc(kbId)}/digest`, input),
    removeDigest: (kbId: string, confirm: string) =>
      req<null>("DELETE", `/kb/bases/${enc(kbId)}/digest`, undefined, { confirm }),
    runDigest: (kbId: string) =>
      req<{ run_id: string }>("POST", `/kb/bases/${enc(kbId)}/digest/run`),
    digestRuns: (kbId: string, limit?: number) =>
      req<{ runs: KbDigestRun[] }>("GET", `/kb/bases/${enc(kbId)}/digest/runs`, undefined, {
        limit,
      }),
    search: (input: KbSearchRequest, project_id?: string) =>
      req<KbSearchResult>("POST", "/kb/search", input, { project_id }),
    sources: (kbId: string) =>
      req<{ sources: (KbSource & { document_count: number })[] }>(
        "GET",
        `/kb/bases/${enc(kbId)}/sources`,
      ),
    addSource: (kbId: string, input: { root_path: string; pattern?: string }) =>
      req<{ source: KbSource; scan: KbSourceScan }>(
        "POST",
        `/kb/bases/${enc(kbId)}/sources`,
        input,
      ),
    scanSource: (id: string) => req<KbSourceScan>("POST", `/kb/sources/${enc(id)}/scan`),
    removeSource: (id: string) => req<null>("DELETE", `/kb/sources/${enc(id)}`),
    status: () => req<KbStatus>("GET", "/kb/status"),
    settings: () => req<KbSettings>("GET", "/kb/settings"),
    updateSettings: (patch: KbSettingsPatch) => req<KbSettings>("PATCH", "/kb/settings", patch),
    parsers: () => req<{ parsers: KbParserInfo[]; docling: KbDoclingState }>("GET", "/kb/parsers"),
    installDocling: () => req<KbDoclingState>("POST", "/kb/parsers/docling/install"),
    uninstallDocling: () => req<null>("DELETE", "/kb/parsers/docling"),
  },

  tags: {
    list: (params?: { resource_type?: "task" | "project" | "memory" }) =>
      req<{ tags: { name: string; count: number; resource_type: string }[] }>(
        "GET",
        "/tags",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
  },

  terminals: {
    list: (host?: string | null) =>
      req<TerminalsInfo>("GET", "/terminals", undefined, { host: host === null ? "" : host }),
    create: (data: CreateTerminalInput) => req<Terminal>("POST", "/terminals", data),
    get: (id: string) => req<Terminal>("GET", `/terminals/${encodeURIComponent(id)}`),
    rename: (id: string, name: string) =>
      req<Terminal>("PATCH", `/terminals/${encodeURIComponent(id)}`, { name }),
    remove: (id: string) => req<null>("DELETE", `/terminals/${encodeURIComponent(id)}`),
    ticket: (id: string) =>
      req<{ ticket: string; expires_in: number }>(
        "POST",
        `/terminals/${encodeURIComponent(id)}/ticket`,
      ),
    pickFolder: (initial?: string, host?: string | null) =>
      req<{ path: string | null }>("POST", "/terminals/pick-folder", { initial, host }),
    browse: (path?: string, host?: string | null) =>
      req<HostDirectoryListing>("GET", "/terminals/browse", undefined, {
        path,
        host: host === null ? "" : host,
      }),
  },

  ssh: {
    get: () => req<SshState>("GET", "/ssh"),
    select: (host: string | null, remote_port?: number | null) =>
      req<SshState>("PUT", "/ssh", {
        host,
        ...(remote_port !== undefined ? { remote_port } : {}),
      }),
    test: (host?: string) => req<SshTest>("POST", "/ssh/test", host ? { host } : {}),
  },

  git: {
    status: (id: string) =>
      req<GitStatus>("GET", `/terminals/${encodeURIComponent(id)}/git/status`),
    diff: (id: string, staged: boolean, path?: string) =>
      req<{ diff: string; truncated: boolean }>(
        "GET",
        `/terminals/${encodeURIComponent(id)}/git/diff`,
        undefined,
        { staged: staged ? "1" : "0", path },
      ),
    terminalWorktrees: (id: string) =>
      req<WorktreeListing>("GET", `/terminals/${encodeURIComponent(id)}/git/worktrees`),
    stage: (id: string, paths: string[]) =>
      req<null>("POST", `/terminals/${encodeURIComponent(id)}/git/stage`, {
        paths,
      }),
    switchBranch: (id: string, branch: string) =>
      req<null>("POST", `/terminals/${encodeURIComponent(id)}/git/switch`, {
        branch,
      }),
    checkoutGithub: (id: string) =>
      req<GithubFeed>("GET", `/terminals/${encodeURIComponent(id)}/git/github`),
    pullReview: (id: string, number: number) =>
      req<PullReview>("GET", `/terminals/${encodeURIComponent(id)}/git/pulls/${number}`),
    postPullComment: (id: string, number: number, body: PullCommentInput) =>
      req<null>("POST", `/terminals/${encodeURIComponent(id)}/git/pulls/${number}/comments`, body),
    saveFile: (id: string, path: string, content: string, original: string) =>
      req<null>("PUT", `/terminals/${encodeURIComponent(id)}/files`, {
        path,
        content,
        original,
      }),
    files: (id: string, path: string) =>
      req<{
        root: string;
        path: string;
        entries: { name: string; path: string; directory: boolean }[] | null;
        content: string | null;
        binary: boolean;
        truncated: boolean;
      }>("GET", `/terminals/${encodeURIComponent(id)}/files`, undefined, {
        path,
      }),
    commit: (id: string, message: string) =>
      req<null>("POST", `/terminals/${encodeURIComponent(id)}/git/commit`, {
        message,
      }),
    addWorktree: (id: string) =>
      req<{ path: string }>("POST", `/terminals/${encodeURIComponent(id)}/git/worktrees`),
    githubItems: (filter: string, project_id?: string) =>
      req<GithubFeed>("GET", "/github/items", undefined, {
        filter,
        project_id,
      }),
    registry: (project_id?: string) =>
      req<{
        repos: WorktreeListing[];
        errors: { cwd: string; error: string }[];
      }>("GET", "/git/registry", undefined, { project_id }),
    cleanup: (items: { cwd: string; path: string; delete_branch?: boolean }[]) =>
      req<{
        results: { path: string; removed: boolean; error: string | null }[];
      }>("POST", "/git/worktrees/cleanup", { items }),
    worktrees: (cwd: string, host?: string | null) =>
      req<WorktreeListing>("GET", "/git/worktrees", undefined, {
        cwd,
        host: host === null ? "" : host,
      }),
    removeWorktree: (data: { cwd: string; path: string; force?: boolean; host?: string | null }) =>
      req<null>("POST", "/git/worktrees/remove", data),
  },

  gateway: {
    status: () => req<{ running: boolean; status: string }>("GET", "/gateway/status"),
    send: (data: { platform: string; chat_id: string; text: string; thread_id?: string }) =>
      req<null>("POST", "/gateway/send", data),
  },
};
