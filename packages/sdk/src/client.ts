import { loadConfig } from "@orc/core/config";
import type { EvidenceSource, Passage, RetrievalQuery, RetrievalResult } from "@orc/core/retrieval";
import type {
  SkillActivation,
  SkillEvaluation,
  SkillProposal,
  WikiContribution,
  WikiContributionAttempt,
  WikiOutcome,
  WikiPage,
} from "@orc/core/wiki";
import type {
  AgentBackendInfo,
  AgentFull,
  AgentProfile,
  ApiResult,
  AttachFlowInput,
  BrokenAgent,
  BrokenFlow,
  CreateFlowInput,
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
  SkillSource,
  Task,
  TaskLink,
  TranscriptPage,
  UpdateJobInput,
  UpdateMemoryInput,
  UpdateProjectInput,
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
  ) => call<T>(baseUrl, secret, method, `/api${path}`, body, query);

  return {
    evolution: {
      propose: (input: SkillProposal) => c<{ id: string }>("POST", "/skills/proposals", input),
      evaluate: (input: SkillEvaluation) =>
        c<{ id: string; result: string }>("POST", "/skills/evaluations", input),
      proposals: (project_id?: string) =>
        c<{
          proposals: {
            id: string;
            skill_name: string;
            status: string;
            decision: string | null;
            payload: string;
          }[];
          evaluations: { id: string; proposal_id: string; payload: string; result: string }[];
        }>("GET", "/skills/proposals", undefined, { project_id }),
      reject: (id: string, project_id: string | null, reason: string) =>
        c<{ ok: true }>("POST", "/skills/proposals/reject", { id, project_id, reason }),
      baseline: (name: string, project_id?: string) =>
        c<{ hash: string; base_hash: string; raw: string }>(
          "GET",
          "/skills/evolution/baseline",
          undefined,
          { name, project_id },
        ),
      history: (project_id?: string) =>
        c<{ history: SkillActivation[] }>("GET", "/skills/evolution", undefined, { project_id }),
      revert: (id: string, project_id: string | null, reason: string) =>
        c<{ id: string }>("POST", "/skills/evolution/revert", { id, project_id, reason }),
    },
    evidence: {
      get: (ids: string[], project_id: string | null) =>
        c<{ passages: Passage[] }>("POST", "/knowledge/passages/get", { ids, project_id }),
      embed: (kind: EvidenceSource["kind"], source_id: string, project_id: string | null) =>
        c<{ embedded: number; semantic: "off" | "ready" | "degraded" }>(
          "POST",
          "/knowledge/passages/embed",
          { kind, source_id, project_id },
        ),
      search: (input: RetrievalQuery) =>
        c<RetrievalResult>("POST", "/knowledge/passages/search", input),
      index: (input: EvidenceSource) =>
        c<{ version: string }>("POST", "/knowledge/passages/index", input),
      expand: (id: string, project_id: string | null, radius = 1) =>
        c<{ passages: Passage[] }>("POST", "/knowledge/passages/expand", {
          id,
          project_id,
          radius,
        }),
    },
    wiki: {
      read: (project_id?: string, slug?: string) =>
        c<{
          pages: WikiPage[];
          history: WikiPage[];
          contributions: WikiContribution[];
          attempts: WikiContributionAttempt[];
        }>("GET", "/knowledge/wiki", undefined, { project_id, slug }),
      apply: (input: WikiOutcome) => c<{ ok: true }>("POST", "/knowledge/wiki/apply", input),
    },
    tasks: {
      list: (params?: { project_id?: string; status?: string; tag?: string; limit?: number }) =>
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

      addComment: (id: string, content: string, author = "human") =>
        c<{
          id: string;
          resource_type: string;
          resource_id: string;
          content: string;
          author: string;
          created_at: string;
        }>("POST", `/tasks/${id}/comments`, { content, author }),

      listComments: (id: string) =>
        c<{
          comments: {
            id: string;
            resource_type: string;
            resource_id: string;
            content: string;
            author: string;
            created_at: string;
          }[];
        }>("GET", `/tasks/${id}/comments`),

      listLinks: (id: string) => c<{ links: TaskLink[] }>("GET", `/tasks/${id}/links`),

      addLink: (id: string, input: CreateTaskLinkInput) =>
        c<TaskLink>("POST", `/tasks/${id}/links`, input),

      deleteLink: (id: string, linkId: string) => c<null>("DELETE", `/tasks/${id}/links/${linkId}`),

      flow: (id: string) => c<FlowRun>("GET", `/tasks/${id}/flow`),

      attachFlow: (id: string, input: AttachFlowInput) =>
        c<{
          attached: string;
          started: boolean;
          flow_run_id: string | null;
          error: string | null;
        }>("POST", `/tasks/${id}/flow`, input),

      resumeFlow: (id: string, input: ResumeFlowInput) =>
        c<{ ok: boolean; next_nodes: string[] }>("POST", `/tasks/${id}/flow/resume`, input),

      haltFlow: (id: string, reason?: string) =>
        c<{ halted: boolean }>("POST", `/tasks/${id}/flow/halt`, { reason }),
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

      update: (id: string, input: UpdateMemoryInput) =>
        c<Memory>("PATCH", `/memories/${id}`, input),

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

    skills: {
      list: (params?: { q?: string; source?: SkillSource; reload?: boolean }) =>
        c<{
          skills: SkillMeta[];
          broken: BrokenAgent[];
          warnings: Array<{ path: string; message: string }>;
        }>(
          "GET",
          "/skills",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      read: (name: string, ref?: string, project_id?: string) =>
        c<SkillFull | SkillRefContent>("GET", `/skills/${encodeURIComponent(name)}`, undefined, {
          ref,
          project_id,
        }),

      create: (input: CreateSkillInput) => c<SkillFull>("POST", "/skills", input),
    },
    agents: {
      list: () => c<{ agents: AgentProfile[]; broken: BrokenAgent[] }>("GET", "/agents"),
      delete: (id: string) => c<null>("DELETE", `/agents/${encodeURIComponent(id)}`),
      update: (id: string, input: { content: string; expectedRaw: string; expectedPath: string }) =>
        c<AgentFull>("PUT", `/agents/${encodeURIComponent(id)}`, input),
      read: (id: string) => c<AgentFull>("GET", `/agents/${encodeURIComponent(id)}`),
      create: (input: { id: string; content: string }) => c<AgentFull>("POST", "/agents", input),
    },
    agentPackages: {
      list: () => c<{ packages: PackageMeta[]; broken: BrokenAgent[] }>("GET", "/agent-packages"),
      read: (name: string, ref?: string) =>
        c<PackageFull | SkillRefContent>(
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
      }) => c<PackageFull>("POST", "/agent-packages", input),
    },

    backends: {
      list: () => c<{ backends: AgentBackendInfo[]; default_backend: string }>("GET", "/backends"),
    },

    flows: {
      list: (params?: { q?: string; source?: FlowSource; reload?: boolean }) =>
        c<{ flows: FlowMeta[]; broken: BrokenFlow[]; default_flow: string }>(
          "GET",
          "/flows",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      read: (name: string) => c<FlowFull>("GET", `/flows/${encodeURIComponent(name)}`),

      create: (input: CreateFlowInput) => c<FlowFull>("POST", "/flows", input),

      validate: (definition: Record<string, unknown>) =>
        c<{ valid: boolean; errors: string[] }>("POST", "/flows/validate", { definition }),
    },

    projects: {
      list: (params?: { status?: string; tag?: string; limit?: number }) =>
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

      addComment: (id: string, content: string, author = "human") =>
        c<{
          id: string;
          resource_type: string;
          resource_id: string;
          content: string;
          author: string;
          created_at: string;
        }>("POST", `/projects/${id}/comments`, { content, author }),

      listComments: (id: string) =>
        c<{
          comments: {
            id: string;
            resource_type: string;
            resource_id: string;
            content: string;
            author: string;
            created_at: string;
          }[];
        }>("GET", `/projects/${id}/comments`),
    },

    sessions: {
      list: (params?: {
        agent?: string;
        job_run_id?: string;
        project_id?: string;
        limit?: number;
        offset?: number;
      }) =>
        c<{ sessions: Session[]; total: number }>(
          "GET",
          "/sessions",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      get: (id: string) => c<SessionDetail>("GET", `/sessions/${id}`),

      sync: () => c<{ results: SessionSyncResult[] }>("POST", "/sessions/live/sync"),

      search: (params: { q: string; agent?: string; limit?: number }) =>
        c<SessionSearchResult>(
          "GET",
          "/sessions/live/search",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      transcript: (id: string, params?: { offset?: number; limit?: number; q?: string }) =>
        c<TranscriptPage>(
          "GET",
          `/sessions/live/${id}/transcript`,
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      live: (params?: { agent?: string; task_id?: string; active?: boolean; limit?: number }) =>
        c<{ sessions: LiveSession[] }>(
          "GET",
          "/sessions/live",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      linkTask: (id: string, task_id: string | null) =>
        c<LiveSession>("PATCH", `/sessions/live/${id}`, { task_id }),
    },

    tags: {
      list: (params?: { resource_type?: "task" | "project" | "memory" }) =>
        c<{ tags: { name: string; count: number; resource_type: string }[] }>(
          "GET",
          "/tags",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),
    },

    health: {
      check: () => c<HealthResponse>("GET", "/health"),
    },

    gateway: {
      status: () => c<{ running: boolean; status: string }>("GET", "/gateway/status"),

      send: (input: { platform: string; chat_id: string; text: string; thread_id?: string }) =>
        c<null>("POST", "/gateway/send", input),
    },

    knowledge: {
      search: (
        q: string,
        opts?: { collection?: string; project_id?: string; mode?: string; limit?: number },
      ) =>
        c<{
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

      get: (id: string) =>
        c<{
          docid: string;
          path: string;
          collection: string;
          title: string;
          content: string;
          modifiedAt: string;
        }>("GET", `/knowledge/documents/${encodeURIComponent(id)}`),

      collections: (params?: { project_id?: string }) =>
        c<{
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

      addCollection: (input: {
        name: string;
        path: string;
        pattern?: string;
        project_id?: string;
      }) => c<{ name: string; indexed: number }>("POST", "/knowledge/collections", input),

      removeCollection: (name: string) =>
        c<null>("DELETE", `/knowledge/collections/${encodeURIComponent(name)}`),

      update: (opts?: { collections?: string[] }) =>
        c<{ indexed: number; updated: number; removed: number }>(
          "POST",
          "/knowledge/update",
          opts ?? {},
        ),

      status: () =>
        c<{
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
  };
}

export type OrcClient = ReturnType<typeof createOrcClient>;
