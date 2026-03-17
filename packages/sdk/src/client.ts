import { loadConfig } from "@orc/core/config";
import type {
  ApiResult,
  CreateJobInput,
  CreateMemoryInput,
  CreateProjectInput,
  CreatePromptInput,
  CreateTaskInput,
  CreateTaskLinkInput,
  HealthResponse,
  Job,
  JobRun,
  JobRunLog,
  Memory,
  Project,
  ProjectSummary,
  Prompt,
  PromptHistoryEntry,
  RenderedPrompt,
  Session,
  Task,
  TaskLink,
  UpdateJobInput,
  UpdateProjectInput,
  UpdatePromptInput,
  UpdateTaskInput,
} from "./types.js";

export type OrcClientOptions = {
  baseUrl?: string;
  secret?: string;
};

async function call<T>(
  baseUrl: string,
  secret: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<ApiResult<T>> {
  let url = `${baseUrl}${path}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const str = params.toString();
    if (str) url += `?${str}`;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 204) return { data: null as T, error: null };

    const json = (await res.json()) as unknown;
    if (!res.ok) {
      const err = json as { error?: string; code?: string };
      return {
        data: null,
        error: { error: err.error ?? "Unknown error", code: err.code ?? "UNKNOWN" },
      };
    }

    return { data: json as T, error: null };
  } catch (err) {
    return { data: null, error: { error: String(err), code: "NETWORK_ERROR" } };
  }
}

export function createOrcClient(options?: OrcClientOptions) {
  const config = loadConfig();
  const baseUrl = options?.baseUrl ?? `http://${config.api.host}:${config.api.port}`;
  const secret = options?.secret ?? config.api.secret;
  const c = <T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ) => call<T>(baseUrl, secret, method, path, body, query);

  return {
    tasks: {
      list: (params?: { project_id?: string; status?: string; limit?: number }) =>
        c<{ tasks: Task[]; total: number }>(
          "GET",
          "/tasks",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      get: (id: string) => c<Task>("GET", `/tasks/${id}`),

      create: (input: CreateTaskInput) => c<Task>("POST", "/tasks", input),

      update: (id: string, input: UpdateTaskInput) => c<Task>("PATCH", `/tasks/${id}`, input),

      delete: (id: string) => c<null>("DELETE", `/tasks/${id}`),

      addNote: (id: string, content: string, author = "human") =>
        c<{ id: string; task_id: string; content: string; author: string; created_at: string }>(
          "POST",
          `/tasks/${id}/notes`,
          { content, author },
        ),

      listLinks: (id: string) => c<{ links: TaskLink[] }>("GET", `/tasks/${id}/links`),

      addLink: (id: string, input: CreateTaskLinkInput) =>
        c<TaskLink>("POST", `/tasks/${id}/links`, input),

      deleteLink: (id: string, linkId: string) => c<null>("DELETE", `/tasks/${id}/links/${linkId}`),
    },

    memories: {
      list: (params?: { scope?: string; project_id?: string; limit?: number }) =>
        c<{ memories: Memory[] }>(
          "GET",
          "/memories",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      search: (q: string, opts?: { scope?: string; project_id?: string; limit?: number }) =>
        c<{ results: Memory[] }>("GET", "/memories/search", undefined, {
          q,
          scope: opts?.scope,
          project_id: opts?.project_id,
          limit: opts?.limit,
        }),

      create: (input: CreateMemoryInput) => c<Memory>("POST", "/memories", input),

      delete: (id: string) => c<null>("DELETE", `/memories/${id}`),
    },

    jobs: {
      list: (params?: { enabled?: boolean; project_id?: string; limit?: number }) =>
        c<{ jobs: Job[] }>(
          "GET",
          "/jobs",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      get: (id: string) => c<Job>("GET", `/jobs/${id}`),

      create: (input: CreateJobInput) => c<Job>("POST", "/jobs", input),

      update: (id: string, input: UpdateJobInput) => c<Job>("PATCH", `/jobs/${id}`, input),

      delete: (id: string) => c<null>("DELETE", `/jobs/${id}`),

      trigger: (id: string) => c<{ run_id: string }>("POST", `/jobs/${id}/trigger`),

      runs: (id: string, limit?: number) =>
        c<{ runs: JobRun[] }>("GET", `/jobs/${id}/runs`, undefined, { limit }),

      runLogs: (
        id: string,
        runId: string,
        params?: { stream?: "stdout" | "stderr"; limit?: number },
      ) =>
        c<{ logs: JobRunLog[] }>(
          "GET",
          `/jobs/${id}/runs/${runId}/logs`,
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),
    },

    prompts: {
      list: (params?: { is_skill?: boolean; limit?: number }) =>
        c<{ prompts: Prompt[] }>(
          "GET",
          "/prompts",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      get: (id: string) => c<Prompt>("GET", `/prompts/${id}`),

      create: (input: CreatePromptInput) => c<Prompt>("POST", "/prompts", input),

      update: (id: string, input: UpdatePromptInput) => c<Prompt>("PATCH", `/prompts/${id}`, input),

      delete: (id: string) => c<null>("DELETE", `/prompts/${id}`),

      render: (id: string, vars?: Record<string, string>) =>
        c<RenderedPrompt>("POST", `/prompts/${id}/render`, { vars: vars ?? {} }),

      history: (id: string, limit?: number) =>
        c<{ history: PromptHistoryEntry[] }>("GET", `/prompts/${id}/history`, undefined, { limit }),
    },

    projects: {
      list: (params?: { status?: string; limit?: number }) =>
        c<{ projects: Project[] }>(
          "GET",
          "/projects",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      get: (id: string) => c<Project>("GET", `/projects/${id}`),

      getByName: (name: string) =>
        c<Project>("GET", `/projects/by-name/${encodeURIComponent(name)}`),

      summary: (id: string) => c<ProjectSummary>("GET", `/projects/${id}/summary`),

      create: (input: CreateProjectInput) => c<Project>("POST", "/projects", input),

      update: (id: string, input: UpdateProjectInput) =>
        c<Project>("PATCH", `/projects/${id}`, input),

      delete: (id: string) => c<null>("DELETE", `/projects/${id}`),
    },

    sessions: {
      list: (params?: { agent?: string; job_run_id?: string; limit?: number }) =>
        c<{ sessions: Session[] }>(
          "GET",
          "/sessions",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      get: (id: string) =>
        c<Session & { events: unknown[]; snapshot: string | null }>("GET", `/sessions/${id}`),
    },

    health: {
      check: () => c<HealthResponse>("GET", "/health"),
    },

    gateway: {
      status: () => c<{ running: boolean; status: string }>("GET", "/gateway/status"),

      send: (input: { platform: string; chat_id: string; text: string; thread_id?: string }) =>
        c<null>("POST", "/gateway/send", input),
    },
  };
}

export type OrcClient = ReturnType<typeof createOrcClient>;
