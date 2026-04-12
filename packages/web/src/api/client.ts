// Browser-compatible ORC API client.
// Types imported from @orc/sdk for end-to-end type safety.
// Dev: Vite proxies /api/* → http://localhost:7701/*
// Override via localStorage: orc_api_url, orc_api_secret

export type {
  Comment,
  CreateJobInput,
  CreateMemoryInput,
  CreateProjectInput,
  CreateSkillInput,
  CreateTaskInput,
  CreateTaskLinkInput,
  HealthResponse,
  Job,
  JobRun,
  JobRunLog,
  JobStatus,
  JobTriggerType,
  Memory,
  MemoryType,
  Project,
  ProjectStatus,
  ProjectSummary,
  Session,
  SessionDetail,
  SessionEvent,
  SkillFull,
  SkillMeta,
  SkillRefContent,
  SkillSource,
  Task,
  TaskLink,
  TaskLinkType,
  TaskPriority,
  TaskStatus,
  UpdateJobInput,
  UpdateMemoryInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@orc/sdk/types";

import type {
  Comment,
  CreateJobInput,
  CreateMemoryInput,
  CreateProjectInput,
  CreateSkillInput,
  CreateTaskInput,
  CreateTaskLinkInput,
  HealthResponse,
  Job,
  JobRun,
  JobRunLog,
  Memory,
  Project,
  ProjectSummary,
  Session,
  SessionDetail,
  SkillFull,
  SkillMeta,
  SkillRefContent,
  Task,
  TaskLink,
  UpdateJobInput,
  UpdateMemoryInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "@orc/sdk/types";

export const getApiUrl = (): string =>
  localStorage.getItem("orc_api_url") ?? "/api";

export const getApiSecret = (): string =>
  localStorage.getItem("orc_api_secret") ?? "";

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
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
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null as T;
  const json = (await res.json()) as unknown;
  if (!res.ok) {
    const e = json as { error?: unknown };
    const msg = typeof e.error === "string" ? e.error : `HTTP ${res.status}`;
    throw new Error(msg);
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
        "GET", "/tasks", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<Task>("GET", `/tasks/${id}`),
    create: (data: CreateTaskInput) => req<Task>("POST", "/tasks", data),
    update: (id: string, data: UpdateTaskInput) => req<Task>("PATCH", `/tasks/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/tasks/${id}`),
    addComment: (id: string, content: string, author = "human") =>
      req<Comment>("POST", `/tasks/${id}/comments`, { content, author }),
    listComments: (id: string) =>
      req<{ comments: Comment[] }>("GET", `/tasks/${id}/comments`),
    listLinks: (id: string) =>
      req<{ links: TaskLink[] }>("GET", `/tasks/${id}/links`),
    addLink: (id: string, data: CreateTaskLinkInput) =>
      req<TaskLink>("POST", `/tasks/${id}/links`, data),
    deleteLink: (id: string, linkId: string) =>
      req<null>("DELETE", `/tasks/${id}/links/${linkId}`),
  },

  memories: {
    list: (params?: { scope?: string; project_id?: string; limit?: number }) =>
      req<{ memories: Memory[] }>(
        "GET", "/memories", undefined,
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
        "GET", "/jobs", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<Job>("GET", `/jobs/${id}`),
    create: (data: CreateJobInput) => req<Job>("POST", "/jobs", data),
    update: (id: string, data: UpdateJobInput) => req<Job>("PATCH", `/jobs/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/jobs/${id}`),
    trigger: (id: string) => req<{ run_id: string }>("POST", `/jobs/${id}/trigger`),
    runs: (id: string, limit = 10) =>
      req<{ runs: JobRun[] }>("GET", `/jobs/${id}/runs`, undefined, { limit }),
    runLogs: (id: string, runId: string, params?: { stream?: "stdout" | "stderr"; limit?: number }) =>
      req<{ logs: JobRunLog[] }>(
        "GET", `/jobs/${id}/runs/${runId}/logs`, undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
  },

  projects: {
    list: (params?: { status?: string; tag?: string; limit?: number }) =>
      req<{ projects: Project[] }>(
        "GET", "/projects", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<Project>("GET", `/projects/${id}`),
    getByName: (name: string) => req<Project>("GET", `/projects/by-name/${encodeURIComponent(name)}`),
    summary: (id: string) => req<ProjectSummary>("GET", `/projects/${id}/summary`),
    create: (data: CreateProjectInput) => req<Project>("POST", "/projects", data),
    update: (id: string, data: UpdateProjectInput) => req<Project>("PATCH", `/projects/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/projects/${id}`),
    addComment: (id: string, content: string, author = "human") =>
      req<Comment>("POST", `/projects/${id}/comments`, { content, author }),
    listComments: (id: string) =>
      req<{ comments: Comment[] }>("GET", `/projects/${id}/comments`),
  },

  sessions: {
    list: (params?: { agent?: string; job_run_id?: string; limit?: number }) =>
      req<{ sessions: Session[] }>(
        "GET", "/sessions", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<SessionDetail>("GET", `/sessions/${id}`),
  },

  skills: {
    list: (params?: { q?: string; source?: "builtin" | "user"; reload?: boolean }) =>
      req<{ skills: SkillMeta[] }>(
        "GET", "/skills", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (name: string, ref?: string) =>
      req<SkillFull | SkillRefContent>(
        "GET", `/skills/${encodeURIComponent(name)}`, undefined,
        ref ? { ref } : undefined,
      ),
    create: (data: CreateSkillInput) => req<SkillFull>("POST", "/skills", data),
  },

  knowledge: {
    collections: (params?: { project_id?: string }) =>
      req<{ collections: { name: string; path: string; pattern: string; documentCount: number; lastModified: string | null; projectId: string | null }[] }>(
        "GET", "/knowledge/collections", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    search: (q: string, opts?: { collection?: string; project_id?: string; mode?: string; limit?: number }) =>
      req<{
        results: { docid: string; path: string; collection: string; title: string; snippet: string; score: number }[];
      }>("GET", "/knowledge/search", undefined, {
        q, collection: opts?.collection, project_id: opts?.project_id, mode: opts?.mode, limit: opts?.limit,
      }),
    getDocument: (id: string) =>
      req<{ docid: string; path: string; collection: string; title: string; content: string; modifiedAt: string }>(
        "GET", `/knowledge/documents/${encodeURIComponent(id)}`,
      ),
    addCollection: (data: { name: string; path: string; pattern?: string; project_id?: string }) =>
      req<{ name: string; indexed: number }>("POST", "/knowledge/collections", data),
    removeCollection: (name: string) =>
      req<null>("DELETE", `/knowledge/collections/${encodeURIComponent(name)}`),
    update: (opts?: { collections?: string[] }) =>
      req<{ indexed: number; updated: number; removed: number }>("POST", "/knowledge/update", opts ?? {}),
    status: () =>
      req<{ collections: { name: string; path: string; pattern: string; documentCount: number; lastModified: string | null; projectId: string | null }[]; totalDocuments: number; dbPath: string; searchMode: string }>(
        "GET", "/knowledge/status",
      ),
  },

  tags: {
    list: (params?: { resource_type?: "task" | "project" | "memory" }) =>
      req<{ tags: { name: string; count: number; resource_type: string }[] }>(
        "GET", "/tags", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
  },

  gateway: {
    status: () => req<{ running: boolean; status: string }>("GET", "/gateway/status"),
    send: (data: { platform: string; chat_id: string; text: string; thread_id?: string }) =>
      req<null>("POST", "/gateway/send", data),
  },
};
