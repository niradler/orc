import type { ChatMessage, ChatTurn } from "@orc/core/chat";
import {
  Check,
  ChevronRight,
  Copy,
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
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { AgentIcon, agentDisplayName } from "@/components/AgentIcon";
import { ChatAgentOptionsEditor } from "@/components/ChatAgentOptionsEditor";
import { ChatPermissionSelect } from "@/components/ChatPermissionSelect";
import { HelpPopover } from "@/components/HelpPopover";
import { SessionCacheUsage } from "@/components/SessionCacheUsage";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useChat } from "@/hooks/useChat";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { type SessionHistory, useSessionHistory } from "@/hooks/useSessionHistory";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { AGENT_STATES, type AgentState } from "@/lib/agent-state";
import { formatDuration } from "@/lib/chat-activity";
import type { ChatHistoryEntry } from "@/lib/chat-history-list";
import { useDesktopPreview } from "@/lib/desktop-preview-context";
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
    expandedProject,
    setExpandedProject,
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
    selectedArchive,
  } = history;
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
          <Input
            data-testid="chat-session-search"
            aria-label="Search sessions"
            placeholder="Search sessions…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="min-w-0 space-y-2" {...stable.listProps}>
            <SessionStateFilters value={filter} counts={counts} onChange={setFilter}>
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
                    onToggle={() =>
                      setExpandedProject(expandedProject === project.id ? null : project.id)
                    }
                    onNew={() => newProjectSession(project)}
                  >
                    {rows.slice(0, visibleCount).map((entry) => (
                      <HistoryRow
                        key={entry.id}
                        entry={entry}
                        state={stateOf(entry)}
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
                    expanded={expandedProject === "__unassigned__"}
                    onToggle={() =>
                      setExpandedProject(
                        expandedProject === "__unassigned__" ? null : "__unassigned__",
                      )
                    }
                  >
                    {unassignedRows.slice(0, visibleCount).map((entry) => (
                      <HistoryRow
                        key={entry.id}
                        entry={entry}
                        state={stateOf(entry)}
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
                  state={stateOf(entry)}
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
          {hasMore && (
            <Button variant="ghost" data-testid="chat-history-more" onClick={loadMore}>
              Load older sessions
            </Button>
          )}
        </>
      )}
      {listError && (
        <p role="alert" className="text-sm text-error wrap-break-word">
          {listError}
        </p>
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

export function entryAgent(entry: ChatHistoryEntry): string {
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

export function ProjectGroup({
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

export function HistoryRow({
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
  const { config, changePermissions, thread, streaming } = useChat();
  const preview = useDesktopPreview();
  const capabilities = useAgentCapabilities(config.agent, thread);
  const analytics = chatAnalytics(thread?.messages ?? []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="chat-config-dialog"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          // Do not focus a help trigger: its tooltip would become the top layer
          // and swallow the Escape that closes the dialog.
          event.preventDefault();
          const content = event.currentTarget as HTMLElement | null;
          content?.focus();
        }}
        className="w-[calc(100%-1rem)] min-w-0 grid-cols-[minmax(0,1fr)] sm:max-w-2xl"
      >
        <div className="flex min-w-0 items-center gap-1 pr-8">
          <DialogTitle className="min-w-0 flex-1">Session settings</DialogTitle>
          <HelpPopover label="Session settings">
            These settings belong to this conversation. Loosening permissions applies right away,
            including to a pending approval; stricter permissions apply to your next message. New
            chat defaults live in Settings → Chat.
          </HelpPopover>
        </div>
        <DialogDescription className="sr-only">
          Information, customization and analytics for this chat session.
        </DialogDescription>
        <Tabs defaultValue="overview" className="min-w-0">
          <TabsList aria-label="Session settings sections" className="grid w-full grid-cols-3 p-0">
            {(
              [
                ["overview", "Overview"],
                ["customize", "Customize"],
                ["analytics", "Analytics"],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value}
                data-testid={`chat-settings-tab-${value}`}
                className="bg-surface hover:bg-surface-high"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <dl data-testid="chat-session-info" className="space-y-3 text-sm wrap-break-word">
              <SettingsRow label="Agent">
                <span data-testid="chat-settings-agent">{agentDisplayName(config.agent)}</span>
                {config.model && (
                  <span data-testid="chat-settings-model" className="text-muted-foreground">
                    {" "}
                    · {config.model}
                  </span>
                )}
              </SettingsRow>
              <SettingsRow label="Execution">
                {thread
                  ? `${thread.host || "Local"} · ${thread.cwd}`
                  : "Starts with your first message"}
                {thread?.cwd && (
                  <span className="block font-mono text-xs break-all">{thread.cwd}</span>
                )}
              </SettingsRow>
              {thread?.backend && (
                <SettingsRow label="Backend">
                  <span className="font-mono text-xs">{thread.backend}</span>
                </SettingsRow>
              )}
              {thread && <SettingsRow label="Last activity">{when(thread.updatedAt)}</SettingsRow>}
              <SettingsRow label="Tools">
                {config.mcp === "orc"
                  ? "ORC MCP connection plus agent host configuration"
                  : "Agent host configuration"}
              </SettingsRow>
              {capabilities && (
                <SettingsRow label="Capabilities">
                  <span data-testid="chat-capabilities">
                    {[
                      capabilities.resume && "Resume",
                      capabilities.approvals && "Approvals in chat",
                      capabilities.questions && "Questions",
                      capabilities.steering && "Send now",
                      capabilities.interrupt && "Native stop",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Basic text conversation"}
                  </span>
                </SettingsRow>
              )}
            </dl>
            <section aria-labelledby="chat-session-ids-heading" className="space-y-2">
              <div className="flex items-center gap-1">
                <h3 id="chat-session-ids-heading" className="text-sm font-medium">
                  Identifiers
                </h3>
                <HelpPopover label="Session identifiers" testId="chat-session-ids-help">
                  ORC chat ID names this conversation in ORC. The agent session ID is the coding
                  agent's native session, used to resume it outside ORC. The resume session ID is
                  the discovered ORC session this chat continues, when it was resumed.
                </HelpPopover>
              </div>
              <dl className="space-y-2" data-testid="chat-session-ids">
                <IdRow id="orc" label="ORC chat ID" value={thread?.id} empty="Not saved yet" />
                <IdRow
                  id="agent"
                  label="Agent session ID"
                  value={thread?.runtimeId}
                  empty="No native session yet"
                />
                <IdRow
                  id="resume"
                  label="Resume session ID"
                  value={thread?.sourceId}
                  empty="Not resumed from a session"
                />
              </dl>
            </section>
          </TabsContent>
          <TabsContent value="customize" className="space-y-5">
            {thread && (
              <p className="text-sm text-muted-foreground wrap-break-word">
                Runs in {thread.host || "Local"} ·{" "}
                <span className="font-mono text-xs">{thread.cwd}</span>
              </p>
            )}
            <ChatPermissionSelect
              config={config}
              onChange={(next) => void changePermissions(next)}
            />
            <ChatAgentOptionsEditor key={`${config.agent}:${thread?.id ?? "new"}`} />
            <div className="text-sm">
              <div className="flex items-center gap-1">
                <label htmlFor="chat-session-instructions" className="text-sm font-medium">
                  Session instructions
                </label>
                <HelpPopover label="Session instructions" testId="chat-instructions-help">
                  {config.agent === "claude"
                    ? "Appended to Claude’s coding system prompt."
                    : "Sent as turn instructions to the agent."}{" "}
                  Agent and workspace instructions may also apply.
                </HelpPopover>
              </div>
              <pre
                id="chat-session-instructions"
                className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs wrap-break-word"
              >
                {config.system || "No additional instructions"}
              </pre>
            </div>
            {preview && (
              <div className="flex items-start justify-between gap-6 border-t border-border pt-4">
                <div className="flex min-w-0 items-center gap-1">
                  <label htmlFor="chat-browser-agent-access" className="text-sm font-medium">
                    Allow agent browser control
                  </label>
                  <HelpPopover label="Agent browser control" testId="chat-browser-help">
                    {preview.browserControl.globallyEnabled
                      ? "On by default. Agents in this chat can read, screenshot and interact with its browser, including signed-in pages. Changes apply immediately."
                      : "Disabled globally in Settings → Browser. Enable global access there to allow browser control for this chat."}
                  </HelpPopover>
                </div>
                <input
                  type="checkbox"
                  id="chat-browser-agent-access"
                  data-testid="chat-browser-agent-access"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={preview.browserControl.enabled}
                  disabled={
                    preview.browserControl.pending || !preview.browserControl.globallyEnabled
                  }
                  onChange={(event) => preview.browserControl.setEnabled(event.target.checked)}
                />
              </div>
            )}
          </TabsContent>
          <TabsContent value="analytics" className="space-y-4">
            <div className="flex items-center gap-1">
              <h3 className="text-sm font-medium">Session analytics</h3>
              <HelpPopover label="Session analytics" testId="chat-analytics-help">
                Counts come from this chat's stored transcript. Context and cache figures appear
                when the agent records usage for the session.
              </HelpPopover>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <AnalyticsStat label="Messages" value={analytics.messages} />
              <AnalyticsStat label="Turns" value={analytics.turns} />
              <AnalyticsStat label="Tool calls" value={analytics.tools} />
              <AnalyticsStat label="Tool failures" value={analytics.toolFailures} />
            </div>
            <dl className="space-y-3 text-sm wrap-break-word">
              <SettingsRow label="Started">{when(analytics.startedAt)}</SettingsRow>
              <SettingsRow label="Last activity">
                {thread ? when(thread.updatedAt) : "—"}
              </SettingsRow>
              <SettingsRow label="Last turn">
                {analytics.lastTurn
                  ? [
                      analytics.lastTurn.outcome ?? "running",
                      analytics.lastTurn.durationMs !== undefined
                        ? `${formatDuration(analytics.lastTurn.durationMs)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : "No completed turn yet"}
              </SettingsRow>
              <SettingsRow label="Average turn">
                {analytics.averageTurnMs === null ? "—" : formatDuration(analytics.averageTurnMs)}
              </SettingsRow>
              {analytics.attachments > 0 && (
                <SettingsRow label="Attachments">{analytics.attachments}</SettingsRow>
              )}
            </dl>
            {thread?.sourceId ? (
              <div className="border-t border-border pt-3">
                <SessionCacheUsage sessionId={thread.sourceId} live={streaming} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {thread
                  ? "Context and cache usage are recorded for sessions resumed from an agent session or terminal."
                  : "Analytics appear after the session starts."}
              </p>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function AnalyticsStat({ label, value }: { label: string; value: number }) {
  return (
    <div data-testid={`chat-analytics-${label.toLowerCase().replace(" ", "-")}`}>
      <p className="text-lg font-medium tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function IdRow({
  id,
  label,
  value,
  empty,
}: {
  id: string;
  label: string;
  value: string | null | undefined;
  empty: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd
          data-testid={`chat-session-id-${id}`}
          className="font-mono text-xs break-all text-on-surface-variant"
        >
          {value ?? empty}
        </dd>
      </div>
      {value && (
        <button
          type="button"
          data-testid={`chat-session-id-copy-${id}`}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          title={copied ? `${label} copied` : `Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* The value stays visible for manual copying. */
            }
          }}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus max-sm:size-11 pointer-coarse:size-11"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
    </div>
  );
}

function chatAnalytics(messages: ChatMessage[]) {
  let turns = 0;
  let tools = 0;
  let toolFailures = 0;
  let attachments = 0;
  let timed = 0;
  let totalDuration = 0;
  let lastTurn: ChatTurn | undefined;
  for (const message of messages) {
    attachments += message.attachments?.length ?? 0;
    for (const activity of message.activity ?? []) {
      if (activity.type !== "tool") continue;
      tools += 1;
      if (activity.isError) toolFailures += 1;
    }
    if (!message.turn) continue;
    turns += 1;
    lastTurn = message.turn;
    if (message.turn.durationMs === undefined) continue;
    timed += 1;
    totalDuration += message.turn.durationMs;
  }
  return {
    messages: messages.length,
    turns,
    tools,
    toolFailures,
    attachments,
    startedAt: messages[0]?.timestamp,
    lastTurn,
    averageTurnMs: timed ? Math.round(totalDuration / timed) : null,
  };
}

function when(value: number | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
