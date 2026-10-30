import type {
  ChannelConnection,
  ChannelPairingView,
  ChannelProviderInfo,
  ChannelReceipt,
  ChannelSend,
  ChannelView,
} from "@orc/core/channels";
import { loadConfig, resolveApiBase } from "@orc/core/config";
import type { HumanRequest, HumanRequestInput, HumanResponse } from "@orc/core/human-requests";
import type {
  KbCallSource,
  KbComment,
  KbCommentClose,
  KbCommentCreate,
  KbCommentStatus,
  KbCreate,
  KbDigest,
  KbDigestRun,
  KbDigestSet,
  KbDoclingState,
  KbDocument,
  KbDocumentCreate,
  KbDocumentEdit,
  KbDocumentEditResult,
  KbDocumentListing,
  KbDocumentUpdate,
  KbDocumentWithContent,
  KbEvidencePack,
  KbEvidenceRequest,
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
import type { PushConfig, PushDevice, PushSubscriptionInput, PushTopic } from "@orc/core/push";
import type { RuleTemplate } from "@orc/core/rule-catalog";
import type { RuleEventCapability, RuleHookBackend } from "@orc/core/rule-events";
import type { RuleDecision, RuleEvent, RulePolicy, RuleRevision } from "@orc/core/rule-types";
import type {
  ArchiveSearchResult,
  ArchiveSession,
  ArchiveUploadInput,
} from "@orc/core/session-archive";
import type {
  SessionHandoff,
  SessionHandoffInput,
  SessionHandoffUpload,
} from "@orc/core/session-handoff";
import type { SkillDownload } from "@orc/core/skill-download";
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
  RestartResponse,
  ResumeFlowInput,
  ScopeQuery,
  Scratchpad,
  ScratchpadContentUrl,
  ScratchpadCreate,
  ScratchpadKind,
  ScratchpadListItem,
  ScratchpadUpdate,
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
  SkillVisibility,
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
  /**
   * Transport of knowledge calls (the CLI passes "cli"); it decides which KBs the call may edit
   * and how reads are counted. Defaults to "api".
   */
  source?: KbCallSource;
  /** Attribution for knowledge writes and reads. Defaults to ORC_AGENT / ORC_SESSION_ID when set. */
  actor?: { name?: string; session_id?: string };
  /** Active project for knowledge scope: its KBs plus global ones. */
  project_id?: string;
};

function identityHeaders(options?: OrcClientOptions): Record<string, string> {
  const session = process.env.ORC_SESSION_ID;
  const agent = process.env.ORC_AGENT;
  const actor = options?.actor ?? {
    ...(session ? { session_id: session } : {}),
    ...(agent ? { name: agent } : {}),
  };
  return {
    ...(options?.source ? { "X-Orc-Source": options.source } : {}),
    ...(actor.name ? { "X-Orc-Actor-Name": actor.name } : {}),
    ...(actor.session_id ? { "X-Orc-Session-Id": actor.session_id } : {}),
    ...(options?.project_id ? { "X-Orc-Project-Id": options.project_id } : {}),
  };
}

export type KbUploadInput = {
  file: Blob;
  name: string;
  title?: string;
  path?: string;
  labels?: string[];
  description?: string;
  /** Replace this upload's file with a new revision. */
  document_id?: string;
  expected_revision?: number;
  note?: string;
};

async function call<T>(
  baseUrl: string,
  baseHeaders: Record<string, string>,
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

  const form = body instanceof FormData;
  const headers: Record<string, string> = {
    ...baseHeaders,
    ...(form ? {} : { "Content-Type": "application/json" }),
  };

  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
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
  const baseUrl = options?.baseUrl ?? resolveApiBase(config);
  const secret = options?.secret ?? config.api.secret;
  const headers = {
    ...identityHeaders(options),
    ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
  };
  const c = <T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ) => call<T>(baseUrl, headers, method, `/api${path}`, body, query);
  const e = encodeURIComponent;

  return {
    handoffs: {
      create: (input: SessionHandoffInput) =>
        c<SessionHandoffUpload>("POST", "/session-handoffs", input),
      get: (id: string) => c<SessionHandoff>("GET", `/session-handoffs/${encodeURIComponent(id)}`),
      prepare: (id: string) =>
        c<SessionHandoff>("POST", `/session-handoffs/${encodeURIComponent(id)}/prepare`),
    },
    push: {
      config: () => c<PushConfig>("GET", "/push/config"),
      devices: () => c<PushDevice[]>("GET", "/push/subscriptions"),
      subscribe: (input: PushSubscriptionInput) =>
        c<PushDevice>("POST", "/push/subscriptions", input),
      updateTopics: (id: string, topics: PushTopic[]) =>
        c<PushDevice>("PATCH", `/push/subscriptions/${e(id)}`, { topics }),
      remove: (id: string) => c<void>("DELETE", `/push/subscriptions/${e(id)}`),
      test: (id: string) =>
        c<{ sent: number; failed: number; expired: number }>(
          "POST",
          `/push/subscriptions/${e(id)}/test`,
        ),
    },
    channels: {
      list: (project_id?: string) =>
        c<ChannelView[]>("GET", "/channels", undefined, { project_id }),
      providers: () => c<ChannelProviderInfo[]>("GET", "/channels/providers"),
      save: (input: ChannelConnection) =>
        c<ChannelView>("PUT", `/channels/${encodeURIComponent(input.id)}`, input),
      verify: (id: string) =>
        c<{ id: string; name: string }>("POST", `/channels/${encodeURIComponent(id)}/verify`),
      targets: (id: string, project_id?: string) =>
        c<ChannelView["targets"]>("GET", `/channels/${encodeURIComponent(id)}/targets`, undefined, {
          project_id,
        }),
      send: (input: ChannelSend) =>
        c<ChannelReceipt & { warnings: string[] }>("POST", "/channels/messages", input),
      message: (id: string, project_id?: string) =>
        c<ChannelReceipt>("GET", `/channels/messages/${encodeURIComponent(id)}`, undefined, {
          project_id,
        }),
      updateMessage: (
        id: string,
        input: Pick<ChannelSend, "message" | "overrides" | "project_id" | "thread_id">,
      ) => c<ChannelReceipt>("PATCH", `/channels/messages/${encodeURIComponent(id)}`, input),
      pair: (id: string) =>
        c<{ id: string; url: string; message: string; expires_at: number }>(
          "POST",
          `/channels/${encodeURIComponent(id)}/pairings`,
        ),
      pairing: (id: string) =>
        c<ChannelPairingView>("GET", `/channels/pairings/${encodeURIComponent(id)}`),
      confirmPairing: (id: string) =>
        c<unknown>("POST", `/channels/pairings/${encodeURIComponent(id)}/confirm`),
    },
    humanRequests: {
      list: () => c<HumanRequest[]>("GET", "/human-requests"),
      create: (input: HumanRequestInput) => c<HumanRequest>("POST", "/human-requests", input),
      get: (id: string) => c<HumanRequest>("GET", `/human-requests/${e(id)}`),
      respond: (id: string, version: number, response: HumanResponse) =>
        c<HumanRequest>("POST", `/human-requests/${e(id)}/respond`, { version, response }),
      acknowledge: (id: string, version: number) =>
        c<HumanRequest>("POST", `/human-requests/${e(id)}/acknowledge`, { version }),
      cancel: (id: string, version: number) =>
        c<HumanRequest>("POST", `/human-requests/${e(id)}/cancel`, { version }),
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

    scratchpads: {
      list: (params?: {
        kind?: ScratchpadKind | undefined;
        project_id?: string | undefined;
        unassigned?: boolean | undefined;
        session_id?: string | undefined;
        tag?: string | undefined;
        q?: string | undefined;
        limit?: number | undefined;
      }) =>
        c<{ scratchpads: ScratchpadListItem[]; total: number }>(
          "GET",
          "/scratchpads",
          undefined,
          params as Record<string, string | number | boolean | undefined>,
        ),

      get: (id: string) => c<Scratchpad>("GET", `/scratchpads/${encodeURIComponent(id)}`),

      create: (input: ScratchpadCreate) => c<Scratchpad>("POST", "/scratchpads", input),

      update: (id: string, input: ScratchpadUpdate) =>
        c<Scratchpad>("PATCH", `/scratchpads/${encodeURIComponent(id)}`, input),

      delete: (id: string) => c<null>("DELETE", `/scratchpads/${encodeURIComponent(id)}`),

      contentUrl: (
        id: string,
        input: { mode: "download" | "upload"; author?: string; if_revision?: number },
      ) =>
        c<ScratchpadContentUrl>(
          "POST",
          `/scratchpads/${encodeURIComponent(id)}/content-url`,
          input,
        ),
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
      projects: (name: string) =>
        c<{ project_ids: string[] }>("GET", `/skills/${e(name)}/projects`),
      setProjects: (name: string, project_ids: string[]) =>
        c<{ project_ids: string[] }>("PUT", `/skills/${e(name)}/projects`, { project_ids }),
      download: (name: string, ref: string, scope: ScopeQuery = {}) =>
        c<SkillDownload>("POST", `/skills/${e(name)}/download`, { ref, ...scope }),
      visibility: () => c<SkillVisibility>("GET", "/skills/settings/visibility"),
      setVisibility: (policy: Partial<SkillVisibility> | string[]) =>
        c<SkillVisibility>(
          "PUT",
          "/skills/settings/visibility",
          Array.isArray(policy) ? { hidden_builtins: policy } : policy,
        ),
      updateInstructions: (name: string, input: Omit<SkillUpdate, "skill_name">) =>
        c<SkillFull>("PUT", `/skills/${encodeURIComponent(name)}/instructions`, input),
      history: (name: string, scope: ScopeQuery = {}) =>
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
        limit?: number;
        offset?: number;
        sort?: "reads" | "recent";
      }) =>
        c<{
          skills: SkillMeta[];
          total: number;
          limit: number;
          offset: number;
          next_offset: number | null;
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
      delete: (name: string, expectedRevision: string) =>
        c<null>("DELETE", `/agent-packages/${encodeURIComponent(name)}`, { expectedRevision }),
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
      archiveSync: (projects?: string[]) =>
        c<{
          sync_url: string;
          expires_at: string;
          projects: { id: string; name: string; git_remote_url: string | null }[];
        }>("POST", "/sessions/archive/sync", { projects }),
      archiveSearch: (params: {
        q?: string;
        project_id?: string;
        project_ids?: string;
        offset?: number;
        limit?: number;
        agent?: string;
      }) => c<ArchiveSearchResult>("GET", "/sessions/archive", undefined, params),
      archiveUpload: (input: ArchiveUploadInput) =>
        c<{ session: ArchiveSession; outcome: string }>("POST", "/sessions/archive/upload", input),
      archiveIndex: (project_id?: string) =>
        c<{ indexed: number; failed: number; skipped: number }>("POST", "/sessions/archive/index", {
          project_id,
        }),
      archiveRead: (id: string, params?: { revision?: number; offset?: number; limit?: number }) =>
        c<TranscriptPage>("GET", `/sessions/archive/${e(id)}/transcript`, undefined, params),
      archivePassage: (id: string, revision: number, ordinal: number) =>
        c<{ citation: string; text: string; turn: number }>(
          "GET",
          `/sessions/archive/${e(id)}/passage`,
          undefined,
          { revision, ordinal },
        ),
      archiveResume: (
        id: string,
        input: {
          revision?: number;
          repository?: string;
          branch?: string;
          commit?: string;
          subdirectory?: string;
        },
      ) => c<SessionHandoff>("POST", `/sessions/archive/${e(id)}/resume`, input),
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
    system: {
      restart: () => c<RestartResponse>("POST", "/system/restart", {}),
    },

    gateway: {
      status: () => c<{ running: boolean; status: string }>("GET", "/gateway/status"),

      send: (input: { platform: string; chat_id: string; text: string; thread_id?: string }) =>
        c<null>("POST", "/gateway/send", input),
    },

    audit: {
      list: (scope: ScopeQuery = {}) =>
        c<{ entries: AuditEntry[] }>("GET", "/audit", undefined, scope),
    },

    kb: {
      list: (opts: { scope?: KbScope; project_id?: string } = {}) =>
        c<{ knowledge_bases: KnowledgeBase[] }>("GET", "/kb/bases", undefined, opts),
      get: (id: string) => c<KnowledgeBase>("GET", `/kb/bases/${e(id)}`),
      create: (input: KbCreate) => c<KnowledgeBase>("POST", "/kb/bases", input),
      update: (id: string, input: KbUpdate) =>
        c<KnowledgeBase>("PATCH", `/kb/bases/${e(id)}`, input),
      /** Agents pass confirm (the KB's exact name); people in the web UI and CLI need not. */
      remove: (id: string, confirm?: string) =>
        c<null>("DELETE", `/kb/bases/${e(id)}`, undefined, { confirm }),
      usage: (id: string) => c<KbUsageStats>("GET", `/kb/bases/${e(id)}/usage`),
      maintenance: (id: string) => c<KbMaintenanceQueue>("GET", `/kb/bases/${e(id)}/maintenance`),

      documents: (kbId: string, filter: { folder?: string; label?: string } = {}) =>
        c<KbDocumentListing>("GET", `/kb/bases/${e(kbId)}/documents`, undefined, filter),
      createDocument: (kbId: string, input: KbDocumentCreate) =>
        c<KbDocument>("POST", `/kb/bases/${e(kbId)}/documents`, input),
      upload: (kbId: string, input: KbUploadInput) => {
        const form = new FormData();
        form.set("file", input.file, input.name);
        const fields: Record<string, string | undefined> = {
          title: input.title,
          path: input.path,
          labels: input.labels?.join(","),
          description: input.description,
          document_id: input.document_id,
          expected_revision: input.expected_revision?.toString(),
          note: input.note,
        };
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.set(k, v);
        return c<KbDocument>("POST", `/kb/bases/${e(kbId)}/upload`, form);
      },
      document: (id: string, opts: { heading?: string; ordinal?: number; record?: boolean } = {}) =>
        c<KbDocumentWithContent>("GET", `/kb/documents/${e(id)}`, undefined, {
          heading: opts.heading,
          ordinal: opts.ordinal,
          record: opts.record === false ? "false" : undefined,
        }),
      updateDocument: (id: string, input: KbDocumentUpdate) =>
        c<KbDocument>("PATCH", `/kb/documents/${e(id)}`, input),
      removeDocument: (id: string) => c<null>("DELETE", `/kb/documents/${e(id)}`),
      editDocument: (id: string, input: KbDocumentEdit) =>
        c<KbDocumentEditResult>("POST", `/kb/documents/${e(id)}/edit`, input),
      lines: (id: string, start?: number, end?: number) =>
        c<KbDocument & { text: string; start_line: number; end_line: number; total_lines: number }>(
          "GET",
          `/kb/documents/${e(id)}/lines`,
          undefined,
          { start, end },
        ),
      restoreRevision: (
        id: string,
        input: { revision: number; expected_revision: number; note?: string },
      ) => c<KbDocument>("POST", `/kb/documents/${e(id)}/restore`, input),
      revisions: (id: string) =>
        c<{ revisions: KbRevision[] }>("GET", `/kb/documents/${e(id)}/revisions`),
      revision: (id: string, revision: number) =>
        c<KbRevision & { content: string | null }>(
          "GET",
          `/kb/documents/${e(id)}/revisions/${revision}`,
        ),
      /** URL of the original upload; fetch it with the Authorization header. */
      originalUrl: (id: string, revision?: number) =>
        `${baseUrl}/api/kb/documents/${e(id)}/original${revision ? `?revision=${revision}` : ""}`,
      reparse: (id: string) => c<KbDocument>("POST", `/kb/documents/${e(id)}/reparse`),
      documentUsage: (id: string) => c<KbUsageStats>("GET", `/kb/documents/${e(id)}/usage`),
      citation: (handle: string) => c<KbDocumentWithContent>("GET", `/kb/citations/${e(handle)}`),

      comments: (
        kbId: string,
        filter: { document_id?: string; status?: KbCommentStatus; limit?: number } = {},
      ) => c<{ comments: KbComment[] }>("GET", `/kb/bases/${e(kbId)}/comments`, undefined, filter),
      addComment: (kbId: string, input: KbCommentCreate) =>
        c<KbComment>("POST", `/kb/bases/${e(kbId)}/comments`, input),
      closeComment: (id: string, input: KbCommentClose) =>
        c<KbComment>("POST", `/kb/comments/${e(id)}/close`, input),
      reopenComment: (id: string) => c<KbComment>("POST", `/kb/comments/${e(id)}/reopen`),

      digestTemplate: () => c<{ instructions: string }>("GET", "/kb/digest-template"),
      digest: (kbId: string) =>
        c<{ digest: KbDigest | null }>("GET", `/kb/bases/${e(kbId)}/digest`),
      setDigest: (kbId: string, input: KbDigestSet) =>
        c<KbDigest>("PUT", `/kb/bases/${e(kbId)}/digest`, input),
      removeDigest: (kbId: string, confirm?: string) =>
        c<null>("DELETE", `/kb/bases/${e(kbId)}/digest`, undefined, { confirm }),
      runDigest: (kbId: string) => c<{ run_id: string }>("POST", `/kb/bases/${e(kbId)}/digest/run`),
      digestRuns: (kbId: string, limit?: number) =>
        c<{ runs: KbDigestRun[] }>("GET", `/kb/bases/${e(kbId)}/digest/runs`, undefined, { limit }),

      search: (req: KbSearchRequest) => c<KbSearchResult>("POST", "/kb/search", req),
      evidence: (req: KbEvidenceRequest) => c<KbEvidencePack>("POST", "/kb/evidence", req),

      sources: (kbId: string) =>
        c<{ sources: (KbSource & { document_count: number })[] }>(
          "GET",
          `/kb/bases/${e(kbId)}/sources`,
        ),
      addSource: (kbId: string, input: { root_path: string; pattern?: string }) =>
        c<{ source: KbSource; scan: KbSourceScan }>("POST", `/kb/bases/${e(kbId)}/sources`, input),
      scanSource: (id: string) => c<KbSourceScan>("POST", `/kb/sources/${e(id)}/scan`),
      removeSource: (id: string) => c<null>("DELETE", `/kb/sources/${e(id)}`),

      status: () => c<KbStatus>("GET", "/kb/status"),
      settings: () => c<KbSettings>("GET", "/kb/settings"),
      updateSettings: (patch: KbSettingsPatch) => c<KbSettings>("PATCH", "/kb/settings", patch),
      parsers: () => c<{ parsers: KbParserInfo[]; docling: KbDoclingState }>("GET", "/kb/parsers"),
      installDocling: () => c<KbDoclingState>("POST", "/kb/parsers/docling/install"),
      uninstallDocling: () => c<null>("DELETE", "/kb/parsers/docling"),
    },
  };
}

export type OrcClient = ReturnType<typeof createOrcClient>;
