import { useQuery } from "@tanstack/react-query";
import { PanelBottom, PanelRight, SquareTerminal, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type LiveSession, type Terminal } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { SessionLaunchMenu } from "@/components/SessionLaunchMenu";
import { SessionTerminalActions } from "@/components/SessionTerminalActions";
import { ContinueInChat } from "@/components/terminals/ContinueInChat";
import { FilePanel } from "@/components/terminals/FilePanel";
import { GitPanelBody } from "@/components/terminals/GitPanel";
import { TerminalViewport } from "@/components/terminals/TerminalViewport";
import { TerminalWorkspace } from "@/components/terminals/TerminalWorkspace";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useChat } from "@/hooks/useChat";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { type SessionHomeNav, useSessionHome, WorkspaceSearchScope } from "@/hooks/useSessionHome";
import { type InspectorTab, sameSessionFolder } from "@/lib/session-home";
import { runningTerminalForSession } from "@/lib/terminal-links";
import { useTerminals } from "@/lib/terminals";
import { cn } from "@/lib/utils";

const iconButton =
  "inline-flex min-h-8 min-w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface aria-pressed:bg-surface-highest aria-pressed:text-on-surface max-sm:min-h-11 max-sm:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const reveal = "motion-safe:animate-in motion-safe:duration-150";

export interface SessionContext {
  terminal?: Terminal;
  cwd: string | null;
  host: string | null;
  session?: LiveSession;
  gitTerminal?: Terminal;
  shell?: Terminal;
}

export function useSessionContext(terminalId: string | null): SessionContext {
  const chat = useChat();
  const { terminals } = useTerminals();
  const live = useQuery({
    queryKey: ["session-workspace-context"],
    queryFn: () => api.sessions.live({ active: false, limit: 5000 }),
    enabled: !!terminalId || !!chat.thread?.runtimeId,
  });
  const terminal = terminalId ? terminals.find((item) => item.id === terminalId) : undefined;
  const cwd = terminal ? terminal.cwd : (chat.thread?.cwd ?? chat.workspace?.cwd ?? null);
  const host = terminal ? terminal.host : (chat.thread?.host ?? chat.workspace?.host ?? null);
  const liveId = terminal ? terminal.live_session_id : (chat.thread?.sourceId ?? null);
  const session = live.data?.sessions.find((item) =>
    liveId
      ? item.id === liveId
      : item.session_id === chat.thread?.runtimeId &&
        item.agent === chat.config.agent &&
        item.host === chat.thread?.host,
  );
  const sameFolder = (item: Terminal) =>
    item.status === "running" && sameSessionFolder(item.cwd, cwd) && (item.host ?? null) === host;
  return {
    terminal,
    cwd,
    host,
    session,
    gitTerminal: terminal?.status === "running" ? terminal : terminals.find(sameFolder),
    shell: terminals.find(
      (item) => sameFolder(item) && item.kind === "shell" && item.id !== terminal?.id,
    ),
  };
}

/** Opens a `sessionLive` link: in its running terminal when there is one, else resumed as chat. */
export function useSessionLiveLink(home: SessionHomeNav, enabled: boolean) {
  const { terminals, isLoading } = useTerminals();
  const chat = useChat();
  const { openThread } = chat;
  const opening = useRef<string | null>(null);
  const [error, setError] = useState("");
  const { liveId, go } = home;
  useEffect(() => {
    if (!enabled || !liveId || isLoading || opening.current === liveId) return;
    opening.current = liveId;
    setError("");
    const terminal = runningTerminalForSession(terminals, liveId);
    if (terminal) {
      go({ terminalId: terminal.id, liveId: null }, { replace: true });
      opening.current = null;
      return;
    }
    api.chat
      .resume(liveId)
      .then((thread) => openThread(thread))
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Session could not be opened."),
      )
      .finally(() => {
        opening.current = null;
        go({ terminalId: null, liveId: null }, { replace: true });
      });
  }, [enabled, liveId, isLoading, terminals, go, openThread]);
  return error;
}

export function SessionHomeToggles({ home }: { home: SessionHomeNav }) {
  return (
    <>
      <ActionHelp label={home.drawer ? "Hide terminal" : "Show terminal"}>
        <button
          type="button"
          data-testid="session-drawer-toggle"
          aria-label={home.drawer ? "Hide terminal" : "Show terminal"}
          aria-pressed={home.drawer}
          className={iconButton}
          onClick={() => home.go({ drawer: !home.drawer })}
        >
          <PanelBottom size={17} />
        </button>
      </ActionHelp>
      <ActionHelp label={home.inspector ? "Hide inspector" : "Show inspector"}>
        <button
          type="button"
          data-testid="session-inspector-toggle"
          aria-label={home.inspector ? "Hide inspector" : "Show inspector"}
          aria-pressed={!!home.inspector}
          className={iconButton}
          onClick={() => home.go({ inspector: home.inspector ? null : "overview" })}
        >
          <PanelRight size={17} />
        </button>
      </ActionHelp>
    </>
  );
}

export function SessionTerminalCenter({ context }: { context: SessionContext }) {
  const home = useSessionHome();
  const { isLoading, terminals } = useTerminals();
  const terminal = context.terminal;
  if (terminal?.status !== "running")
    return (
      <div
        data-testid="session-terminal-missing"
        className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground"
      >
        {isLoading ? "Loading terminal…" : "This terminal is no longer running."}
      </div>
    );
  return (
    <div data-testid="session-terminal" className="flex min-h-0 flex-1 flex-col">
      <TerminalWorkspace
        onActivate={home.activate}
        selected={terminal}
        terminals={terminals}
        storageKey={`orc_session_layout_${terminal.id}`}
        renderTerminal={(id) => <TerminalViewport terminalId={id} />}
        renderActions={(item) =>
          item.id === terminal.id ? null : <ContinueInChat terminal={item} inWorkspace />
        }
        renderOptions={(item) => <SessionTerminalActions terminal={item} />}
      />
    </div>
  );
}

export function SessionDrawer({ context }: { context: SessionContext }) {
  const { create } = useTerminals();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const height = usePanelWidth({
    storageKey: "orc_session_drawer_height",
    initial: 240,
    min: 120,
    max: 560,
    edge: "top",
  });
  const open = async () => {
    setPending(true);
    setError("");
    try {
      await create({
        kind: "shell",
        ...(context.cwd ? { cwd: context.cwd } : {}),
        host: context.host,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Terminal could not be opened.");
    } finally {
      setPending(false);
    }
  };
  return (
    <section
      data-testid="session-drawer"
      aria-label="Terminal"
      style={{ height: height.width }}
      className={cn(
        "relative flex shrink-0 flex-col border-t border-border bg-background",
        reveal,
        "motion-safe:slide-in-from-bottom-4",
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: pointer-driven splitter has no native element */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuenow={height.width}
        aria-valuemin={120}
        aria-valuemax={560}
        tabIndex={0}
        data-testid="session-drawer-resize"
        title="Drag to resize, use arrow keys, or double-click to reset"
        className="absolute inset-x-0 -top-1 z-20 h-2 cursor-row-resize touch-none hover:bg-surface-highest focus-visible:bg-focus"
        {...height.handleProps}
      />
      {context.shell ? (
        <TerminalViewport terminalId={context.shell.id} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
          <p>
            {context.cwd ? `No terminal open in ${context.cwd}.` : "No folder for this session."}
          </p>
          <Button
            variant="outline"
            data-testid="session-drawer-open"
            disabled={pending}
            onClick={() => void open()}
          >
            <SquareTerminal size={16} />
            Open terminal
          </Button>
          {error && (
            <p role="alert" className="text-error">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Overview({ context }: { context: SessionContext }) {
  const git = context.gitTerminal;
  const status = useQuery({
    queryKey: ["git", git?.id, "status"],
    queryFn: () => api.git.status(git?.id ?? ""),
    enabled: !!git,
  });
  const github = useQuery({
    queryKey: ["git", git?.id, "github", status.data?.branch],
    queryFn: () => api.git.checkoutGithub(git?.id ?? ""),
    enabled: !!git && !!status.data?.root,
    staleTime: 60_000,
  });
  const branch = status.data?.branch;
  const pr = branch
    ? github.data?.items.find((item) => item.kind === "pr" && item.branch === branch)
    : undefined;
  const task = context.session?.task;
  const changes = status.data?.files.length;
  return (
    <dl data-testid="session-inspector-overview" className="space-y-3 text-sm">
      <OverviewRow label="Host">{context.host ?? "local"}</OverviewRow>
      <OverviewRow label="Folder">{context.cwd}</OverviewRow>
      <OverviewRow label="Branch">{branch}</OverviewRow>
      <OverviewRow label="Changes">
        {changes === undefined ? null : `${changes} ${changes === 1 ? "file" : "files"}`}
      </OverviewRow>
      <OverviewRow label="Task">
        {task && (
          <Link className="text-primary hover:underline" to={`/tasks/${task.id}`}>
            {task.title}
          </Link>
        )}
      </OverviewRow>
      <OverviewRow label="Pull request">
        {pr && (
          <a
            className="text-primary hover:underline"
            href={pr.url}
            target="_blank"
            rel="noreferrer"
          >
            #{pr.number} {pr.title}
          </a>
        )}
      </OverviewRow>
    </dl>
  );
}

function OverviewRow({ label, children }: { label: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <div data-testid={`session-inspector-${label.toLowerCase().replace(" ", "-")}`}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function InspectorBody({
  context,
  tab,
  home,
}: {
  context: SessionContext;
  tab: InspectorTab;
  home: SessionHomeNav;
}) {
  const git = context.gitTerminal;
  const { create } = useTerminals();
  const requested = useRef<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const cwd = context.cwd;
  const host = context.host;
  const connect = async () => {
    if (!cwd || connecting) return;
    setConnecting(true);
    setError("");
    try {
      await create({ kind: "shell", cwd, host });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect checkout tools.");
    } finally {
      setConnecting(false);
    }
  };
  useEffect(() => {
    if (tab === "overview" || tab === "worktrees" || git || !cwd) return;
    const key = JSON.stringify([host, cwd]);
    if (requested.current === key) return;
    requested.current = key;
    setConnecting(true);
    setError("");
    void create({ kind: "shell", cwd, host })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Could not connect checkout tools.");
      })
      .finally(() => setConnecting(false));
  }, [tab, git, cwd, host, create]);
  const tabs: [InspectorTab, string][] = [
    ["overview", "Overview"],
    ["diff", "Diff"],
    ["files", "Files"],
    ["worktrees", "Worktrees"],
  ];
  const shown = tab;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tabs.length > 1 && (
        <div
          role="tablist"
          aria-label="Inspector"
          className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-2"
        >
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              data-testid={`session-inspector-tab-${id}`}
              aria-selected={shown === id}
              onClick={() => home.go({ inspector: id }, { replace: true })}
              className={cn(
                "min-h-8 shrink-0 rounded-md px-3 text-sm max-sm:min-h-11 pointer-coarse:min-h-11",
                shown === id
                  ? "bg-surface-highest text-on-surface"
                  : "text-outline hover:bg-surface hover:text-on-surface",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        {shown === "files" && git ? (
          <WorkspaceSearchScope prefix="inspector">
            <FilePanel terminal={git} active paneId="session-inspector" />
          </WorkspaceSearchScope>
        ) : shown === "worktrees" ? (
          <SessionLaunchMenu worktrees />
        ) : shown === "diff" && git ? (
          <WorkspaceSearchScope prefix="inspector">
            <GitPanelBody terminal={git} paneId="session-inspector" />
          </WorkspaceSearchScope>
        ) : shown !== "overview" ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              {connecting
                ? "Connecting checkout tools…"
                : cwd
                  ? "Checkout tools are unavailable."
                  : "Choose a session folder to inspect files and changes."}
            </p>
            {error && (
              <p role="alert" className="text-error">
                {error}
              </p>
            )}
            {cwd && !connecting && (
              <Button variant="outline" onClick={() => void connect()}>
                Retry checkout connection
              </Button>
            )}
          </div>
        ) : (
          <Overview context={context} />
        )}
      </div>
    </div>
  );
}

export function SessionInspector({
  context,
  home,
  narrow,
}: {
  context: SessionContext;
  home: SessionHomeNav;
  narrow: boolean;
}) {
  const panel = usePanelWidth({
    storageKey: "orc_session_inspector_width",
    initial: 320,
    min: 260,
    max: 720,
    edge: "left",
  });
  const tab = home.inspector ?? "overview";
  const close = () => home.go({ inspector: null });
  if (narrow)
    return (
      <Sheet open={!!home.inspector} onOpenChange={(open) => !open && close()}>
        <SheetContent
          data-testid="session-inspector"
          aria-describedby={undefined}
          resizeKey="session-inspector"
          defaultWidth={360}
        >
          <SheetHeader>
            <SheetTitle>Inspector</SheetTitle>
          </SheetHeader>
          <SheetBody className="flex min-h-0 flex-1 flex-col p-0 pt-2">
            <InspectorBody context={context} tab={tab} home={home} />
          </SheetBody>
        </SheetContent>
      </Sheet>
    );
  if (!home.inspector) return null;
  return (
    <aside
      data-testid="session-inspector"
      aria-label="Inspector"
      style={{ width: panel.width, maxWidth: "45%" }}
      className={cn(
        "relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background pt-2",
        reveal,
        "motion-safe:slide-in-from-right-4",
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: pointer-driven splitter has no native element */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        aria-valuenow={panel.width}
        aria-valuemin={260}
        aria-valuemax={720}
        tabIndex={0}
        data-testid="session-inspector-resize"
        title="Drag to resize, use arrow keys, or double-click to reset"
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize touch-none hover:bg-surface-highest focus-visible:bg-focus"
        {...panel.handleProps}
      />
      <div className="flex min-h-10 items-center px-3">
        <h2 className="flex-1 text-sm font-medium">Inspector</h2>
        <button type="button" aria-label="Close inspector" className={iconButton} onClick={close}>
          <X size={16} />
        </button>
      </div>
      <InspectorBody context={context} tab={tab} home={home} />
    </aside>
  );
}
