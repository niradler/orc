import { nativeChatAgent } from "@orc/core/chat";
import { projectForFolder } from "@orc/core/project-path";
import type { ArchiveSession } from "@orc/core/session-archive";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { useChat } from "@/hooks/useChat";
import { useHumanRequests } from "@/hooks/useHumanRequests";
import { useProjects } from "@/hooks/useProjects";
import { type SessionHomeNav, useSessionHome } from "@/hooks/useSessionHome";
import { useSessionSeen } from "@/hooks/useSessionSeen";
import { useSessionSearch } from "@/hooks/useSessions";
import { useSsh } from "@/hooks/useSsh";
import { useStableOrder } from "@/hooks/useStableOrder";
import { type AgentState, moreUrgent } from "@/lib/agent-state";
import {
  type ChatHistoryEntry,
  chatHistoryList,
  entryAgent,
  entryCwd,
  folderLabel,
  folderProjectName,
  historyEntryState,
  withDescendants,
} from "@/lib/chat-history-list";
import { resolveAgentId } from "@/lib/composer-chips";
import {
  filterCounts,
  matchesFilter,
  onSessionFilterChange,
  parseFilter,
  SESSION_FILTER_KEY,
  type SessionFilter,
} from "@/lib/session-filter";
import { sessionHomeSearch } from "@/lib/session-home";
import { markSeen } from "@/lib/session-seen";
import { pendingRequestsForSession } from "@/lib/snooze";
import { terminalPath } from "@/lib/terminal-links";
import { useTerminals } from "@/lib/terminals";

const FILTER_KEY = SESSION_FILTER_KEY;
const SORT_KEY = "orc_chat_history_sort";
const DEEP_KEY = "orc_chat_history_deep";
const AGENT_KEY = "orc_chat_history_agent";
const HIDDEN_KEY = "orc_chat_history_hidden";
// v2: per-project grouping became the default; the old key only records the
// previous default, so it must not override the new one.
const SECTION_KEY = "orc_chat_history_section_v2";
export const UNASSIGNED_SECTION = "__unassigned__";

export const folderSection = (cwd: string | null) => `${UNASSIGNED_SECTION}:${cwd ?? ""}`;

type FolderGroupData = {
  key: string;
  cwd: string | null;
  label: string;
  rows: ChatHistoryEntry[];
  latest: number;
};

export type SessionSection = "projects" | "recents";
export type SessionSort = "active-desc" | "active-asc" | "agent";
export const SESSION_SORTS: readonly SessionSort[] = ["active-desc", "active-asc", "agent"];
export const SESSION_SORT_LABELS: Record<SessionSort, string> = {
  "active-desc": "Last active: newest",
  "active-asc": "Last active: oldest",
  agent: "Agent",
};

function storedFilter(): SessionFilter {
  try {
    return parseFilter(localStorage.getItem(FILTER_KEY));
  } catch {
    return "all";
  }
}

function storedSort(): SessionSort {
  try {
    const value = localStorage.getItem(SORT_KEY);
    return value === "active-asc" || value === "agent" ? value : "active-desc";
  } catch {
    return "active-desc";
  }
}

function storedFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function storedAgent(): string {
  try {
    return localStorage.getItem(AGENT_KEY) ?? "";
  } catch {
    return "";
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
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
  const location = useLocation();
  const { terminals } = useTerminals();
  const projectScope = chat.projectScope;
  const navigation = useSessionHome();
  const [localOpen, setLocalOpen] = useState(false);
  const setOpen = (next: boolean) => (home ? home.go({ listOpen: next }) : setLocalOpen(next));
  const open = enabled && (forceOpen || docked || rail || (home ? home.listOpen : localOpen));
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(50);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // All statuses: sessions can belong to archived/paused projects and must stay reachable.
  const projectsQuery = useProjects();
  const { data: projects, isLoading: projectsLoading, error: projectsError } = projectsQuery;
  const { data: ssh } = useSsh();
  const [section, setSection] = useState<SessionSection>(storedSection);
  const [expandedProjects, setExpandedProjects] = useState<string[]>([]);
  const [adoptFolder, setAdoptFolder] = useState<{ cwd: string; name: string } | null>(null);
  const [deep, setDeepState] = useState(() => storedFlag(DEEP_KEY));
  const [agentFilter, setAgentFilterState] = useState(storedAgent);
  const [sort, setSortState] = useState<SessionSort>(storedSort);
  const [includeHidden, setIncludeHiddenState] = useState(() => storedFlag(HIDDEN_KEY));
  const chooseSection = (next: SessionSection) => {
    setSection(next);
    try {
      localStorage.setItem(SECTION_KEY, next);
    } catch {}
  };
  const setDeep = (next: boolean) => {
    setDeepState(next);
    setVisibleCount(50);
    store(DEEP_KEY, next ? "1" : "0");
  };
  const setAgentFilter = (next: string) => {
    setAgentFilterState(next);
    setVisibleCount(50);
    store(AGENT_KEY, next);
  };
  const setSort = (next: SessionSort) => {
    setSortState(next);
    setVisibleCount(50);
    store(SORT_KEY, next);
  };
  const setIncludeHidden = (next: boolean) => {
    setIncludeHiddenState(next);
    setVisibleCount(50);
    store(HIDDEN_KEY, next ? "1" : "0");
  };

  const [selectedArchive, setSelectedArchive] = useState<ArchiveSession | null>(null);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [commit, setCommit] = useState("");
  const [subdirectory, setSubdirectory] = useState("");
  const threads = useQuery({
    queryKey: ["chat-threads", open, includeHidden],
    queryFn: () => api.chat.list(includeHidden),
    enabled: open,
    staleTime: 0,
  });
  const live = useQuery({
    queryKey: ["chat-resume-sessions", open, projectScope, includeHidden],
    queryFn: () =>
      api.sessions.live({
        active: false,
        include_children: true,
        limit: 5000,
        ...(includeHidden ? { include_hidden: true } : {}),
        ...(projectScope === "all" ? {} : { project_id: projectScope }),
      }),
    enabled: open,
    staleTime: 0,
  });
  // Transcript and archive search read the whole store on the server, so wait
  // for a pause in typing instead of searching on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const deepSearching = deep && search.trim().length >= 2;
  // Content search across transcripts (ripgrep) so a phrase inside a conversation finds its row.
  const contentSearch = useSessionSearch(
    deepSearching ? debouncedSearch : "",
    "",
    projectScope === "all" ? undefined : projectScope,
    includeHidden,
  );
  const archive = useQuery({
    queryKey: ["chat-resume-archive", debouncedSearch, projectScope, deep],
    queryFn: () =>
      api.sessions.archive({
        q: debouncedSearch,
        mode: deep ? "auto" : "lexical",
        limit: 30,
        ...(projectScope === "all" ? {} : { project_id: projectScope }),
      }),
    enabled: open,
    placeholderData: keepPreviousData,
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
        contentSearch.refetch(),
        projectsQuery.refetch(),
      ]);
    } finally {
      setRefreshingSessions(false);
    }
  };
  async function select(
    load: () => ReturnType<typeof api.chat.get>,
    projectId?: string | null,
    opened?: ChatHistoryEntry,
  ) {
    setPending(true);
    setError("");
    try {
      chat.openThread(await load(), { projectId });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Session could not be opened.");
    } finally {
      if (opened) markSeen(opened.seenKeys, Math.max(Date.now(), opened.updatedAt));
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
  // A palette command can set the filter while this list is already mounted.
  useEffect(
    () =>
      onSessionFilterChange((next) => {
        setFilterState(next);
        setVisibleCount(50);
      }),
    [],
  );
  // Folder matching stays limited to active projects; grouping resolves names for all statuses.
  const activeProjects = (projects ?? []).filter((project) => project.status === "active");
  const entries = chatHistoryList(
    chat.tabs,
    threads.data?.threads ?? [],
    deepSearching ? (contentSearch.data?.hits ?? []) : (live.data?.sessions ?? []),
    archive.data?.sessions ?? [],
    search,
    projectScope,
    terminals,
    activeProjects,
  );
  /** Display and filter by the coding agent, so Cursor CLI and Cursor IDE are one choice. */
  const agentOf = (entry: ChatHistoryEntry): string => {
    const raw = entryAgent(entry);
    return resolveAgentId(raw) ?? raw;
  };
  const agentOptions = [...new Set(entries.map(agentOf).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  const scopedEntries = agentFilter
    ? entries.filter((entry) => agentOf(entry) === agentFilter)
    : entries;
  const orderedEntries = [...scopedEntries].sort((a, b) => {
    if (sort === "agent")
      return (
        agentOf(a).localeCompare(agentOf(b)) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id)
      );
    const compared = a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
    return sort === "active-asc" ? compared : -compared;
  });
  /** The draft or saved thread the conversation pane is showing. */
  const activeTab = chat.tabs.find((tab) => tab.key === chat.activeKey);
  const selectedChatId = activeTab?.thread
    ? `chat:${activeTab.thread.id}`
    : activeTab
      ? `draft:${activeTab.key}`
      : null;
  const isSelected = (entry: ChatHistoryEntry) => {
    // The URL names whatever the chat page renders: a terminal, the read-only
    // viewer, or the open conversation.
    if (home?.terminalId) return entry.terminalId === home.terminalId;
    if (home?.viewId) return entry.seenKeys.includes(`native:${home.viewId}`);
    return entry.id === selectedChatId;
  };
  const humanRequests = useHumanRequests();
  const hasPendingRequest = (entry: ChatHistoryEntry) => {
    if (!humanRequests.data?.length) return false;
    if (entry.kind === "local" && entry.tab.thread)
      return (
        pendingRequestsForSession(humanRequests.data, {
          threadId: entry.tab.thread.id,
          sourceId: entry.tab.thread.sourceId,
          runtimeId: entry.tab.thread.runtimeId,
          backend: entry.tab.thread.backend,
          host: entry.tab.thread.host,
        }).length > 0
      );
    if (entry.kind === "saved")
      return (
        pendingRequestsForSession(humanRequests.data, {
          threadId: entry.thread.id,
          sourceId: entry.thread.sourceId,
          backend: entry.thread.agent || entry.provider,
        }).length > 0
      );
    if (entry.kind === "native")
      return (
        pendingRequestsForSession(humanRequests.data, {
          sourceId: entry.session.id,
          runtimeId: entry.session.session_id,
          backend: entry.session.agent,
          host: entry.session.host,
        }).length > 0
      );
    return false;
  };
  const states = new Map(
    scopedEntries.flatMap(withDescendants).map((entry) => {
      const base = historyEntryState(entry, seen, isSelected(entry));
      return [entry.id, hasPendingRequest(entry) ? moreUrgent(base, "needs-you") : base] as const;
    }),
  );
  const listed = orderedEntries.filter(
    (entry) =>
      matchesFilter(states.get(entry.id) ?? "idle", filter) ||
      withDescendants(entry).some(isSelected),
  );
  const byId = new Map(
    listed.flatMap((entry) => {
      const source =
        entry.kind === "local"
          ? entry.tab.thread?.sourceId
          : entry.kind === "saved"
            ? entry.thread.sourceId
            : null;
      return [
        ...(source ? [[`native:${source}`, entry] as const] : []),
        [entry.id, entry] as const,
      ];
    }),
  );
  const counts = filterCounts(scopedEntries.map((entry) => states.get(entry.id) ?? "idle"));
  const loading =
    threads.isLoading ||
    live.isLoading ||
    archive.isLoading ||
    projectsLoading ||
    (deepSearching && contentSearch.isLoading);
  const stable = useStableOrder({
    items: listed,
    id: (entry) => entry.id,
    version: (entry) => String(entry.updatedAt),
    lookup: (id) => byId.get(id),
    resetKey: `${filter}\n${search}\n${projectScope}\n${sort}\n${agentFilter}\n${deep}\n${includeHidden}`,
    loading,
  });
  const shown = stable.items.slice(0, visibleCount);
  const agentGroups: { agent: string; rows: ChatHistoryEntry[] }[] = [];
  if (sort === "agent") {
    for (const entry of shown) {
      const agent = agentOf(entry);
      const group = agentGroups[agentGroups.length - 1];
      if (group?.agent === agent) group.rows.push(entry);
      else agentGroups.push({ agent, rows: [entry] });
    }
  }
  // Projects float up by their newest session; empty projects stay alphabetical at the end.
  // Groups follow the active project scope and cover every assigned row, including sessions
  // whose project is archived/paused or no longer listed, so none silently disappear.
  const projectById = new Map((projects ?? []).map((project) => [project.id, project]));
  const assigned = (entry: ChatHistoryEntry) =>
    !!entry.projectId && (!projects || projectById.has(entry.projectId));
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
    if (!entry.projectId || !assigned(entry)) continue;
    const group = groupFor(entry.projectId);
    group.rows.push(entry);
    group.latest = Math.max(group.latest, entry.updatedAt);
  }
  const projectGroups = [...groups.values()].sort(
    (a, b) => b.latest - a.latest || a.project.name.localeCompare(b.project.name),
  );
  const unassignedRows = stable.items.filter((entry) => !assigned(entry));
  const folderGroups = new Map<string, FolderGroupData>();
  for (const entry of unassignedRows) {
    const cwd = entryCwd(entry);
    const key = folderSection(cwd);
    let group = folderGroups.get(key);
    if (!group) {
      group = { key, cwd, label: "", rows: [], latest: 0 };
      folderGroups.set(key, group);
    }
    group.rows.push(entry);
    group.latest = Math.max(group.latest, entry.updatedAt);
  }
  const unassignedFolders = [...folderGroups.values()].sort(
    (a, b) => Number(!a.cwd) - Number(!b.cwd) || b.latest - a.latest,
  );
  for (const group of unassignedFolders)
    group.label = folderLabel(
      group.cwd,
      unassignedFolders.map((other) => other.cwd),
      projectGroups.map((other) => other.project.name),
    );
  const expandedGroups = expandedProjects.map((id) =>
    id.startsWith(UNASSIGNED_SECTION)
      ? (folderGroups.get(id)?.rows ?? [])
      : (projectGroups.find((group) => group.project.id === id)?.rows ?? []),
  );
  // Opening the list must land on the project of the session already on screen,
  // even though every group is collapsed by default.
  const activeRow = entries.find((entry) => withDescendants(entry).some(isSelected));
  const activeAssigned = !!activeRow && assigned(activeRow);
  const autoExpanded = useRef("");
  useEffect(() => {
    if (!open) {
      autoExpanded.current = "";
      return;
    }
    if (section !== "projects" || !activeRow) return;
    const group = activeAssigned
      ? (activeRow.projectId as string)
      : folderSection(entryCwd(activeRow));
    const listed = activeAssigned
      ? projectGroups.some((candidate) => candidate.project.id === group)
      : unassignedRows.includes(activeRow);
    if (!listed) return;
    const signature = `${activeRow.id}:${group}`;
    if (autoExpanded.current === signature) return;
    autoExpanded.current = signature;
    setExpandedProjects((ids) => (ids.includes(group) ? ids : [...ids, group]));
  }, [open, section, activeRow, activeAssigned, projectGroups, unassignedRows]);
  const active = entries
    .flatMap(withDescendants)
    .find((entry) => entry.kind === "local" && entry.tab.key === chat.activeKey);
  const activeKeys = active?.seenKeys.join("\n") ?? "";
  const activeUpdated = active?.updatedAt ?? 0;
  useEffect(() => {
    if (!activeKeys) return;
    const keys = activeKeys.split("\n");
    markSeen(keys, Math.max(Date.now(), activeUpdated));
    return () => markSeen(keys);
  }, [activeKeys, activeUpdated]);
  const selectEntry = (entry: ChatHistoryEntry) => {
    const terminalId = home || entry.kind === "terminal" ? entry.terminalId : undefined;
    if (
      terminalId ||
      !(entry.kind === "saved" || (entry.kind === "native" && nativeChatAgent(entry.session.agent)))
    )
      markSeen(entry.seenKeys, Math.max(Date.now(), entry.updatedAt));
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
      } else void select(() => api.chat.get(entry.thread.id), entry.projectId, entry);
    } else if (entry.kind === "native") {
      if (!nativeChatAgent(entry.session.agent)) {
        if (!home) {
          navigate(`/chat${sessionHomeSearch(location.search, { viewId: entry.session.id })}`);
          return;
        }
        navigation.go({
          viewId: entry.session.id,
          terminalId: null,
          liveId: null,
          listOpen: false,
        });
        return;
      }
      home?.go({ terminalId: null });
      void select(() => api.chat.resume(entry.session.id), entry.projectId, entry);
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
  const projectFromFolder = (cwd: string) => {
    // Reuse a project that already owns this folder instead of creating a duplicate.
    const existing = projectForFolder(cwd, projects ?? []);
    if (existing) {
      setExpandedProjects((ids) => (ids.includes(existing.id) ? ids : [...ids, existing.id]));
      setError("");
      return;
    }
    // Otherwise open the new-project dialog prefilled with the folder, so creating
    // a project is an explicit, editable step rather than a silent duplicate.
    setAdoptFolder({
      cwd,
      name: folderProjectName(
        cwd,
        (projects ?? []).map((project) => project.name),
      ),
    });
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
    (deepSearching ? contentSearch.error?.message : undefined) ||
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
    hasMore:
      section === "projects"
        ? expandedGroups.some((rows) => rows.length > visibleCount)
        : stable.items.length > visibleCount,
    pending,
    error,
    setError,
    listError,
    deep,
    setDeep,
    deepSearching,
    searchMeta: deepSearching
      ? { rg: contentSearch.data?.rg ?? false, ms: contentSearch.data?.ms ?? 0 }
      : null,
    agentFilter,
    setAgentFilter,
    agentOptions,
    sort,
    setSort,
    includeHidden,
    setIncludeHidden,
    agentGroups,
    section,
    chooseSection,
    expandedProjects,
    toggleProject: (id: string) => {
      setExpandedProjects((ids) =>
        ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id],
      );
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
    unassignedFolders,
    projectFromFolder,
    adoptFolder,
    closeAdopt: () => setAdoptFolder(null),
    expandProject: (id: string) =>
      setExpandedProjects((ids) => (ids.includes(id) ? ids : [...ids, id])),
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
