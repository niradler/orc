import type { ArchiveSession } from "@orc/core/session-archive";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Folder,
  History,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { ChatAgentOptionsEditor } from "@/components/ChatAgentOptionsEditor";
import { ChatPermissionSelect } from "@/components/ChatPermissionSelect";
import { SessionStateFilters, StableOrderPill } from "@/components/SessionListControls";
import {
  SessionRowContent,
  sessionRowButtonClass,
  sessionRowClass,
} from "@/components/SessionRowContent";
import { StateBadge } from "@/components/StateBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useChat } from "@/hooks/useChat";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { useProjects } from "@/hooks/useProjects";
import { type SessionHomeNav, useSessionHome } from "@/hooks/useSessionHome";
import { useSessionSeen } from "@/hooks/useSessionSeen";
import { useSsh } from "@/hooks/useSsh";
import { useStableOrder } from "@/hooks/useStableOrder";
import { AGENT_STATES, type AgentState } from "@/lib/agent-state";
import { type ChatHistoryEntry, chatHistoryList, historyEntryState } from "@/lib/chat-history-list";
import { useDesktopPreview } from "@/lib/desktop-preview-context";
import { useSelectedProject } from "@/lib/selected-project";
import { filterCounts, matchesFilter, parseFilter, type SessionFilter } from "@/lib/session-filter";
import { markSeen } from "@/lib/session-seen";
import { terminalPath } from "@/lib/terminal-links";
import { useTerminals } from "@/lib/terminals";
import { cn } from "@/lib/utils";

const FILTER_KEY = "orc_chat_history_filter";
const SECTION_KEY = "orc_chat_history_section";
const UNASSIGNED_SECTION = "__unassigned__";

type SessionSection = "projects" | "recents";

function storedFilter(): SessionFilter {
  try {
    return parseFilter(localStorage.getItem(FILTER_KEY));
  } catch {
    return "all";
  }
}

function storedSection(): SessionSection {
  try {
    return localStorage.getItem(SECTION_KEY) === "projects" ? "projects" : "recents";
  } catch {
    return "recents";
  }
}

export function ChatSessionPicker({
  enabled = true,
  docked = false,
  rail = false,
  wide = false,
  hideTrigger = false,
  home,
}: {
  enabled?: boolean;
  docked?: boolean;
  rail?: boolean;
  wide?: boolean;
  hideTrigger?: boolean;
  home?: SessionHomeNav;
}) {
  const chat = useChat();
  const navigate = useNavigate();
  const { terminals } = useTerminals();
  const projectScope = chat.projectScope;
  const selectedProject = useSelectedProject();
  const navigation = useSessionHome();
  const setOpen = (next: boolean) => navigation.go({ listOpen: next });
  const open = enabled && (docked || rail || navigation.listOpen);
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
  const refreshSessions = async () => {
    setRefreshingSessions(true);
    try {
      // Ask the server to re-import native sessions first; watching covers most
      // agents, but a forced sync also catches external stores immediately.
      await api.sessions.sync().catch(() => undefined);
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
  const [filter, setFilter] = useState<SessionFilter>(storedFilter);
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
  const groups = new Map<
    string,
    {
      project: { id: string; name: string; scope?: string | null };
      rows: ChatHistoryEntry[];
      latest: number;
    }
  >();
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
      if (selectedProject.projectId === "all" || selectedProject.projectId === "unassigned")
        selectedProject.setProjectId(projectId);
    },
    [selectedProject],
  );
  // Opening or switching to a folder-scoped session adopts its project unless the
  // header already has an explicit project selected.
  const adoptedSignature = useRef("");
  useEffect(() => {
    const signature = `${chat.activeKey}:${chat.projectId ?? ""}:${active?.projectId ?? ""}`;
    if (adoptedSignature.current === signature) return;
    adoptedSignature.current = signature;
    adoptProject(chat.projectId ?? active?.projectId);
  }, [chat.activeKey, chat.projectId, active?.projectId, adoptProject]);
  useEffect(() => {
    if (!activeKeys) return;
    const keys = activeKeys.split("\n");
    markSeen(keys, Math.max(Date.now(), activeUpdated));
    return () => markSeen(keys);
  }, [activeKeys, activeUpdated]);
  const selectEntry = (entry: ChatHistoryEntry) => {
    markSeen(entry.seenKeys, Math.max(Date.now(), entry.updatedAt));
    adoptProject(entry.projectId);
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
  if (rail)
    return (
      <aside
        data-testid="session-rail"
        aria-label="Sessions"
        className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border py-3"
      >
        <ActionHelp label="Show session list">
          <Button
            variant="ghost"
            size="icon"
            data-testid="session-list-expand"
            aria-label="Show session list"
            onClick={() => home?.go({ listHidden: false })}
          >
            <PanelLeftOpen size={16} />
          </Button>
        </ActionHelp>
        <ActionHelp label="New session">
          <Button
            variant="ghost"
            size="icon"
            data-testid="chat-clear-button"
            aria-label="New session"
            disabled={pending}
            onClick={() => {
              chat.newTab();
              home?.go({ terminalId: null });
            }}
          >
            <SquarePen size={16} />
          </Button>
        </ActionHelp>
        <div className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          {shown.map((entry) => {
            const state = states.get(entry.id) ?? "idle";
            const agent = entryAgent(entry);
            const selected = isSelected(entry);
            return (
              <ActionHelp
                key={entry.id}
                label={entry.title}
                description={`${agent || "Unknown provider"} · ${AGENT_STATES[state].label}`}
              >
                <button
                  type="button"
                  data-testid="session-rail-item"
                  data-history-id={entry.id}
                  data-state={state}
                  aria-label={`${entry.title} · ${AGENT_STATES[state].label}`}
                  aria-current={selected ? "true" : undefined}
                  disabled={pending}
                  onClick={() => selectEntry(entry)}
                  className={`relative flex size-10 shrink-0 items-center justify-center rounded-md ${selected ? "bg-surface-highest" : "hover:bg-surface"}`}
                >
                  <ProviderMark agent={agent} />
                  <span className="absolute right-0.5 bottom-0.5">
                    <StateBadge state={state} compact context={agent || undefined} />
                  </span>
                </button>
              </ActionHelp>
            );
          })}
        </div>
      </aside>
    );
  return (
    <SessionHistoryFrame
      docked={docked}
      wide={wide}
      hideTrigger={hideTrigger}
      open={open}
      onOpenChange={setOpen}
      onCollapse={home ? () => home.go({ listHidden: true }) : undefined}
      onNew={() => home?.go({ terminalId: null })}
      newDisabled={pending}
    >
      {selectedArchive ? (
        <section className="min-w-0 space-y-3">
          <Button variant="ghost" disabled={pending} onClick={() => setSelectedArchive(null)}>
            Back to sessions
          </Button>
          <h3 className="font-medium wrap-break-word">{selectedArchive.title}</h3>
          <p className="text-sm text-muted-foreground">
            Resume from a pushed repository, branch and exact commit. ORC verifies the checkout and
            imports the native history before opening chat.
          </p>
          {(
            [
              ["repository", "Repository", repository, setRepository],
              ["branch", "Branch", branch, setBranch],
              ["commit", "Pushed commit", commit, setCommit],
              ["subdirectory", "Repository subdirectory", subdirectory, setSubdirectory],
            ] as const
          ).map(([key, title, value, change]) => (
            <label key={key} htmlFor={`chat-archive-${key}`} className="block space-y-2 text-sm">
              {title}
              <Input
                id={`chat-archive-${key}`}
                data-testid={`chat-archive-${key}`}
                value={value}
                onChange={(event) => change(event.target.value)}
                disabled={pending}
              />
            </label>
          ))}
          <Button
            data-testid="chat-archive-prepare"
            disabled={pending || !repository || !branch || !/^[a-f0-9]{40}$/i.test(commit)}
            onClick={() =>
              void select(async () => {
                const handoff = await api.sessions.archiveResume(selectedArchive.id, {
                  revision: selectedArchive.revision,
                  repository,
                  branch,
                  commit,
                  subdirectory,
                });
                if (handoff.status !== "ready" || !handoff.live_session_id)
                  throw new Error(handoff.error || "The imported session is not ready to resume.");
                return api.chat.resume(handoff.live_session_id);
              }, selectedArchive.project_id)
            }
          >
            {pending ? "Preparing…" : "Resume"}
          </Button>
        </section>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <div
              role="tablist"
              aria-label="Session navigation"
              className="flex min-w-0 flex-1 gap-1"
            >
              {(["projects", "recents"] as const).map((value) => (
                <Button
                  key={value}
                  role="tab"
                  id={`session-tab-${value}`}
                  aria-controls={`session-panel-${value}`}
                  variant="ghost"
                  aria-selected={section === value}
                  data-testid={`session-navigation-${value}`}
                  onClick={() => chooseSection(value)}
                  className={cn("flex-1", section === value && "bg-surface-highest")}
                >
                  {value === "projects" ? "Projects" : "Recents"}
                </Button>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="session-list-refresh"
              aria-label="Refresh sessions"
              title="Refresh sessions"
              disabled={refreshingSessions}
              onClick={() => void refreshSessions()}
            >
              <RefreshCw className={refreshingSessions ? "animate-spin" : undefined} />
            </Button>
          </div>
          <Input
            data-testid="chat-session-search"
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setVisibleCount(50);
            }}
          />
          <div className="min-w-0 space-y-2" {...stable.listProps}>
            <SessionStateFilters
              value={filter}
              counts={counts}
              onChange={(next) => {
                setFilter(next);
                setVisibleCount(50);
                try {
                  localStorage.setItem(FILTER_KEY, next);
                } catch {}
              }}
            >
              <StableOrderPill pending={stable.pending} onApply={stable.apply} />
            </SessionStateFilters>
            {section === "projects" && (
              <section
                role="tabpanel"
                id="session-panel-projects"
                aria-labelledby="session-tab-projects"
                aria-label="Projects"
                data-testid="session-project-list"
                className="space-y-1"
              >
                {projectGroups.map(({ project, rows }) => (
                  <ProjectGroup
                    key={project.id}
                    testId={`session-project-${project.id}`}
                    name={project.name}
                    icon={<Folder size={14} className="shrink-0" aria-hidden />}
                    count={rows.length}
                    expanded={expandedProject === project.id}
                    onToggle={() => {
                      setVisibleCount(50);
                      setExpandedProject(expandedProject === project.id ? null : project.id);
                    }}
                    onNew={() => newProjectSession(project)}
                  >
                    {rows.slice(0, visibleCount).map((entry) => (
                      <HistoryRow
                        key={entry.id}
                        entry={entry}
                        state={states.get(entry.id) ?? "idle"}
                        pending={pending}
                        selected={isSelected(entry)}
                        terminal={!!(home || entry.kind === "terminal") && !!entry.terminalId}
                        onSelect={() => selectEntry(entry)}
                      />
                    ))}
                    {!rows.length && !loading && (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">
                        {search || filter !== "all"
                          ? "No sessions match this project."
                          : "No sessions in this project yet."}
                      </p>
                    )}
                  </ProjectGroup>
                ))}
                {unassignedRows.length > 0 && (
                  <ProjectGroup
                    testId="session-project-unassigned"
                    name="Unassigned"
                    icon={<Inbox size={14} className="shrink-0" aria-hidden />}
                    count={unassignedRows.length}
                    expanded={expandedProject === UNASSIGNED_SECTION}
                    onToggle={() => {
                      setVisibleCount(50);
                      setExpandedProject(
                        expandedProject === UNASSIGNED_SECTION ? null : UNASSIGNED_SECTION,
                      );
                    }}
                  >
                    {unassignedRows.slice(0, visibleCount).map((entry) => (
                      <HistoryRow
                        key={entry.id}
                        entry={entry}
                        state={states.get(entry.id) ?? "idle"}
                        pending={pending}
                        selected={isSelected(entry)}
                        terminal={!!(home || entry.kind === "terminal") && !!entry.terminalId}
                        onSelect={() => selectEntry(entry)}
                      />
                    ))}
                  </ProjectGroup>
                )}
                {!loading && !projectGroups.length && !unassignedRows.length && (
                  <p className="px-2 text-sm text-muted-foreground">
                    No projects yet. Create a project to group its sessions here.
                  </p>
                )}
              </section>
            )}
            <div
              role="tabpanel"
              id="session-panel-recents"
              aria-labelledby="session-tab-recents"
              data-testid="chat-session-list"
              hidden={section !== "recents"}
              className="min-w-0 space-y-1"
            >
              {shown.map((entry) => (
                <HistoryRow
                  key={entry.id}
                  entry={entry}
                  state={states.get(entry.id) ?? "idle"}
                  pending={pending}
                  selected={isSelected(entry)}
                  terminal={!!(home || entry.kind === "terminal") && !!entry.terminalId}
                  onSelect={() => selectEntry(entry)}
                />
              ))}
            </div>
          </div>
          {loading && (
            <p role="status" className="px-2 text-xs text-muted-foreground">
              Loading sessions…
            </p>
          )}
          {!loading && section === "recents" && !shown.length && (
            <p className="px-2 text-sm text-muted-foreground">
              {search || filter !== "all" ? "No sessions match." : "No sessions yet."}
            </p>
          )}
          {visibleEntries.length > visibleCount && (
            <Button
              variant="ghost"
              data-testid="chat-history-more"
              onClick={() => setVisibleCount((count) => count + 50)}
            >
              Load older sessions
            </Button>
          )}
        </>
      )}
      {(error || threads.error || live.error || archive.error || projectsError) && (
        <p role="alert" className="text-sm text-error wrap-break-word">
          {error ||
            threads.error?.message ||
            live.error?.message ||
            archive.error?.message ||
            projectsError?.message}
        </p>
      )}
    </SessionHistoryFrame>
  );
}

function SessionHistoryFrame({
  docked,
  wide,
  hideTrigger = false,
  open,
  onOpenChange,
  onCollapse,
  onNew,
  children,
  newDisabled,
}: {
  newDisabled: boolean;
  docked: boolean;
  wide: boolean;
  hideTrigger?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCollapse?: () => void;
  onNew: () => void;
  children: ReactNode;
}) {
  const chat = useChat();
  const pending = chat.tabs.filter(
    (tab) =>
      tab.key !== chat.activeKey &&
      (tab.permissions.length || tab.questions.length || tab.attention || tab.error),
  ).length;
  const content = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const [sidebarMax, setSidebarMax] = useState(640);
  useEffect(() => {
    const parent = sidebar.current?.parentElement;
    if (!docked || !parent) return;
    const observer = new ResizeObserver(([entry]) =>
      setSidebarMax(Math.max(208, Math.min(640, (entry?.contentRect.width ?? 1040) - 360))),
    );
    observer.observe(parent);
    return () => observer.disconnect();
  }, [docked]);
  const sidebarWidth = usePanelWidth({
    storageKey: "orc_chat_history_width",
    initial: 256,
    min: 208,
    max: sidebarMax,
  });
  const newSession = (
    <Button
      variant="ghost"
      size="icon"
      data-testid="chat-history-new"
      className="max-sm:size-11 pointer-coarse:size-11"
      aria-label="New session"
      disabled={newDisabled}
      onClick={() => {
        chat.newTab();
        onNew();
        onOpenChange(false);
      }}
    >
      <span data-testid={docked ? "chat-clear-button" : undefined} className="inline-flex">
        <SquarePen size={16} />
      </span>
    </Button>
  );
  const trigger = (
    <button
      type="button"
      data-testid="chat-sessions-button"
      aria-label={pending ? `Sessions, ${pending} need attention` : "Sessions, session history"}
      title="Session history"
      className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-surface"
    >
      <History size={16} />
      <span>Sessions</span>
      {pending > 0 && <span className="rounded bg-surface px-1 text-warning">{pending}</span>}
    </button>
  );
  if (docked)
    return (
      <aside
        ref={sidebar}
        data-testid="chat-session-sidebar"
        style={{ width: sidebarWidth.width }}
        className="relative flex min-w-0 shrink-0 flex-col border-r border-border px-3 py-3"
      >
        {/* biome-ignore lint/a11y/useSemanticElements: resizable sidebar requires an interactive separator */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize session history"
          aria-valuenow={sidebarWidth.width}
          aria-valuemin={208}
          aria-valuemax={sidebarMax}
          tabIndex={0}
          data-testid="chat-history-resize"
          title="Drag to resize, use arrow keys, or double-click to reset"
          className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none hover:bg-surface-highest focus-visible:bg-focus"
          {...sidebarWidth.handleProps}
        />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="px-2 text-sm font-medium flex-1">Sessions</h2>
          {newSession}
          {onCollapse && (
            <Button
              variant="ghost"
              size="icon"
              data-testid="session-list-collapse"
              aria-label="Collapse session list"
              onClick={onCollapse}
            >
              <PanelLeftClose size={16} />
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-4">{children}</div>
      </aside>
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Phones render the Sessions trigger inline in the chat header instead. */}
      {!hideTrigger && (
        <div className="absolute left-2 top-1 z-10 flex items-center gap-1">
          <DialogTrigger asChild>{trigger}</DialogTrigger>
          <Button
            variant="ghost"
            size="icon"
            data-testid="chat-clear-button"
            aria-label="New session"
            disabled={newDisabled}
            onClick={() => {
              chat.newTab();
              onNew();
            }}
          >
            <SquarePen size={16} />
          </Button>
        </div>
      )}
      <DialogContent
        ref={content}
        data-testid="chat-sessions-dialog"
        data-session-list-wide={wide || undefined}
        className={cn(
          "chat-history-drawer left-0 top-[var(--app-top,0px)] flex h-[var(--app-height,100dvh)] max-h-none max-w-none translate-x-0 translate-y-0 flex-col gap-4 rounded-none p-4",
          wide ? "w-screen" : "w-[min(340px,calc(100vw-24px))] max-sm:w-screen",
        )}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle className="flex-1">Sessions</DialogTitle>
          {newSession}
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function entryAgent(entry: ChatHistoryEntry): string {
  if (entry.kind === "local") return entry.tab.config.agent;
  if (entry.kind === "saved") return entry.thread.agent || entry.provider || "";
  if (entry.kind === "terminal") return entry.terminal.kind;
  return entry.session.agent;
}

function ProviderMark({ agent }: { agent: string }) {
  return (
    <AgentIcon
      agent={agent}
      title={agentDisplayName(agent)}
      data-testid="chat-session-provider"
      data-provider={agent || "unknown"}
      className="size-5 text-muted-foreground"
    />
  );
}

function ProjectGroup({
  name,
  icon,
  count,
  expanded,
  onToggle,
  onNew,
  testId,
  children,
}: {
  name: string;
  icon: ReactNode;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onNew?: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="group" data-testid={testId}>
      <div className="flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          className="min-w-0 flex-1 justify-start gap-1.5 px-2"
          aria-expanded={expanded}
          data-testid="session-project-toggle"
          onClick={onToggle}
        >
          <ChevronRight
            size={13}
            aria-hidden
            className={cn("shrink-0 motion-safe:transition-transform", expanded && "rotate-90")}
          />
          {icon}
          <span className="min-w-0 truncate">{name}</span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        </Button>
        {onNew && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`New session in ${name}`}
            data-testid="session-project-new"
            className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100 pointer-coarse:opacity-100"
            onClick={onNew}
          >
            <Plus size={15} />
          </Button>
        )}
      </div>
      {expanded && <div className="space-y-1 pl-2">{children}</div>}
    </div>
  );
}

function HistoryRow({
  entry,
  state,
  pending,
  selected,
  terminal,
  onSelect,
}: {
  entry: ChatHistoryEntry;
  state: AgentState;
  pending: boolean;
  selected: boolean;
  terminal: boolean;
  onSelect: () => void;
}) {
  const chat = useChat();
  const tab = entry.kind === "local" ? entry.tab : null;
  const open = !!tab && !tab.hidden;
  const agent = entryAgent(entry);
  const status = AGENT_STATES[state].label;
  const testId = terminal
    ? "chat-open-terminal"
    : entry.kind === "local"
      ? "chat-session-select"
      : entry.kind === "saved"
        ? "chat-resume-thread"
        : entry.kind === "native"
          ? "chat-resume-live"
          : "chat-resume-archive";
  return (
    <div
      data-testid={tab ? "chat-tab" : "chat-history-row"}
      data-history-id={entry.id}
      data-history-updated={entry.updatedAt}
      data-history-kind={entry.kind}
      data-history-open={open ? "true" : "false"}
      data-active={selected ? "true" : "false"}
      data-state={state}
      className={`${sessionRowClass} ${selected ? "bg-surface-highest" : "hover:bg-surface"}`}
    >
      <ActionHelp label={`${agent || "Unknown provider"} · ${status}`} description={entry.title}>
        <button
          type="button"
          data-testid={testId}
          aria-current={selected ? "true" : undefined}
          disabled={pending}
          onClick={onSelect}
          className={sessionRowButtonClass}
        >
          <SessionRowContent
            agent={agent}
            title={entry.title}
            state={state}
            stateTestId="chat-session-status"
            marker={
              terminal && (
                <SquareTerminal
                  size={13}
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground"
                />
              )
            }
          />
          <span className="sr-only">
            {agent ? ` · ${agent}` : ""}
            {terminal ? " · Terminal" : ""}
            {tab?.draft ? " · Draft" : ""}
            {entry.kind === "archive" ? " · Import and resume" : ""}
          </span>
          {entry.kind === "saved" && entry.thread.running && (
            <span data-testid="chat-thread-running" className="sr-only">
              Running
            </span>
          )}
        </button>
      </ActionHelp>
      {open && tab && (
        <ActionHelp
          label={`Close ${entry.title} from open sessions`}
          description="Close from open sessions; history and background work are kept"
        >
          <button
            type="button"
            data-testid="chat-tab-close"
            aria-label={`Close ${entry.title} from open sessions`}
            onClick={() => chat.closeTab(tab.key)}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 max-md:opacity-100 max-sm:size-11 pointer-coarse:size-11"
          >
            <X size={13} />
          </button>
        </ActionHelp>
      )}
    </div>
  );
}

export function ChatConversationInfo({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { config, changePermissions, thread } = useChat();
  const preview = useDesktopPreview();
  const capabilities = useAgentCapabilities(config.agent, thread);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="chat-config-dialog"
        className="w-[calc(100%-1rem)] min-w-0 grid-cols-[minmax(0,1fr)]"
      >
        <DialogTitle>Session settings</DialogTitle>
        <DialogDescription>
          Loosening permissions applies right away, including to a pending approval. Stricter
          permissions apply to your next message. Change new-chat defaults in Settings.
        </DialogDescription>
        <dl className="space-y-3 text-sm wrap-break-word">
          <div>
            <dt className="text-muted-foreground">Agent and working folder</dt>
            <dd>
              {config.agent} · {thread?.host || "Selected execution host"}
              {thread?.cwd && <span className="block font-mono text-xs">{thread.cwd}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Tools</dt>
            <dd>
              {config.mcp === "orc"
                ? "ORC MCP connection plus agent host configuration"
                : "Agent host configuration"}
            </dd>
          </div>
          <div>
            <dd>
              <ChatPermissionSelect
                config={config}
                onChange={(next) => void changePermissions(next)}
              />
            </dd>
          </div>
        </dl>
        {preview && (
          <div className="flex items-start justify-between gap-6 border-y border-border py-3">
            <div>
              <label htmlFor="chat-browser-agent-access" className="text-sm font-medium">
                Allow agent browser control
              </label>
              <p
                id="chat-browser-control-description"
                className="mt-1 text-xs text-muted-foreground"
              >
                {preview.browserControl.globallyEnabled
                  ? "On by default. Agents in this chat can read, screenshot and interact with its browser, including signed-in pages. Changes apply immediately."
                  : "Disabled globally in Settings → Browser. Enable global access there to allow browser control for this chat."}
              </p>
            </div>
            <input
              type="checkbox"
              id="chat-browser-agent-access"
              data-testid="chat-browser-agent-access"
              aria-describedby="chat-browser-control-description"
              className="mt-1 h-4 w-4 shrink-0"
              checked={preview.browserControl.enabled}
              disabled={preview.browserControl.pending || !preview.browserControl.globallyEnabled}
              onChange={(event) => preview.browserControl.setEnabled(event.target.checked)}
            />
          </div>
        )}
        {capabilities && (
          <p data-testid="chat-capabilities" className="text-xs text-muted-foreground">
            {[
              capabilities.resume && "Resume",
              capabilities.approvals && "Approvals in chat",
              capabilities.questions && "Questions",
              capabilities.steering && "Send now",
              capabilities.interrupt && "Native stop",
            ]
              .filter(Boolean)
              .join(" · ") || "Basic text conversation"}
          </p>
        )}
        <ChatAgentOptionsEditor key={`${config.agent}:${thread?.id ?? "new"}`} />
        <details className="text-sm">
          <summary className="min-h-11 cursor-pointer py-3">Session instructions</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word text-xs">
            {config.system || "No additional instructions"}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            {config.agent === "claude"
              ? "Appended to Claude’s coding system prompt."
              : "Sent as turn instructions to the agent."}{" "}
            Agent and workspace instructions may also apply.
          </p>
        </details>
      </DialogContent>
    </Dialog>
  );
}
