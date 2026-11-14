import type { ArchiveSession } from "@orc/core/session-archive";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { useChat } from "@/hooks/useChat";
import { useProjects } from "@/hooks/useProjects";
import { type SessionHomeNav, useSessionHome } from "@/hooks/useSessionHome";
import { useSessionSeen } from "@/hooks/useSessionSeen";
import { useSsh } from "@/hooks/useSsh";
import { useStableOrder } from "@/hooks/useStableOrder";
import type { AgentState } from "@/lib/agent-state";
import { type ChatHistoryEntry, chatHistoryList, historyEntryState } from "@/lib/chat-history-list";
import { useSelectedProject } from "@/lib/selected-project";
import { filterCounts, matchesFilter, parseFilter, type SessionFilter } from "@/lib/session-filter";
import { markSeen } from "@/lib/session-seen";
import { terminalPath } from "@/lib/terminal-links";
import { useTerminals } from "@/lib/terminals";

const FILTER_KEY = "orc_chat_history_filter";
// v2: per-project grouping became the default; the old key only records the
// previous default, so it must not override the new one.
const SECTION_KEY = "orc_chat_history_section_v2";
export const UNASSIGNED_SECTION = "__unassigned__";

export type SessionSection = "projects" | "recents";

function storedFilter(): SessionFilter {
  try {
    return parseFilter(localStorage.getItem(FILTER_KEY));
  } catch {
    return "all";
  }
}

function storedSection(): SessionSection {
  try {
    return localStorage.getItem(SECTION_KEY) === "recents" ? "recents" : "projects";
  } catch {
    return "projects";
  }
}

export interface ProjectGroupData {
  project: { id: string; name: string; scope?: string | null };
  rows: ChatHistoryEntry[];
  latest: number;
}

/** Shared session-history model: the desktop picker and the phone Sessions page
 *  render the same queries, filters, ordering and selection behavior. */
export function useSessionHistory({
  enabled = true,
  docked = false,
  rail = false,
  forceOpen = false,
  home,
}: {
  enabled?: boolean;
  docked?: boolean;
  rail?: boolean;
  /** Mounted surfaces (the phone page) fetch even before the URL settles. */
  forceOpen?: boolean;
  home?: SessionHomeNav;
}) {
  const chat = useChat();
  const navigate = useNavigate();
  const { terminals } = useTerminals();
  const projectScope = chat.projectScope;
  const selectedProject = useSelectedProject();
  const navigation = useSessionHome();
  const setOpen = (next: boolean) => navigation.go({ listOpen: next });
  const open = enabled && (forceOpen || docked || rail || navigation.listOpen);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // All statuses: sessions can belong to archived/paused projects and must stay reachable.
  const projectsQuery = useProjects();
  const { data: projects, isLoading: projectsLoading, error: projectsError } = projectsQuery;
  const { data: ssh } = useSsh();
  const [section, setSection] = useState<SessionSection>(storedSection);
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const chooseSection = (next: SessionSection) => {
    setSection(next);
    try {
      localStorage.setItem(SECTION_KEY, next);
    } catch {}
  };

  const [selectedArchive, setSelectedArchive] = useState<ArchiveSession | null>(null);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const threads = useQuery({
    queryKey: ["chat-threads", open],
    queryFn: api.chat.list,
    enabled: open,
    staleTime: 0,
  });
  const live = useQuery({
    queryKey: ["chat-resume-sessions", open, projectScope],
    queryFn: () =>
      api.sessions.live({
        active: false,
        limit: 5000,
        ...(projectScope === "all" ? {} : { project_id: projectScope }),
      }),
    enabled: open,
    staleTime: 0,
  });
  const archive = useQuery({
    queryKey: ["chat-resume-archive", search, projectScope],
    queryFn: () =>
      api.sessions.archive({
        q: search,
        limit: 30,
        ...(projectScope === "all" ? {} : { project_id: projectScope }),
      }),
    enabled: open,
  });
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const refreshSessions = async () => {
    setRefreshingSessions(true);
    setRefreshError("");
    try {
      // Ask the server to re-import native sessions first; watching covers most
      // agents, but a forced sync also catches external stores immediately.
      try {
        await api.sessions.sync();
      } catch (cause) {
        // Keep refreshing the lists even when the forced sync fails; a silent
        // no-op would look like the click did nothing.
        setRefreshError(cause instanceof Error ? cause.message : "Sessions could not be synced.");
      }
      await Promise.all([
        threads.refetch(),
        live.refetch(),
        archive.refetch(),
        projectsQuery.refetch(),
      ]);
    } finally {
      setRefreshingSessions(false);
    }
  };
  async function select(load: () => ReturnType<typeof api.chat.get>, projectId?: string | null) {
    setPending(true);
    setError("");
    try {
      chat.openThread(await load(), { projectId });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Session could not be opened.");
    } finally {
      setPending(false);
    }
  }
  const seen = useSessionSeen();
  const [filter, setFilterState] = useState<SessionFilter>(storedFilter);
  const setFilter = (next: SessionFilter) => {
    setFilterState(next);
    setVisibleCount(50);
    try {
      localStorage.setItem(FILTER_KEY, next);
    } catch {}
  };
  // Folder matching stays limited to active projects; grouping resolves names for all statuses.
  const activeProjects = (projects ?? []).filter((project) => project.status === "active");
  const entries = chatHistoryList(
    chat.tabs,
    threads.data?.threads ?? [],
    live.data?.sessions ?? [],
    archive.data?.sessions ?? [],
    search,
    projectScope,
    terminals,
    !!home,
    activeProjects,
  );
  const isSelected = (entry: ChatHistoryEntry) =>
    home?.terminalId
      ? entry.terminalId === home.terminalId
      : entry.kind === "local" && entry.tab.key === chat.activeKey;
  const states = new Map(
    entries.map((entry) => [entry.id, historyEntryState(entry, seen, isSelected(entry))]),
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const counts = filterCounts(states.values());
  const loading = threads.isLoading || live.isLoading || archive.isLoading || projectsLoading;
  const stable = useStableOrder({
    items: entries.filter((entry) => matchesFilter(states.get(entry.id) ?? "idle", filter)),
    id: (entry) => entry.id,
    version: (entry) => String(entry.updatedAt),
    lookup: (id) => byId.get(id),
    resetKey: `${filter}\n${search}\n${projectScope}`,
    loading,
  });
  const shown = stable.items.slice(0, visibleCount);
  // Projects float up by their newest session; empty projects stay alphabetical at the end.
  // Groups follow the active project scope and cover every assigned row, including sessions
  // whose project is archived/paused or no longer listed, so none silently disappear.
  const projectById = new Map((projects ?? []).map((project) => [project.id, project]));
  const groups = new Map<string, ProjectGroupData>();
  const groupFor = (projectId: string) => {
    let group = groups.get(projectId);
    if (!group) {
      group = {
        project: projectById.get(projectId) ?? {
          id: projectId,
          name: "Unknown project",
          scope: null,
        },
        rows: [],
        latest: 0,
      };
      groups.set(projectId, group);
    }
    return group;
  };
  for (const project of projects ?? []) {
    if (project.status !== "active") continue;
    if (projectScope !== "all" && project.id !== projectScope) continue;
    groupFor(project.id);
  }
  for (const entry of stable.items) {
    if (!entry.projectId) continue;
    const group = groupFor(entry.projectId);
    group.rows.push(entry);
    group.latest = Math.max(group.latest, entry.updatedAt);
  }
  const projectGroups = [...groups.values()].sort(
    (a, b) => b.latest - a.latest || a.project.name.localeCompare(b.project.name),
  );
  const unassignedRows = stable.items.filter((entry) => !entry.projectId);
  const expandedRows =
    expandedProject === UNASSIGNED_SECTION
      ? unassignedRows
      : (projectGroups.find((group) => group.project.id === expandedProject)?.rows ?? []);
  const visibleEntries = section === "projects" ? expandedRows : stable.items;
  const active = entries.find(
    (entry) => entry.kind === "local" && entry.tab.key === chat.activeKey,
  );
  const activeKeys = active?.seenKeys.join("\n") ?? "";
  const activeUpdated = active?.updatedAt ?? 0;
  const adoptProject = useCallback(
    (projectId?: string | null) => {
      if (!projectId) return;
      // Only scopes the header can show: paused and archived projects are not picker options.
      if (!activeProjects.some((project) => project.id === projectId)) return;
      if (selectedProject.projectId === "all" || selectedProject.projectId === "unassigned")
        selectedProject.setProjectId(projectId);
    },
    [activeProjects, selectedProject],
  );
  // Opening or switching to a folder-scoped session adopts its project unless the
  // header already has an explicit project selected.
  const adoptedSignature = useRef("");
  const adoptOnOpen = (projectId?: string | null) => {
    const signature = `${chat.activeKey}:${projectId ?? ""}`;
    if (adoptedSignature.current === signature) return;
    adoptedSignature.current = signature;
    adoptProject(projectId);
  };
  useEffect(() => {
    if (!activeKeys) return;
    const keys = activeKeys.split("\n");
    markSeen(keys, Math.max(Date.now(), activeUpdated));
    return () => markSeen(keys);
  }, [activeKeys, activeUpdated]);
  const selectEntry = (entry: ChatHistoryEntry) => {
    markSeen(entry.seenKeys, Math.max(Date.now(), entry.updatedAt));
    adoptOnOpen(entry.projectId);
    const terminalId = home || entry.kind === "terminal" ? entry.terminalId : undefined;
    if (terminalId) {
      setOpen(false);
      if (home) home.go({ terminalId });
      else navigate(terminalPath(terminalId));
    } else if (entry.kind === "local") {
      chat.selectTab(entry.tab.key);
      home?.go({ terminalId: null }, { chatThread: entry.tab.thread?.id });
      setOpen(false);
    } else if (entry.kind === "saved") {
      if (home) {
        home.go({ terminalId: null }, { chatThread: entry.thread.id });
        setOpen(false);
      } else void select(() => api.chat.get(entry.thread.id), entry.projectId);
    } else if (entry.kind === "native") {
      home?.go({ terminalId: null });
      void select(() => api.chat.resume(entry.session.id), entry.projectId);
    } else if (entry.kind === "archive") {
      const session = entry.session;
      setSelectedArchive(session);
      setRepository(session.metadata.repository ?? "");
      setBranch(session.metadata.branch ?? "");
      setCommit(session.metadata.commit ?? "");
      setSubdirectory(session.metadata.subdirectory ?? "");
      setError("");
    }
  };
  const newProjectSession = (project: { id: string; scope?: string | null }) => {
    adoptProject(project.id);
    chat.newTab({
      projectId: project.id,
      fresh: true,
      ...(project.scope?.trim()
        ? { workspace: { cwd: project.scope, host: ssh?.host ?? null, worktree: false } }
        : {}),
    });
    home?.go({ terminalId: null });
    setOpen(false);
  };
  const newSession = () => {
    chat.newTab();
    home?.go({ terminalId: null });
    setOpen(false);
  };
  const stateOf = (entry: ChatHistoryEntry): AgentState => states.get(entry.id) ?? "idle";
  const listError =
    error ||
    refreshError ||
    threads.error?.message ||
    live.error?.message ||
    archive.error?.message ||
    projectsError?.message ||
    "";
  return {
    chat,
    home,
    open,
    setOpen,
    search,
    setSearch: (value: string) => {
      setSearch(value);
      setVisibleCount(50);
    },
    visibleCount,
    loadMore: () => setVisibleCount((count) => count + 50),
    hasMore: visibleEntries.length > visibleCount,
    pending,
    error,
    setError,
    listError,
    section,
    chooseSection,
    expandedProject,
    setExpandedProject: (id: string | null) => {
      setVisibleCount(50);
      setExpandedProject(id);
    },
    projects,
    projectsLoading,
    threads,
    live,
    archive,
    refreshingSessions,
    refreshSessions,
    filter,
    setFilter,
    counts,
    entries,
    states,
    stateOf,
    isSelected,
    stable,
    shown,
    projectGroups,
    unassignedRows,
    expandedRows,
    visibleEntries,
    loading,
    selectEntry,
    select,
    newProjectSession,
    newSession,
    selectedArchive,
    setSelectedArchive,
    repository,
    setRepository,
    branch,
    setBranch,
    commit,
    setCommit,
    subdirectory,
    setSubdirectory,
  };
}

export type SessionHistory = ReturnType<typeof useSessionHistory>;
