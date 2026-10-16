import { loadConfig } from "@orc/core/config";
import type { KnowledgeDocument } from "@orc/core/knowledge";
import type { PackageDiscovery } from "@orc/core/primitive-types";
import type { RuleTemplate } from "@orc/core/rule-catalog";
import type { RuleEventCapability, RuleHookBackend } from "@orc/core/rule-events";
import type { RuleDecision, RuleEvent, RulePolicy, RuleRevision } from "@orc/core/rule-types";
import type {
  SessionHandoff,
  SessionHandoffInput,
  SessionHandoffUpload,
} from "@orc/core/session-handoff";
import type {
  LocalSkillAgentListing,
  LocalSkillImportItem,
  LocalSkillImportResult,
  SkillDiscovery,
  SkillImportInput,
  SkillImportOrigin,
  SkillSyncInput,
  SkillSyncResult,
} from "@orc/core/skill-import-types";
import type {
  AgentBackendInfo,
  AgentFull,
  AgentProfile,
  ApiResult,
  AttachFlowInput,
  AuditEntry,
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
  MemoryChange,
  MemoryListItem,
  MemoryListSort,
  PackageFull,
  PackageMeta,
  Project,
  ProjectSummary,
  ResumeFlowInput,
  Session,
  SessionDetail,
  SessionSearchResult,
  SessionSyncResult,
  SkillChange,
  SkillFileInput,
  SkillFull,
  SkillMeta,
  SkillRefContent,
  SkillSource,
  SkillUpdate,
  Task,
  TaskLink,
  TranscriptPage,
  UpdateJobInput,
  UpdateMemoryInput,
  UpdateProjectInput,
  UpdateTaskInput,
  WikiChange,
  WikiIndexEntry,
  WikiPage,
  WikiRevision,
  WikiScope,
  WikiSearchHit,
  WikiWrite,
} from "./types.js";

export type OrcClientOptions = {
  baseUrl?: string;
  secret?: string;
  /** Sent as X-Orc-Client so the API can attribute usage (e.g. skill reads) to the caller. */
  client?: string;
};

async function call<T>(
  baseUrl: string,
  secret: string | undefined,
  client: string | undefined,
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

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (client) headers["X-Orc-Client"] = client;

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
        error: {
          error: err.error ?? "Unknown error",
          code: err.code ?? "UNKNOWN",
        },
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
  ) => call<T>(baseUrl, secret, options?.client, method, `/api${path}`, body, query);

  return {
    handoffs: {
      create: (input: SessionHandoffInput) =>
        c<SessionHandoffUpload>("POST", "/session-handoffs", input),
      get: (id: string) => c<SessionHandoff>("GET", `/session-handoffs/${encodeURIComponent(id)}`),
      prepare: (id: string) =>
        c<SessionHandoff>("POST", `/session-handoffs/${encodeURIComponent(id)}/prepare`),
    },
    rules: {
      catalog: () => c<{ templates: RuleTemplate[] }>("GET", "/rules/catalog"),
      list: (workspace?: string) =>
        c<{
          enabled: boolean;
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
          adapters: { backend: string; interception: string }[];
          events: Record<RuleHookBackend, RuleEventCapability[]>;
        }>("GET", "/rules", undefined, { workspace }),
      activate: (policy: RulePolicy, expected_id: string | null, reason: string) =>
        c<RuleRevision>("POST", "/rules/activate", {
          policy,
          expected_id,
          reason,
        }),
      revert: (id: string, reason: string) =>
        c<RuleRevision>("POST", "/rules/revert", { id, reason }),
      check: (event: RuleEvent) => c<RuleDecision>("POST", "/rules/check", event),
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
      list: (params?: {
        project_id?: string | undefined;
        q?: string | undefined;
        sort?: MemoryListSort | undefined;
        limit?: number | undefined;
      }) =>
        c<{ memories: MemoryListItem[]; total: number }>(
          "GET",
          "/memories",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      get: (project_id: string, name: string) =>
        c<Memory>("GET", `/memories/${encodeURIComponent(name)}`, undefined, { project_id }),

      create: (input: CreateMemoryInput) => c<Memory>("POST", "/memories", input),

      update: (project_id: string, name: string, fields: UpdateMemoryInput) =>
        c<Memory>("PATCH", `/memories/${encodeURIComponent(name)}`, { project_id, ...fields }),

      delete: (
        project_id: string,
        name: string,
        writer?: { author?: string | undefined; session_id?: string | undefined },
      ) =>
        c<null>("DELETE", `/memories/${encodeURIComponent(name)}`, undefined, {
          project_id,
          author: writer?.author,
          session_id: writer?.session_id,
        }),

      history: (project_id: string, name: string) =>
        c<{ changes: MemoryChange[] }>(
          "GET",
          `/memories/${encodeURIComponent(name)}/history`,
          undefined,
          { project_id },
        ),

      revert: (
        project_id: string,
        name: string,
        input: {
          change_id: string;
          expected_change_id: string;
          reason: string;
          author?: string;
          session_id?: string;
        },
      ) =>
        c<{ memory: Memory | null }>("POST", `/memories/${encodeURIComponent(name)}/revert`, {
          project_id,
          ...input,
        }),
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
      visibility: () => c<{ hidden_builtins: string[] }>("GET", "/skills/settings/visibility"),
      setVisibility: (hidden_builtins: string[]) =>
        c<{ hidden_builtins: string[] }>("PUT", "/skills/settings/visibility", { hidden_builtins }),
      updateInstructions: (name: string, input: Omit<SkillUpdate, "skill_name">) =>
        c<SkillFull>("PUT", `/skills/${encodeURIComponent(name)}/instructions`, input),
      history: (name: string, scope: WikiScope = {}) =>
        c<{ changes: SkillChange[] }>(
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
      ) => c<SkillFull>("POST", `/skills/${encodeURIComponent(name)}/revert`, input),

      discover: (source: string) => c<SkillDiscovery>("POST", "/skills/discover", { source }),
      import: (input: SkillImportInput) =>
        c<{ skills: SkillFull[] }>("POST", "/skills/import", input),
      origin: (name: string) =>
        c<SkillImportOrigin | null>("GET", `/skills/${encodeURIComponent(name)}/origin`),
      localAgents: () => c<{ agents: LocalSkillAgentListing[] }>("GET", "/skills/local-agents"),
      importLocal: (skills: LocalSkillImportItem[]) =>
        c<LocalSkillImportResult>("POST", "/skills/local-agents/import", { skills }),
      sync: (name: string, input: SkillSyncInput = {}) =>
        c<SkillSyncResult>("POST", `/skills/${encodeURIComponent(name)}/sync`, input),
      editFile: (name: string, input: { path: string; content: string; expectedContent: string }) =>
        c<SkillFull>("PUT", `/skills/${encodeURIComponent(name)}/file`, input),
      list: (params?: {
        q?: string;
        source?: SkillSource;
        include_hidden?: boolean;
        reload?: boolean;
        project_id?: string;
        scope?: "global";
      }) =>
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
        skills?: string[];
        imported?: boolean;
      }) => c<PackageFull>("POST", "/agent-packages", input),
      update: (
        name: string,
        input: {
          content: string;
          files: SkillFileInput[];
          expectedRevision: string;
          skills?: string[];
        },
      ) => c<PackageFull>("PUT", `/agent-packages/${encodeURIComponent(name)}`, input),
      discover: (source: string) =>
        c<PackageDiscovery>("POST", "/agent-packages/discover", { source }),
      importGit: (input: {
        source: string;
        commit: string;
        path: string;
        format: "apm" | "agent-plugin";
      }) => c<PackageFull>("POST", "/agent-packages/import-git", input),
      acquire: (source: string) =>
        c<{ token: string; source: string; packages: PackageDiscovery["packages"] }>(
          "POST",
          "/agent-packages/acquire",
          { source },
        ),
      importAcquired: (input: { token: string; path: string }) =>
        c<PackageFull>("POST", "/agent-packages/import-acquired", input),
      exportArtifact: (name: string) =>
        c<{ filename: string; content: string; format: string }>(
          "POST",
          `/agent-packages/${encodeURIComponent(name)}/export`,
        ),
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
        c<{ valid: boolean; errors: string[] }>("POST", "/flows/validate", {
          definition,
        }),
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
        order?: "asc" | "desc";
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
      list: (params?: { resource_type?: "task" | "project" }) =>
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

    wiki: {
      list: (scope: WikiScope = {}) =>
        c<{ pages: WikiIndexEntry[] }>("GET", "/wiki", undefined, scope),
      changes: (scope: WikiScope = {}) =>
        c<{ changes: WikiChange[] }>("GET", "/wiki/changes", undefined, scope),
      search: (q: string, scope: WikiScope = {}) =>
        c<{ results: WikiSearchHit[] }>("GET", "/wiki/search", undefined, { ...scope, q }),
      get: (slug: string, scope: WikiScope = {}) =>
        c<WikiPage>("GET", `/wiki/${encodeURIComponent(slug)}`, undefined, scope),
      history: (slug: string, scope: WikiScope = {}) =>
        c<{ revisions: WikiRevision[] }>(
          "GET",
          `/wiki/${encodeURIComponent(slug)}/history`,
          undefined,
          scope,
        ),
      write: (input: WikiWrite) => c<WikiRevision>("POST", "/wiki", input),
    },
    audit: {
      list: (scope: WikiScope = {}) =>
        c<{ entries: AuditEntry[] }>("GET", "/audit", undefined, scope),
    },

    knowledge: {
      search: (
        q: string,
        opts?: {
          collection?: string;
          project_id?: string;
          mode?: string;
          limit?: number;
        },
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
        c<KnowledgeDocument>("GET", `/knowledge/documents/${encodeURIComponent(id)}`),

      edit: (id: string, content: string, expectedContent: string) =>
        c<KnowledgeDocument>("PUT", `/knowledge/documents/${encodeURIComponent(id)}`, {
          content,
          expectedContent,
        }),

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
