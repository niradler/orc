import { MoreHorizontal } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { CreateTerminalInput, Terminal } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { ResumeActions } from "@/components/ResumeActions";
import { ContinueInChat } from "@/components/terminals/ContinueInChat";
import { NewTerminalMenu } from "@/components/terminals/NewTerminalMenu";
import { RenameTerminal } from "@/components/terminals/RenameTerminal";
import { TerminalCheckout } from "@/components/terminals/TerminalCheckout";
import { TerminalList } from "@/components/terminals/TerminalList";
import { TerminalSelect } from "@/components/terminals/TerminalSelect";
import { TerminalTouchControls } from "@/components/terminals/TerminalTouchControls";
import { TerminalWorkspace } from "@/components/terminals/TerminalWorkspace";
import { WorktreeManager } from "@/components/terminals/WorktreeManager";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { useLiveSessions } from "@/hooks/useSessions";
import { useSsh } from "@/hooks/useSsh";
import { TERMINAL_KINDS } from "@/lib/terminal-kinds";
import { runningTerminalForSession, terminalPath } from "@/lib/terminal-links";
import { terminalStatus } from "@/lib/terminal-presentation";
import { useTerminals } from "@/lib/terminals";
import { cn } from "@/lib/utils";
import { workspaceDestination } from "@/lib/workspace-navigation";

const SIDEBAR_DEFAULT = 256;
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 480;

function TerminalViewport({ terminalId }: { terminalId: string }) {
  const { attach, detach, engineError } = useTerminals();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    void attach(terminalId, container);
    return () => detach(terminalId);
  }, [terminalId, attach, detach]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div
        ref={ref}
        data-testid="terminal-viewport"
        className="relative flex-1 min-h-0 min-w-0 bg-black"
      >
        {engineError && (
          <p
            role="alert"
            className="absolute inset-0 flex items-center justify-center p-4 bg-surface text-error font-label text-xs text-center"
          >
            Terminal renderer failed to load: {engineError}
          </p>
        )}
      </div>
      <TerminalTouchControls terminalId={terminalId} />
    </div>
  );
}

const LINK_CLASS =
  "shrink-0 inline-flex min-h-11 items-center rounded-md font-label text-sm text-primary hover:text-on-surface";

// A terminal that resumed a live session points back to that session and to its linked task.
function SessionLinks({ liveSessionId }: { liveSessionId: string }) {
  const [params] = useSearchParams();
  const project = params.get("project") ?? "all";
  const { data: sessions } = useLiveSessions(false);
  const task = sessions?.find((s) => s.id === liveSessionId)?.task;
  return (
    <div className="shrink-0 flex items-center gap-3">
      <Link
        to={`${workspaceDestination("/sessions", project, params.toString())}&session=${encodeURIComponent(liveSessionId)}`}
        data-testid="terminal-open-session"
        className={LINK_CLASS}
      >
        Session
      </Link>
      {task && (
        <Link
          to={workspaceDestination(`/tasks/${task.id}`, project, params.toString())}
          data-testid="terminal-open-task"
          title={task.title}
          className={LINK_CLASS}
        >
          Task
        </Link>
      )}
    </div>
  );
}

// Shown for a shared session link when no terminal is running that session.
function NoSessionTerminal({ liveSessionId }: { liveSessionId: string }) {
  const [params] = useSearchParams();
  const { data: sessions, isLoading, error: loadError, refetch } = useLiveSessions(false);
  const session = sessions?.find((s) => s.id === liveSessionId);

  if (isLoading) return <Skeleton className="h-24 w-full max-w-md" />;

  if (loadError) return <ErrorState message={loadError.message} onRetry={() => refetch()} />;

  return (
    <div data-testid="no-session-terminal" className="max-w-md space-y-3 text-center">
      <h2 className="font-headline text-sm text-on-surface">
        {session ? "No terminal is open for this session" : "Session not found"}
      </h2>
      {session && (
        <p className="truncate font-body text-sm text-on-surface-variant">
          {session.name ?? session.summary ?? session.id}
        </p>
      )}
      <div className="flex items-center justify-center gap-3">
        {session && <ResumeActions session={session} />}
        <Link
          to={workspaceDestination("/terminals", params.get("project") ?? "all", params.toString())}
          className={LINK_CLASS}
        >
          All terminals
        </Link>
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex-1 min-h-0 flex items-center justify-center p-6">{children}</div>;
}

export default function Terminals() {
  const { terminalId } = useParams();
  const [params] = useSearchParams();
  const sessionParam = params.get("session");
  const navigate = useNavigate();
  const { terminals, info, isLoading, error, refetch, lastActiveId, connectionOf, create, remove } =
    useTerminals();
  const isDesktop = useBreakpoint("lg");
  const { data: ssh } = useSsh();
  const sidebar = usePanelWidth({
    storageKey: "orc_terminal_sidebar_width",
    initial: SIDEBAR_DEFAULT,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const [launchHost, setLaunchHost] = useState<string | null | undefined>();
  const handleMenuOpenChange = useCallback((open: boolean) => {
    if (open) setLaunchHost(undefined);
    setMenuOpen(open);
  }, []);
  useEffect(() => {
    if (params.get("new") !== "1") return;
    setLaunchHost(params.has("terminalHost") ? params.get("terminalHost") || null : undefined);
    setMenuOpen(true);
    const next = new URLSearchParams(params);
    next.delete("new");
    next.delete("terminalHost");
    navigate({ search: next.toString() }, { replace: true });
  }, [params, navigate]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [closing, setClosing] = useState<Terminal | null>(null);
  const [renaming, setRenaming] = useState<Terminal | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCreate = useCallback(
    async (input: CreateTerminalInput): Promise<boolean> => {
      setCreating(true);
      setCreateError(null);
      try {
        const terminal = await create(input);
        setMenuOpen(false);
        navigate(
          workspaceDestination(
            `/terminals/${terminal.id}`,
            params.get("project") ?? "all",
            params.toString(),
          ),
        );
        return true;
      } catch (e) {
        setCreateError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setCreating(false);
      }
    },
    [create, navigate, params],
  );

  const closeTerminal = useCallback(
    async (terminal: Terminal) => {
      setActionError(null);
      try {
        await remove(terminal.id);
        setClosing(null);
        if (terminal.id === terminalId) {
          const next = terminals.find((t) => t.id !== terminal.id);
          navigate(
            workspaceDestination(
              next ? `/terminals/${next.id}` : "/terminals",
              params.get("project") ?? "all",
              params.toString(),
            ),
            {
              replace: true,
            },
          );
        }
      } catch (e) {
        setClosing(null);
        setActionError(e instanceof Error ? e.message : String(e));
      }
    },
    [remove, terminalId, terminals, navigate, params],
  );

  const requestClose = useCallback(
    (terminal: Terminal) => {
      if (terminal.status === "running") setClosing(terminal);
      else void closeTerminal(terminal);
    },
    [closeTerminal],
  );

  const canDuplicate = (terminal: Terminal): boolean =>
    !!info && (terminal.host ? ssh?.supported === true : info.launchers.includes(terminal.kind));
  const duplicateTerminal = async (terminal: Terminal): Promise<void> => {
    if (!canDuplicate(terminal) || creating) return;
    setCreating(true);
    setActionError(null);
    try {
      const duplicate = await create({
        kind: terminal.kind,
        host: terminal.host,
        ...(terminal.cwd ? { cwd: terminal.cwd } : {}),
        name: `${terminal.name.slice(0, 113)} (copy)`,
      });
      const next = new URLSearchParams(params);
      next.delete("session");
      next.delete("file");
      next.set("view", "terminal");
      next.set("paneTerminal", duplicate.id);
      navigate({ pathname: `/terminals/${duplicate.id}`, search: next.toString() });
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  if (error && !info) {
    return (
      <Centered>
        <div data-testid="terminal-load-error">
          <ErrorState message={error.message} onRetry={refetch} />
        </div>
      </Centered>
    );
  }

  if (isLoading || !info) {
    return (
      <Centered>
        <div
          role="status"
          data-testid="terminal-loading"
          aria-label="Loading terminals"
          className="w-full max-w-md"
        >
          <Skeleton className="h-40 w-full" />
          <span className="sr-only">Loading terminals…</span>
        </div>
      </Centered>
    );
  }

  if (!info.ready) {
    return (
      <Centered>
        <div className="max-w-md space-y-3 text-center">
          <h2 className="font-headline text-sm text-on-surface">Terminals are not available</h2>
          <p className="font-body text-sm text-on-surface-variant">
            {info.reason ?? "The API has not enabled terminals."}
          </p>
          <p className="font-body text-xs text-on-surface-variant">
            Terminals require Bun 1.4.2 or newer and can be turned off with{" "}
            <code className="text-primary">terminals.enabled: false</code>.
          </p>
        </div>
      </Centered>
    );
  }

  // /terminals?session=<id> is the shareable link for a session's terminal.
  if (!terminalId && sessionParam) {
    const match = runningTerminalForSession(terminals, sessionParam);
    if (match)
      return (
        <Navigate to={{ pathname: terminalPath(match.id), search: params.toString() }} replace />
      );
    return (
      <Centered>
        <NoSessionTerminal liveSessionId={sessionParam} />
      </Centered>
    );
  }

  if (!terminalId && terminals.length > 0) {
    const preferred = terminals.find((t) => t.id === lastActiveId) ?? terminals[0];
    return (
      <Navigate
        to={{ pathname: `/terminals/${preferred.id}`, search: params.toString() }}
        replace
      />
    );
  }

  const selected = terminalId ? terminals.find((t) => t.id === terminalId) : undefined;
  const mobileTerminalId = params.get("paneTerminal") ?? terminalId;
  const mobileTerminal = terminals.find((terminal) => terminal.id === mobileTerminalId);
  const defaultLaunchHost = launchHost === undefined ? (ssh?.host ?? null) : launchHost;
  const worktreeManager = (
    <WorktreeManager launchers={info.launchers} host={info.host} onCreate={handleCreate} />
  );
  const newMenu = (
    <NewTerminalMenu
      key={defaultLaunchHost ?? "local"}
      open={menuOpen}
      onOpenChange={handleMenuOpenChange}
      launchers={defaultLaunchHost === info.host ? info.launchers : []}
      host={defaultLaunchHost}
      pending={creating}
      error={createError}
      onCreate={handleCreate}
      compact={!isDesktop}
    />
  );

  return (
    <div className="terminal-workspace-page flex h-full w-full min-h-0 bg-background">
      {isDesktop && (
        <aside
          data-testid="terminal-sidebar"
          style={{ width: sidebar.width }}
          className="relative shrink-0 flex flex-col min-h-0 border-r border-outline-variant bg-background"
        >
          <div className="shrink-0 p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-on-surface">Sessions</h2>
              {worktreeManager}
            </div>
            {newMenu}
          </div>
          <TerminalList
            terminals={terminals}
            activeId={terminalId ?? null}
            onClose={requestClose}
            connectionOf={connectionOf}
            onRename={setRenaming}
            onDuplicate={(terminal) => void duplicateTerminal(terminal)}
            canDuplicate={canDuplicate}
            pending={creating}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize terminal list"
            aria-valuenow={sidebar.width}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            tabIndex={0}
            data-testid="terminal-sidebar-resize"
            title="Drag to resize, double-click to reset"
            className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none hover:bg-surface-highest focus-visible:bg-focus"
            {...sidebar.handleProps}
          />
        </aside>
      )}
      <section className="flex-1 min-w-0 min-h-0 flex flex-col">
        {!isDesktop && (
          <div className="shrink-0 flex items-center gap-2 px-2 py-1 border-b border-surface-highest">
            <TerminalSelect
              aria-label="Terminal"
              value={mobileTerminal?.id ?? ""}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                next.delete("file");
                next.delete("session");
                if (next.has("view")) next.set("paneTerminal", event.target.value);
                navigate({
                  pathname: `/terminals/${event.target.value}`,
                  search: next.toString(),
                });
              }}
              disabled={terminals.length === 0}
              className="flex-1 min-w-0 bg-background border border-control-border text-on-surface font-label text-base sm:text-sm min-h-11 px-2 py-2 rounded-md"
            >
              {terminals.length === 0 && <option value="">No terminals</option>}
              {terminals.length > 0 && !mobileTerminal && <option value="">Choose terminal</option>}
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </TerminalSelect>
            <div className="shrink-0">{newMenu}</div>
            {mobileTerminal && <ContinueInChat key={mobileTerminal.id} terminal={mobileTerminal} />}
            <Button
              variant="ghost"
              size="icon"
              data-testid="terminal-options"
              ref={optionsButtonRef}
              aria-label="Terminal options"
              onClick={() => setOptionsOpen(true)}
            >
              <MoreHorizontal size={18} />
            </Button>
          </div>
        )}

        {selected ? (
          <>
            <header className="hidden lg:flex shrink-0 flex-wrap items-center gap-3 px-3 py-3 border-b border-outline-variant bg-background min-w-0">
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  selected.status === "running" ? "bg-secondary" : "bg-outline",
                )}
              />
              <div className="flex-1 min-w-0">
                <div
                  data-testid="terminal-name"
                  title={selected.name}
                  className="truncate font-body text-sm text-on-surface"
                >
                  {selected.name}
                </div>
                <div className="truncate font-label text-xs text-on-surface-variant">
                  {TERMINAL_KINDS[selected.kind].label}
                  {selected.host && (
                    <span data-testid="terminal-selected-host" title={`SSH host: ${selected.host}`}>
                      {" "}
                      · {selected.host}
                    </span>
                  )}
                  {selected.cwd && (
                    <span className="normal-case tracking-normal"> · {selected.cwd}</span>
                  )}
                  <span> · {terminalStatus(selected, connectionOf(selected.id))}</span>
                </div>
                <div className={params.get("view") === "git" ? "hidden" : "md:hidden"}>
                  <TerminalCheckout key={selected.id} terminal={selected} />
                </div>
              </div>

              {actionError && (
                <span role="alert" className="w-full font-body text-sm text-error break-words">
                  {actionError}
                </span>
              )}
              <ContinueInChat key={selected.id} terminal={selected} />
              {selected.live_session_id && (
                <SessionLinks liveSessionId={selected.live_session_id} />
              )}
            </header>
            {!isDesktop && actionError && (
              <p role="alert" className="p-2 text-sm text-error break-words">
                {actionError}
              </p>
            )}
            <TerminalWorkspace
              selected={selected}
              terminals={terminals}
              renderTerminal={(id) => <TerminalViewport terminalId={id} />}
            />
          </>
        ) : (
          <Centered>
            <div className="text-center space-y-3">
              <p className="font-label text-xs text-on-surface-variant">
                {terminalId ? "Terminal not found" : "No terminals yet"}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  terminalId
                    ? navigate(
                        workspaceDestination(
                          "/terminals",
                          params.get("project") ?? "all",
                          params.toString(),
                        ),
                      )
                    : setMenuOpen(true)
                }
                className="font-label text-sm"
              >
                {terminalId ? "Back to terminals" : "Start a terminal"}
              </Button>
            </div>
          </Centered>
        )}
      </section>
      <Sheet open={optionsOpen && !isDesktop} onOpenChange={setOptionsOpen}>
        <SheetContent
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            optionsButtonRef.current?.focus();
          }}
        >
          <SheetHeader>
            <SheetTitle>Terminal options</SheetTitle>
          </SheetHeader>
          <SheetBody className="space-y-4">
            {mobileTerminal && (
              <div className="space-y-2 text-sm">
                <p className="break-words font-medium">{mobileTerminal.name}</p>
                <p className="break-all text-on-surface-variant">{mobileTerminal.cwd}</p>
                <p>{terminalStatus(mobileTerminal, connectionOf(mobileTerminal.id))}</p>
                {mobileTerminal.live_session_id && (
                  <SessionLinks liveSessionId={mobileTerminal.live_session_id} />
                )}
                <TerminalCheckout key={mobileTerminal.id} terminal={mobileTerminal} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    data-testid="terminal-rename"
                    onClick={() => {
                      setOptionsOpen(false);
                      setRenaming(mobileTerminal);
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="outline"
                    data-testid="terminal-duplicate"
                    disabled={creating || !canDuplicate(mobileTerminal)}
                    onClick={() => {
                      setOptionsOpen(false);
                      void duplicateTerminal(mobileTerminal);
                    }}
                  >
                    Duplicate tab
                  </Button>
                </div>
                <Button
                  variant="outline"
                  data-testid="terminal-close-selected"
                  onClick={() => {
                    setOptionsOpen(false);
                    requestClose(mobileTerminal);
                  }}
                  aria-label={`Close ${mobileTerminal.name}`}
                  className="text-error"
                >
                  Close terminal
                </Button>
              </div>
            )}
            <div className="border-t border-surface-highest pt-3">{worktreeManager}</div>
          </SheetBody>
        </SheetContent>
      </Sheet>
      {renaming && (
        <RenameTerminal key={renaming.id} terminal={renaming} onClose={() => setRenaming(null)} />
      )}
      <ConfirmDialog
        open={closing !== null}
        title="Close terminal"
        description={`"${closing?.name ?? ""}" is still running. Closing it kills the process.`}
        confirmLabel="Close"
        onConfirm={() => closing && void closeTerminal(closing)}
        onCancel={() => setClosing(null)}
      />
    </div>
  );
}
