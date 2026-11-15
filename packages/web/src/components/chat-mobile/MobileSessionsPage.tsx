import {
  BookOpen,
  ChevronLeft,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Inbox,
  Plus,
  RefreshCw,
  Sparkles,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { ArchiveResumeForm, ProjectGroup } from "@/components/ChatControls";
import { Highlight } from "@/components/Highlight";
import { SessionArchiveView } from "@/components/SessionArchiveView";
import { SessionStateFilters, StableOrderPill } from "@/components/SessionListControls";
import { StateBadge } from "@/components/StateBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "@/hooks/useChat";
import {
  SESSION_SORT_LABELS,
  SESSION_SORTS,
  type SessionSort,
  useSessionHistory,
} from "@/hooks/useSessionHistory";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { AGENT_STATES, type AgentState } from "@/lib/agent-state";
import type { ChatHistoryEntry } from "@/lib/chat-history-list";
import { entryAgent } from "@/lib/chat-history-list";
import { cn } from "@/lib/utils";

function activityWhen(ms: number): string {
  if (!ms) return "";
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function entryHost(entry: ChatHistoryEntry): string | null {
  if (entry.kind === "local") return entry.tab.thread?.host ?? null;
  if (entry.kind === "saved") return entry.thread.host ?? null;
  if (entry.kind === "terminal") return entry.terminal.host;
  if (entry.kind === "native") return entry.session.host;
  return null;
}

/** The phone Sessions page: the same history model as the desktop picker, laid
 *  out as a full page with search, state filters and project groups. */
export function MobileSessionsPage({ home }: { home: SessionHomeNav }) {
  const history = useSessionHistory({ home, forceOpen: true });
  const {
    chat,
    setOpen,
    search,
    setSearch,
    visibleCount,
    loadMore,
    hasMore,
    pending,
    listError,
    section,
    chooseSection,
    expandedProject,
    setExpandedProject,
    projects,
    refreshingSessions,
    refreshSessions,
    filter,
    setFilter,
    counts,
    stateOf,
    isSelected,
    stable,
    shown,
    projectGroups,
    unassignedRows,
    unassignedFolders,
    projectFromFolder,
    loading,
    selectEntry,
    openSessionView,
    newProjectSession,
    newSession,
    selectedArchive,
    archiveView,
    setArchiveView,
    deep,
    setDeep,
    deepSearching,
    searchMeta,
    archive,
    agentFilter,
    setAgentFilter,
    agentOptions,
    sort,
    setSort,
    includeHidden,
    setIncludeHidden,
    agentGroups,
  } = history;
  const root = useRef<HTMLElement>(null);
  const { ref: freezeRef, ...freezeProps } = stable.listProps;
  // Keep one callback identity: a fresh inline ref detaches every render and clears the freeze.
  const sectionRef = useCallback(
    (node: HTMLElement | null) => {
      root.current = node;
      freezeRef(node);
    },
    [freezeRef],
  );
  const close = () => setOpen(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus and Escape bind once when the page opens
  useEffect(() => {
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Document-level like the shared sheets: Escape closes from any focus,
      // unless a nested control (editor, menu) already consumed it. An open
      // transcript sheet owns Escape first and returns to this list.
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector('[role="dialog"]')
      )
        setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.querySelector<HTMLElement>('[data-testid="chat-sessions-button"]')?.focus();
    };
  }, []);
  const projectName = (id?: string | null) =>
    id ? (projects?.find((project) => project.id === id)?.name ?? "Unknown project") : null;
  const attention = chat.tabs.filter(
    (tab) =>
      tab.key !== chat.activeKey &&
      (tab.permissions.length || tab.questions.length || tab.attention || tab.error),
  ).length;
  return (
    <section
      ref={sectionRef}
      {...freezeProps}
      tabIndex={-1}
      data-testid="chat-sessions-dialog"
      data-session-list-wide="true"
      aria-label="Sessions"
      className="absolute inset-0 z-30 flex flex-col bg-background outline-none"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface"
        >
          <ChevronLeft size={20} />
        </button>
        <h2 className="min-w-0 flex-1 truncate px-1 text-base font-medium">
          Sessions
          {attention > 0 && (
            <span className="ml-2 align-middle text-xs font-normal text-warning">
              {attention} need{attention === 1 ? "s" : ""} you
            </span>
          )}
        </h2>
        <ActionHelp label="Refresh sessions">
          <button
            type="button"
            data-testid="session-list-refresh"
            aria-label="Refresh sessions"
            disabled={refreshingSessions}
            onClick={() => void refreshSessions()}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface disabled:opacity-40"
          >
            <RefreshCw size={17} className={refreshingSessions ? "animate-spin" : undefined} />
          </button>
        </ActionHelp>
        <button
          type="button"
          data-testid="chat-history-new"
          aria-label="New session"
          disabled={pending}
          onClick={newSession}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
        >
          <SquarePen size={17} />
        </button>
      </header>
      {selectedArchive ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ArchiveResumeForm history={history} />
        </div>
      ) : (
        <>
          <div className="shrink-0 space-y-2 px-3 pt-2 pb-2">
            <div className="flex items-center gap-1">
              <Input
                data-testid="chat-session-search"
                aria-label="Search sessions"
                placeholder="Search sessions…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-11 min-w-0 flex-1 text-base"
              />
              <button
                type="button"
                data-testid="chat-session-deep-search"
                aria-label="Search inside conversations"
                aria-pressed={deep}
                onClick={() => setDeep(!deep)}
                className={cn(
                  "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface",
                  deep && "bg-surface-highest text-on-surface",
                )}
              >
                <Sparkles size={17} />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <select
                data-testid="chat-session-agent"
                aria-label="Filter sessions by agent"
                value={agentFilter}
                onChange={(event) => setAgentFilter(event.target.value)}
                className="h-11 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 text-sm text-on-surface"
              >
                <option value="">All agents</option>
                {agentOptions.map((agent) => (
                  <option key={agent} value={agent}>
                    {agentDisplayName(agent)}
                  </option>
                ))}
              </select>
              <select
                data-testid="chat-session-sort"
                aria-label="Sort sessions"
                value={sort}
                onChange={(event) => setSort(event.target.value as SessionSort)}
                className="h-11 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 text-sm text-on-surface"
              >
                {SESSION_SORTS.map((value) => (
                  <option key={value} value={value}>
                    {SESSION_SORT_LABELS[value]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="chat-session-hidden"
                aria-label="Show hidden sessions"
                aria-pressed={includeHidden}
                onClick={() => setIncludeHidden(!includeHidden)}
                className={cn(
                  "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface",
                  includeHidden && "bg-surface-highest text-on-surface",
                )}
              >
                {includeHidden ? <Eye size={17} /> : <EyeOff size={17} />}
              </button>
            </div>
            {deepSearching && searchMeta && (
              <p data-testid="chat-session-search-meta" className="text-xs text-muted-foreground">
                {searchMeta.rg
                  ? `Searched conversation content in ${(searchMeta.ms / 1000).toFixed(1)}s`
                  : "Titles and summaries only. Install ripgrep to search conversation content."}
              </p>
            )}
            {archive.data?.degraded && (
              <p data-testid="chat-session-degraded" className="text-xs text-outline">
                {archive.data.degraded}
              </p>
            )}
            <SessionStateFilters value={filter} counts={counts} onChange={setFilter} />
            <div role="tablist" aria-label="Session navigation" className="flex gap-1">
              {(["projects", "recents"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  id={`session-tab-${value}`}
                  aria-controls={`session-panel-${value}`}
                  aria-selected={section === value}
                  data-testid={`session-navigation-${value}`}
                  onClick={() => chooseSection(value)}
                  className={cn(
                    "min-h-9 flex-1 rounded-md text-[13px] font-medium",
                    section === value
                      ? "bg-surface-highest text-on-surface"
                      : "text-muted-foreground hover:bg-surface",
                  )}
                >
                  {value === "projects" ? "Projects" : "Recents"}
                </button>
              ))}
              <StableOrderPill pending={stable.pending} onApply={stable.apply} />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
            {section === "projects" ? (
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
                    onToggle={() =>
                      setExpandedProject(expandedProject === project.id ? null : project.id)
                    }
                    onNew={() => newProjectSession(project)}
                  >
                    {rows.slice(0, visibleCount).map((entry) => (
                      <MobileHistoryRow
                        key={entry.id}
                        entry={entry}
                        state={stateOf(entry)}
                        pending={pending}
                        selected={isSelected(entry)}
                        project={projectName(entry.projectId)}
                        query={search}
                        onSelect={() => selectEntry(entry)}
                        onView={() => openSessionView(entry)}
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
                {unassignedFolders.map((folder) => {
                  const name = folder.cwd
                    ? (folder.cwd.split(/[\\/]/).filter(Boolean).pop() ?? folder.cwd)
                    : "Unassigned";
                  return (
                    <ProjectGroup
                      key={folder.key}
                      testId={folder.cwd ? "session-folder-group" : "session-project-unassigned"}
                      name={name}
                      title={folder.cwd ?? undefined}
                      icon={
                        folder.cwd ? (
                          <FolderOpen size={14} className="shrink-0" aria-hidden />
                        ) : (
                          <Inbox size={14} className="shrink-0" aria-hidden />
                        )
                      }
                      count={folder.rows.length}
                      expanded={expandedProject === folder.key}
                      onToggle={() =>
                        setExpandedProject(expandedProject === folder.key ? null : folder.key)
                      }
                      onAdopt={
                        folder.cwd ? () => projectFromFolder(folder.cwd as string) : undefined
                      }
                    >
                      {folder.rows.slice(0, visibleCount).map((entry) => (
                        <MobileHistoryRow
                          key={entry.id}
                          entry={entry}
                          state={stateOf(entry)}
                          pending={pending}
                          selected={isSelected(entry)}
                          project={null}
                          onSelect={() => selectEntry(entry)}
                          onView={() => openSessionView(entry)}
                        />
                      ))}
                    </ProjectGroup>
                  );
                })}
                {!loading && !projectGroups.length && !unassignedRows.length && (
                  <p className="px-2 py-4 text-sm text-muted-foreground">
                    No projects yet. Create a project to group its sessions here.
                  </p>
                )}
              </section>
            ) : (
              <div
                role="tabpanel"
                id="session-panel-recents"
                aria-labelledby="session-tab-recents"
                data-testid="chat-session-list"
                className="space-y-0.5"
              >
                {sort === "agent"
                  ? agentGroups.map((group) => (
                      <div
                        key={group.agent}
                        data-testid={`chat-session-agent-group-${group.agent}`}
                      >
                        <p className="flex items-center gap-1.5 px-2 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-outline">
                          <AgentIcon
                            agent={group.agent}
                            title={agentDisplayName(group.agent)}
                            className="size-3.5"
                          />
                          <span className="min-w-0 truncate">{agentDisplayName(group.agent)}</span>
                          <span className="tabular-nums">{group.rows.length}</span>
                        </p>
                        {group.rows.map((entry) => (
                          <MobileHistoryRow
                            key={entry.id}
                            entry={entry}
                            state={stateOf(entry)}
                            pending={pending}
                            selected={isSelected(entry)}
                            project={projectName(entry.projectId)}
                            query={search}
                            onSelect={() => selectEntry(entry)}
                            onView={() => openSessionView(entry)}
                          />
                        ))}
                      </div>
                    ))
                  : shown.map((entry) => (
                      <MobileHistoryRow
                        key={entry.id}
                        entry={entry}
                        state={stateOf(entry)}
                        pending={pending}
                        selected={isSelected(entry)}
                        project={projectName(entry.projectId)}
                        query={search}
                        onSelect={() => selectEntry(entry)}
                        onView={() => openSessionView(entry)}
                      />
                    ))}
              </div>
            )}
            {loading && (
              <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
                Loading sessions…
              </p>
            )}
            {!loading && section === "recents" && !shown.length && (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  {search || filter !== "all" ? "No sessions match." : "No sessions yet."}
                </p>
                {!search && filter === "all" && (
                  <Button variant="outline" onClick={newSession} className="min-h-11">
                    <Plus size={15} />
                    Start a session
                  </Button>
                )}
              </div>
            )}
            {hasMore && (
              <Button
                variant="ghost"
                data-testid="chat-history-more"
                onClick={loadMore}
                className="mt-1 w-full min-h-11"
              >
                Load older sessions
              </Button>
            )}
            {listError && (
              <div className="flex flex-wrap items-center gap-2">
                <p
                  role="alert"
                  data-testid="chat-session-error"
                  className="px-2 py-2 text-sm text-error wrap-break-word"
                >
                  {listError}
                </p>
                <button
                  type="button"
                  onClick={() => void refreshSessions()}
                  disabled={refreshingSessions}
                  className="min-h-9 rounded-md px-2 text-sm text-primary hover:bg-surface disabled:opacity-40"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        </>
      )}
      <SessionArchiveView session={archiveView} onClose={() => setArchiveView(null)} />
    </section>
  );
}

function MobileHistoryRow({
  entry,
  state,
  pending,
  selected,
  project,
  query = "",
  onSelect,
  onView,
}: {
  entry: ChatHistoryEntry;
  state: AgentState;
  pending: boolean;
  selected: boolean;
  project: string | null;
  query?: string;
  onSelect: () => void;
  onView?: () => void;
}) {
  const tab = entry.kind === "local" ? entry.tab : null;
  const open = !!tab && !tab.hidden;
  const agent = entryAgent(entry);
  const terminal = !!entry.terminalId;
  const hidden = entry.kind === "native" && !!entry.session.hidden;
  const status = AGENT_STATES[state].label;
  const host = entryHost(entry);
  const testId = terminal
    ? "chat-open-terminal"
    : entry.kind === "local"
      ? "chat-session-select"
      : entry.kind === "saved"
        ? "chat-resume-thread"
        : entry.kind === "native"
          ? "chat-resume-live"
          : "chat-resume-archive";
  const meta = [
    agent ? agentDisplayName(agent) : null,
    project,
    host ? host : entry.kind === "archive" ? null : "local",
    activityWhen(entry.updatedAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      data-testid={tab ? "chat-tab" : "chat-history-row"}
      data-history-id={entry.id}
      data-history-updated={entry.updatedAt}
      data-history-kind={entry.kind}
      data-history-open={open ? "true" : "false"}
      data-active={selected ? "true" : "false"}
      data-state={state}
      className={cn(
        "group flex min-w-0 items-center rounded-md",
        selected ? "bg-surface-highest" : "hover:bg-surface",
      )}
    >
      <button
        type="button"
        data-testid={testId}
        aria-current={selected ? "true" : undefined}
        aria-label={`${entry.title} · ${status}`}
        disabled={pending}
        onClick={onSelect}
        className="flex min-h-[56px] min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 text-left disabled:opacity-60"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <AgentIcon
            agent={agent}
            title={agentDisplayName(agent)}
            data-testid="chat-session-provider"
            data-provider={agent || "unknown"}
            className="size-5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-[15px] leading-snug">
            {query.trim().length >= 2 ? (
              <Highlight text={entry.title} query={query} />
            ) : (
              entry.title
            )}
          </span>
          {terminal && (
            <SquareTerminal
              size={13}
              aria-hidden="true"
              className="shrink-0 text-muted-foreground"
            />
          )}
          <StateBadge
            state={state}
            compact
            context={agent || undefined}
            testId="chat-session-status"
          />
        </span>
        <span className="flex w-full min-w-0 items-center gap-1.5 pl-7 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{meta}</span>
          {entry.kind === "native" && entry.session.handoff?.status === "ready" && (
            <span data-testid="handoff-ready" className="shrink-0 text-primary">
              Ready to resume
            </span>
          )}
          {hidden && <span className="shrink-0 text-outline">Hidden</span>}
          {tab?.draft && <span className="shrink-0 text-warning">Draft</span>}
          {entry.kind === "archive" && <span className="shrink-0">Import and resume</span>}
        </span>
        {entry.snippets?.[0] && (
          <span
            data-testid="chat-session-snippet"
            className="w-full truncate pl-7 text-[11px] text-muted-foreground"
          >
            <Highlight text={entry.snippets[0]} query={query} />
          </span>
        )}
      </button>
      {(entry.kind === "native" || entry.kind === "archive") && onView && (
        <ActionHelp
          label="View conversation"
          description="Read the native transcript here without resuming the session"
        >
          <button
            type="button"
            data-testid="chat-session-view"
            aria-label={`View ${entry.title}`}
            onClick={onView}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-on-surface"
          >
            <BookOpen size={15} />
          </button>
        </ActionHelp>
      )}
      {open && tab && (
        <ActionHelp
          label={`Close ${entry.title} from open sessions`}
          description="Close from open sessions; history and background work are kept"
        >
          <CloseTabButton tabKey={tab.key} title={entry.title} />
        </ActionHelp>
      )}
    </div>
  );
}

function CloseTabButton({ tabKey, title }: { tabKey: string; title: string }) {
  const chat = useChat();
  return (
    <button
      type="button"
      data-testid="chat-tab-close"
      aria-label={`Close ${title} from open sessions`}
      onClick={() => chat.closeTab(tabKey)}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface hover:text-on-surface"
    >
      <X size={14} />
    </button>
  );
}
