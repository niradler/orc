// Browser-compatible ORC API client.
// Dev: Vite proxies /api/* → http://localhost:7700/*
// Override via localStorage: orc_api_url, orc_api_secret

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

// ---- Types ----

export type TaskStatus =
  | "todo" | "queued" | "doing" | "review"
  | "changes_requested" | "blocked" | "done" | "cancelled" | "paused";

export type TaskPriority = "low" | "normal" | "high" | "critical";

export type Task = {
  id: string;
  project_id: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  progress: number;
  due_at: string | null;
  tags: string[] | null;
  author: string;
  claimed_by: string | null;
  skill_name: string | null;
  created_at: string;
  updated_at: string;
};

export type Memory = {
  id: string;
  project_id: string | null;
  content: string;
  source: string | null;
  scope: string | null;
  tags: string[] | null;
  importance: "low" | "normal" | "high" | "critical";
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Job = {
  id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  command: string;
  trigger_type: string;
  cron_expr: string | null;
  enabled: boolean;
  timeout_secs: number;
  max_retries: number;
  overlap: "skip" | "queue" | "kill";
  notify_on: string;
  run_count: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export type JobRun = {
  id: string;
  job_id: string;
  status: "pending" | "running" | "success" | "failed" | "cancelled" | "skipped";
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
};

export type Project = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
};

export type Session = {
  id: string;
  agent: string | null;
  job_run_id: string | null;
  agent_version: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
};

export type KnowledgeCollection = {
  name: string;
  path: string;
  pattern: string;
  documentCount: number;
  lastModified: string | null;
  projectId: string | null;
};

export type HealthResponse = {
  status: string;
  version: string;
  uptime: number;
};

// ---- API client ----

export const api = {
  health: {
    check: () => req<HealthResponse>("GET", "/health"),
  },

  tasks: {
    list: (params?: { status?: string; project_id?: string; limit?: number }) =>
      req<{ tasks: Task[]; total: number }>(
        "GET", "/tasks", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    create: (data: {
      title: string;
      body?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      project_id?: string;
    }) => req<Task>("POST", "/tasks", data),
    update: (id: string, data: Partial<Pick<Task, "status" | "priority" | "title" | "body">>) =>
      req<Task>("PATCH", `/tasks/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/tasks/${id}`),
    addComment: (id: string, content: string, author = "human") =>
      req<{ id: string; content: string; author: string; created_at: string }>(
        "POST", `/tasks/${id}/comments`, { content, author },
      ),
  },

  memories: {
    list: (params?: { scope?: string; project_id?: string; limit?: number }) =>
      req<{ memories: Memory[] }>(
        "GET", "/memories", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    search: (q: string, opts?: { scope?: string; limit?: number }) =>
      req<{ results: Memory[] }>("GET", "/memories/search", undefined, {
        q,
        scope: opts?.scope,
        limit: opts?.limit,
      }),
    create: (data: { content: string; scope?: string; tags?: string[]; importance?: string }) =>
      req<Memory>("POST", "/memories", data),
    update: (id: string, data: Partial<Pick<Memory, "content" | "scope" | "tags" | "importance">>) =>
      req<Memory>("PATCH", `/memories/${id}`, data),
    delete: (id: string) => req<null>("DELETE", `/memories/${id}`),
  },

  jobs: {
    list: (params?: { enabled?: boolean; project_id?: string }) =>
      req<{ jobs: Job[] }>(
        "GET", "/jobs", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    trigger: (id: string) => req<{ run_id: string }>("POST", `/jobs/${id}/trigger`),
    runs: (id: string, limit = 10) =>
      req<{ runs: JobRun[] }>("GET", `/jobs/${id}/runs`, undefined, { limit }),
  },

  projects: {
    list: (params?: { status?: string }) =>
      req<{ projects: Project[] }>(
        "GET", "/projects", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) => req<Project>("GET", `/projects/${id}`),
    create: (data: { name: string; description?: string }) =>
      req<Project>("POST", "/projects", data),
    delete: (id: string) => req<null>("DELETE", `/projects/${id}`),
  },

  sessions: {
    list: (params?: { agent?: string; limit?: number }) =>
      req<{ sessions: Session[] }>(
        "GET", "/sessions", undefined,
        params as Record<string, string | number | boolean | undefined>,
      ),
    get: (id: string) =>
      req<Session & { events: unknown[]; snapshot: string | null }>("GET", `/sessions/${id}`),
  },

  knowledge: {
    collections: () =>
      req<{ collections: KnowledgeCollection[] }>("GET", "/knowledge/collections"),
    search: (q: string, opts?: { collection?: string; limit?: number }) =>
      req<{
        results: { docid: string; path: string; collection: string; title: string; snippet: string; score: number }[];
      }>("GET", "/knowledge/search", undefined, { q, collection: opts?.collection, limit: opts?.limit }),
    update: () =>
      req<{ indexed: number; updated: number; removed: number }>("POST", "/knowledge/update", {}),
  },
};
