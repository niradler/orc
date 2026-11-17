import {
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Inbox,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Sparkles,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import { Highlight } from "@/components/Highlight";
import { SessionStateFilters, StableOrderPill } from "@/components/SessionListControls";
import {
  SessionRowContent,
  SessionRunChip,
  SubagentChip,
  sessionRowButtonClass,
  sessionRowClass,
} from "@/components/SessionRowContent";
import { StateBadge } from "@/components/StateBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useChat } from "@/hooks/useChat";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import {
  SESSION_SORT_LABELS,
  SESSION_SORTS,
  type SessionHistory,
  type SessionSort,
  useSessionHistory,
} from "@/hooks/useSessionHistory";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { AGENT_STATES, type AgentState } from "@/lib/agent-state";
import {
  type ChatHistoryEntry,
  entryAgent,
  nestedLabel,
  sessionModelName,
} from "@/lib/chat-history-list";
import { cn } from "@/lib/utils";

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
  const history = useSessionHistory({ enabled, docked, rail, home });
  const {
    chat,
    open,
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
    expandedProjects,
    toggleProject,
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
    adoptFolder,
    closeAdopt,
    expandProject,
    loading,
    selectEntry,
    newProjectSession,
    selectedArchive,
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
  const renderRow = (entry: ChatHistoryEntry): ReactNode => (
    <HistoryRow
      key={entry.id}
      entry={entry}
      state={stateOf(entry)}
      pending={pending}
      selected={isSelected(entry)}
      terminal={!!(home || entry.kind === "terminal") && !!entry.terminalId}
      query={search}
      onSelect={() => selectEntry(entry)}
      nested={entry.children?.map(renderRow)}
    />
  );
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
            const state = stateOf(entry);
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
        <ArchiveResumeForm history={history} />
      ) : (
        <div className="min-w-0 space-y-4" {...stable.listProps}>
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
            <StableOrderPill pending={stable.pending} onApply={stable.apply} />
            <ActionHelp
              label="Refresh sessions"
              description="Re-import agent sessions, then refresh threads, live sessions and archive."
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid="session-list-refresh"
                aria-label="Refresh sessions"
                disabled={refreshingSessions}
                onClick={() => void refreshSessions()}
              >
                <RefreshCw className={refreshingSessions ? "animate-spin" : undefined} />
              </Button>
            </ActionHelp>
          </div>
          <div className="flex items-center gap-1">
            <Input
              data-testid="chat-session-search"
              aria-label="Search sessions"
              placeholder="Search sessions…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-0 flex-1"
            />
            <ActionHelp
              label="Search inside conversations"
              description="Also match words inside transcripts (ripgrep) and archived sessions. Requires ripgrep for live content; archived search uses embeddings when configured."
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Search inside conversations"
                aria-pressed={deep}
                data-testid="chat-session-deep-search"
                onClick={() => setDeep(!deep)}
                className={cn(deep && "bg-surface-highest text-on-surface")}
              >
                <Sparkles />
              </Button>
            </ActionHelp>
          </div>
          <div className="flex items-center gap-1">
            <select
              data-testid="chat-session-agent"
              aria-label="Filter sessions by agent"
              value={agentFilter}
              onChange={(event) => setAgentFilter(event.target.value)}
              className="h-8 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 text-xs text-on-surface"
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
              className="h-8 min-w-0 flex-1 rounded-md border border-control-border bg-background px-2 text-xs text-on-surface"
            >
              {SESSION_SORTS.map((value) => (
                <option key={value} value={value}>
                  {SESSION_SORT_LABELS[value]}
                </option>
              ))}
            </select>
            <ActionHelp
              label="Show hidden sessions"
              description="Hidden sessions stay out of the list until you show and restore them."
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Show hidden sessions"
                aria-pressed={includeHidden}
                data-testid="chat-session-hidden"
                onClick={() => setIncludeHidden(!includeHidden)}
                className={cn(includeHidden && "bg-surface-highest text-on-surface")}
              >
                {includeHidden ? <Eye /> : <EyeOff />}
              </Button>
            </ActionHelp>
          </div>
          {deepSearching && searchMeta && (
            <p data-testid="chat-session-search-meta" className="text-[11px] text-muted-foreground">
              {searchMeta.rg
                ? `Searched conversation content in ${(searchMeta.ms / 1000).toFixed(1)}s`
                : "Titles and summaries only. Install ripgrep to search conversation content."}
            </p>
          )}
          {archive.data?.degraded && (
            <p data-testid="chat-session-degraded" className="text-[11px] text-outline">
              {archive.data.degraded}
            </p>
          )}
          <div className="min-w-0 space-y-2">
            <SessionStateFilters value={filter} counts={counts} onChange={setFilter} />
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
                    expanded={expandedProjects.includes(project.id)}
                    onToggle={() => toggleProject(project.id)}
                    onNew={() => newProjectSession(project)}
                  >
                    {rows.slice(0, visibleCount).map((entry) => renderRow(entry))}
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
                  const name = folder.label;
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
                      expanded={expandedProjects.includes(folder.key)}
                      onToggle={() => toggleProject(folder.key)}
                      onAdopt={
                        folder.cwd ? () => projectFromFolder(folder.cwd as string) : undefined
                      }
                    >
                      {folder.rows.slice(0, visibleCount).map((entry) => renderRow(entry))}
                    </ProjectGroup>
                  );
                })}
                {!loading && !projectGroups.length && !unassignedRows.length && (
                  <p className="px-2 text-sm text-muted-foreground">
                    No projects yet. Create a project to group its sessions here.
                  </p>
                )}
              </section>
            )}
            {section === "recents" && (
              <div
                role="tabpanel"
                id="session-panel-recents"
                aria-labelledby="session-tab-recents"
                data-testid="chat-session-list"
                className="min-w-0 space-y-1"
              >
                {sort === "agent"
                  ? agentGroups.map((group) => (
                      <div
                        key={group.agent}
                        data-testid={`chat-session-agent-group-${group.agent}`}
                        className="min-w-0"
                      >
                        <p className="flex min-w-0 items-center gap-1.5 px-2 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-outline">
                          <AgentIcon
                            agent={group.agent}
                            title={agentDisplayName(group.agent)}
                            className="size-3.5"
                          />
                          <span className="min-w-0 truncate">{agentDisplayName(group.agent)}</span>
                          <span className="tabular-nums">{group.rows.length}</span>
                        </p>
                        {group.rows.map((entry) => renderRow(entry))}
                      </div>
                    ))
                  : shown.map((entry) => renderRow(entry))}
              </div>
            )}
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
          {hasMore && (
            <Button variant="ghost" data-testid="chat-history-more" onClick={loadMore}>
              Load older sessions
            </Button>
          )}
        </div>
      )}
      {listError && (
        <div className="flex flex-wrap items-center gap-2">
          <p
            role="alert"
            data-testid="chat-session-error"
            className="text-sm text-error wrap-break-word"
          >
            {listError}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refreshSessions()}
            disabled={refreshingSessions}
          >
            Retry
          </Button>
        </div>
      )}
      {adoptFolder && (
        <CreateProjectDialog
          open
          initialName={adoptFolder.name}
          initialScope={adoptFolder.cwd}
          allowFirstTask={false}
          onClose={closeAdopt}
          onCreated={expandProject}
          onFirstTask={expandProject}
        />
      )}
    </SessionHistoryFrame>
  );
}

export function ArchiveResumeForm({ history }: { history: SessionHistory }) {
  const {
    pending,
    select,
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
  } = history;
  if (!selectedArchive) return null;
  return (
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

export function ProjectGroup({
  name,
  icon,
  count,
  expanded,
  onToggle,
  onNew,
  onAdopt,
  title,
  testId,
  children,
}: {
  name: string;
  icon: ReactNode;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  onNew?: () => void;
  onAdopt?: () => void;
  title?: string;
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
          title={title}
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
        {onAdopt && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Make project from ${name}`}
            title={`Make project from ${name}`}
            data-testid="session-folder-adopt"
            className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-sm:opacity-100 pointer-coarse:opacity-100"
            onClick={onAdopt}
          >
            <FolderPlus size={15} />
          </Button>
        )}
      </div>
      {expanded && <div className="space-y-1 pl-2">{children}</div>}
    </div>
  );
}

export function HistoryRow({
  entry,
  state,
  pending,
  selected,
  terminal,
  query = "",
  onSelect,
  nested,
}: {
  entry: ChatHistoryEntry;
  state: AgentState;
  pending: boolean;
  selected: boolean;
  terminal: boolean;
  query?: string;
  onSelect: () => void;
  nested?: ReactNode[] | undefined;
}) {
  const chat = useChat();
  const tab = entry.kind === "local" ? entry.tab : null;
  const open = !!tab && !tab.hidden;
  const agent = entryAgent(entry);
  const status = AGENT_STATES[state].label;
  const hidden = entry.kind === "native" && !!entry.session.hidden;
  const live = entry.kind === "native" ? entry.session : null;
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
      className={cn(
        "group min-w-0 rounded-md",
        selected ? "bg-surface-highest" : "hover:bg-surface",
      )}
    >
      <div className={sessionRowClass}>
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
              title={
                query.trim().length >= 2 ? (
                  <Highlight text={entry.title} query={query} />
                ) : (
                  entry.title
                )
              }
              state={state}
              stateTestId="chat-session-status"
              mode={entry.kind === "native" ? entry.session.permission_mode : null}
              model={sessionModelName(entry)}
              badge={
                entry.subagents || live?.waiting_for || live?.background_work ? (
                  <>
                    <SessionRunChip session={live} />
                    <SubagentChip count={entry.subagents} />
                  </>
                ) : undefined
              }
              marker={
                <>
                  {entry.kind === "native" && entry.session.handoff?.status === "ready" && (
                    <span data-testid="handoff-ready" className="shrink-0 text-[10px] text-primary">
                      Ready to resume
                    </span>
                  )}
                  {hidden && (
                    <span
                      data-testid="chat-session-hidden-badge"
                      className="shrink-0 text-[10px] text-outline"
                    >
                      Hidden
                    </span>
                  )}
                  {terminal && (
                    <SquareTerminal
                      size={13}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                </>
              }
            />
            <span className="sr-only">
              {agent ? ` · ${agent}` : ""}
              {terminal ? " · Terminal" : ""}
              {hidden ? " · Hidden" : ""}
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
        {!(open && tab) && (
          <span aria-hidden className="size-8 shrink-0 max-sm:size-11 pointer-coarse:size-11" />
        )}
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
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-surface-highest hover:text-on-surface group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 max-md:opacity-100 max-sm:size-11 pointer-coarse:size-11"
            >
              <X size={13} />
            </button>
          </ActionHelp>
        )}
      </div>
      {entry.snippets?.[0] && (
        <p
          data-testid="chat-session-snippet"
          className="truncate pl-8 pr-2 pb-1 text-[11px] text-muted-foreground"
          title={entry.snippets[0]}
        >
          <Highlight text={entry.snippets[0]} query={query} />
        </p>
      )}
      {nested?.length && entry.children ? (
        <SubagentList label={nestedLabel(entry.children)}>{nested}</SubagentList>
      ) : null}
    </div>
  );
}

export function SubagentList({
  label,
  children,
  testId = "chat-session-subagents",
  className,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testId} className={cn("pb-1 pl-6", className)}>
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} ${label}`}
        onClick={() => setOpen(!open)}
        className="inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-surface-highest hover:text-on-surface max-sm:min-h-11 pointer-coarse:min-h-11"
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={cn("shrink-0 motion-safe:transition-transform", open && "rotate-90")}
        />
        {label}
      </button>
      {open && <div className="space-y-0.5 border-l border-border pl-1.5">{children}</div>}
    </div>
  );
}
