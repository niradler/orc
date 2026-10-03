// Browser-compatible ORC API client.
// Types imported from @orc/sdk for end-to-end type safety.
// Dev: Vite proxies /api/* → http://localhost:7701/api/*
// Override via localStorage: orc_api_url, orc_api_secret

export type {
  AgentBackendInfo,
  BrokenFlow,
  Comment,
  CreateJobInput,
  CreateMemoryInput,
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
  Memory,
  MemoryType,
  Project,
  ProjectStatus,
  ProjectSummary,
  ResumeFlowInput,
  Session,
  SessionDetail,
  SessionEvent,
  SessionSearchResult,
  SessionSyncResult,
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
  UpdateMemoryInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@orc/sdk/types";

import type {
  AgentBackendInfo,
  BrokenFlow,
  Comment,
  CreateJobInput,
  CreateMemoryInput,
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
  Memory,
  Project,
  ProjectSummary,
  ResumeFlowInput,
  Session,
  SessionDetail,
  SessionSearchResult,
  SessionSyncResult,
  SkillFull,
  SkillMeta,
  SkillRefContent,
  Task,
  TaskLink,
  TranscriptPage,
  UpdateJobInput,
  UpdateMemoryInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@orc/sdk/types";

export const getApiUrl = (): string => localStorage.getItem("orc_api_url") ?? "/api";

export const getApiSecret = (): string => localStorage.getItem("orc_api_secret") ?? "";

export type TerminalKind = "shell" | "claude" | "codex" | "cursor";

export type Terminal = {
  id: string;
  name: string;
  kind: TerminalKind;
  cwd: string | null;
  status: "running" | "exited";
  exit_code: number | null;
  pid: number | null;
  live_session_id: string | null;
  created_at: string;
};

export type TerminalsInfo = {
  enabled: boolean;
  ready: boolean;
  reason: string | null;
  launchers: TerminalKind[];
  terminals: Terminal[];
};

export type CreateTerminalInput = {
  kind: TerminalKind;
  cwd?: string;
  name?: string;
  live_session_id?: string;
  worktree?: boolean;
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
  files: { path: string; index: string; working: string; original: string | null }[];
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
};
export type GithubFeed = {
  auth: "gh" | "token" | "none";
  login: string | null;
  items: GithubItem[];
  errors: { repo: string; error: string }[];
  truncated: boolean;
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

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
  opts?: { nullOn404?: boolean },
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
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const secret = getApiSecret();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
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
  health: {
    check: () => req<HealthResponse>("GET", "/health"),
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
      req<FlowRun | null>("GET", `/tasks/${id}/flow`, undefined, undefined, { nullOn404: true }),
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
    list: (params?: { scope?: string; project_id?: string; limit?: number }) =>
      req<{ memories: Memory[] }>(
        "GET",
        "/memories",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    search: (q: string, opts?: { scope?: string; project_id?: string; limit?: number }) =>
      req<{ results: Memory[] }>("GET", "/memories/search", undefined, {
        q,
        scope: opts?.scope,
        project_id: opts?.project_id,
        limit: opts?.limit,
      }),
    create: (data: CreateMemoryInput) => req<Memory>("POST", "/memories", data),
    update: (id: string, data: UpdateMemoryInput) => req<Memory>("PATCH", `/memories/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/memories/${id}`),
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
    list: (params?: {
      agent?: string;
      job_run_id?: string;
      project_id?: string;
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
    list: (params?: { q?: string; source?: "builtin" | "user"; reload?: boolean }) =>
      req<{ skills: SkillMeta[] }>(
        "GET",
        "/skills",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (name: string, ref?: string) =>
      req<SkillFull | SkillRefContent>(
        "GET",
        `/skills/${encodeURIComponent(name)}`,
        undefined,
        ref ? { ref } : undefined,
      ),
    create: (data: CreateSkillInput) => req<SkillFull>("POST", "/skills", data),
  },

  knowledge: {
    collections: (params?: { project_id?: string }) =>
      req<{
        collections: {
          name: string;
          path: string;
          pattern: string;
          documentCount: number;
          lastModified: string | null;
          projectId: string | null;
        }[];
      }>(
        "GET",
        "/knowledge/collections",
        undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    search: (
      q: string,
      opts?: { collection?: string; project_id?: string; mode?: string; limit?: number },
    ) =>
      req<{
        results: {
          docid: string;
          path: string;
          collection: string;
          title: string;
          snippet: string;
          score: number;
        }[];
      }>("GET", "/knowledge/search", undefined, {
        q,
        collection: opts?.collection,
        project_id: opts?.project_id,
        mode: opts?.mode,
        limit: opts?.limit,
      }),
    getDocument: (id: string) =>
      req<{
        docid: string;
        path: string;
        collection: string;
        title: string;
        content: string;
        modifiedAt: string;
      }>("GET", `/knowledge/documents/${encodeURIComponent(id)}`),
    addCollection: (data: { name: string; path: string; pattern?: string; project_id?: string }) =>
      req<{ name: string; indexed: number }>("POST", "/knowledge/collections", data),
    removeCollection: (name: string) =>
      req<null>("DELETE", `/knowledge/collections/${encodeURIComponent(name)}`),
    update: (opts?: { collections?: string[] }) =>
      req<{ indexed: number; updated: number; removed: number }>(
        "POST",
        "/knowledge/update",
        opts ?? {},
      ),
    status: () =>
      req<{
        collections: {
          name: string;
          path: string;
          pattern: string;
          documentCount: number;
          lastModified: string | null;
          projectId: string | null;
        }[];
        totalDocuments: number;
        dbPath: string;
        searchMode: string;
      }>("GET", "/knowledge/status"),
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
    list: () => req<TerminalsInfo>("GET", "/terminals"),
    create: (data: CreateTerminalInput) => req<Terminal>("POST", "/terminals", data),
    get: (id: string) => req<Terminal>("GET", `/terminals/${encodeURIComponent(id)}`),
    remove: (id: string) => req<null>("DELETE", `/terminals/${encodeURIComponent(id)}`),
    ticket: (id: string) =>
      req<{ ticket: string; expires_in: number }>(
        "POST",
        `/terminals/${encodeURIComponent(id)}/ticket`,
      ),
    pickFolder: (initial?: string) =>
      req<{ path: string | null }>("POST", "/terminals/pick-folder", initial ? { initial } : {}),
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
      req<null>("POST", `/terminals/${encodeURIComponent(id)}/git/stage`, { paths }),
    switchBranch: (id: string, branch: string) =>
      req<null>("POST", `/terminals/${encodeURIComponent(id)}/git/switch`, { branch }),
    checkoutGithub: (id: string) =>
      req<GithubFeed>("GET", `/terminals/${encodeURIComponent(id)}/git/github`),
    files: (id: string, path: string) =>
      req<{
        root: string;
        path: string;
        entries: { name: string; path: string; directory: boolean }[] | null;
        content: string | null;
        binary: boolean;
        truncated: boolean;
      }>("GET", `/terminals/${encodeURIComponent(id)}/files`, undefined, { path }),
    commit: (id: string, message: string) =>
      req<null>("POST", `/terminals/${encodeURIComponent(id)}/git/commit`, { message }),
    addWorktree: (id: string) =>
      req<{ path: string }>("POST", `/terminals/${encodeURIComponent(id)}/git/worktrees`),
    githubItems: (filter: string, project_id?: string) =>
      req<GithubFeed>("GET", "/github/items", undefined, { filter, project_id }),
    registry: (project_id?: string) =>
      req<{ repos: WorktreeListing[]; errors: { cwd: string; error: string }[] }>(
        "GET",
        "/git/registry",
        undefined,
        { project_id },
      ),
    cleanup: (items: { cwd: string; path: string; delete_branch?: boolean }[]) =>
      req<{ results: { path: string; removed: boolean; error: string | null }[] }>(
        "POST",
        "/git/worktrees/cleanup",
        { items },
      ),
    worktrees: (cwd: string) => req<WorktreeListing>("GET", "/git/worktrees", undefined, { cwd }),
    removeWorktree: (data: { cwd: string; path: string; force?: boolean }) =>
      req<null>("POST", "/git/worktrees/remove", data),
  },

  gateway: {
    status: () => req<{ running: boolean; status: string }>("GET", "/gateway/status"),
    send: (data: { platform: string; chat_id: string; text: string; thread_id?: string }) =>
      req<null>("POST", "/gateway/send", data),
  },
};
