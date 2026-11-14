import {
  ChevronLeft,
  Folder,
  Inbox,
  Plus,
  RefreshCw,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { ArchiveResumeForm, entryAgent, ProjectGroup } from "@/components/ChatControls";
import { SessionStateFilters, StableOrderPill } from "@/components/SessionListControls";
import { StateBadge } from "@/components/StateBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "@/hooks/useChat";
import { useSessionHistory } from "@/hooks/useSessionHistory";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { AGENT_STATES, type AgentState } from "@/lib/agent-state";
import type { ChatHistoryEntry } from "@/lib/chat-history-list";
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
    loading,
    selectEntry,
    newProjectSession,
    newSession,
    selectedArchive,
  } = history;
  const root = useRef<HTMLElement>(null);
  const close = () => setOpen(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus and Escape bind once when the page opens
  useEffect(() => {
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // Document-level like the shared sheets: Escape closes from any focus,
      // unless a nested control (editor, menu) already consumed it.
      if (event.key === "Escape" && !event.defaultPrevented) setOpen(false);
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
      ref={root}
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
            <Input
              data-testid="chat-session-search"
              aria-label="Search sessions"
              placeholder="Search sessions…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-11 text-base"
            />
            <SessionStateFilters value={filter} counts={counts} onChange={setFilter}>
              <StableOrderPill pending={stable.pending} onApply={stable.apply} />
            </SessionStateFilters>
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
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-6" {...stable.listProps}>
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
                    expanded={expandedProject === "__unassigned__"}
                    onToggle={() =>
                      setExpandedProject(
                        expandedProject === "__unassigned__" ? null : "__unassigned__",
                      )
                    }
                  >
                    {unassignedRows.slice(0, visibleCount).map((entry) => (
                      <MobileHistoryRow
                        key={entry.id}
                        entry={entry}
                        state={stateOf(entry)}
                        pending={pending}
                        selected={isSelected(entry)}
                        project={null}
                        onSelect={() => selectEntry(entry)}
                      />
                    ))}
                  </ProjectGroup>
                )}
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
                {shown.map((entry) => (
                  <MobileHistoryRow
                    key={entry.id}
                    entry={entry}
                    state={stateOf(entry)}
                    pending={pending}
                    selected={isSelected(entry)}
                    project={projectName(entry.projectId)}
                    onSelect={() => selectEntry(entry)}
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
              <p role="alert" className="px-2 py-2 text-sm text-error wrap-break-word">
                {listError}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function MobileHistoryRow({
  entry,
  state,
  pending,
  selected,
  project,
  onSelect,
}: {
  entry: ChatHistoryEntry;
  state: AgentState;
  pending: boolean;
  selected: boolean;
  project: string | null;
  onSelect: () => void;
}) {
  const tab = entry.kind === "local" ? entry.tab : null;
  const open = !!tab && !tab.hidden;
  const agent = entryAgent(entry);
  const terminal = !!entry.terminalId;
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
          <span className="min-w-0 flex-1 truncate text-[15px] leading-snug">{entry.title}</span>
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
          {tab?.draft && <span className="shrink-0 text-warning">Draft</span>}
          {entry.kind === "archive" && <span className="shrink-0">Import and resume</span>}
        </span>
      </button>
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
