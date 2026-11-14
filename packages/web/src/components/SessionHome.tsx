import { PanelBottom, PanelRight, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type LiveSession, type Terminal } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { InspectorOverview } from "@/components/inspector/InspectorOverview";
import { InspectorTabs } from "@/components/inspector/InspectorTabs";
import { FilePanel } from "@/components/terminals/FilePanel";
import { GitPanelBody } from "@/components/terminals/GitPanel";
import { TerminalViewport } from "@/components/terminals/TerminalViewport";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useActiveLiveSessions } from "@/hooks/useActiveLiveSessions";
import { useChat } from "@/hooks/useChat";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { INSPECTOR_PANE_ID, type InspectorTab } from "@/lib/session-home";
import {
  runningTerminalForFolder,
  runningTerminalForSession,
  terminalInFolder,
} from "@/lib/terminal-links";
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
  const live = useActiveLiveSessions();
  const terminal = terminalId ? terminals.find((item) => item.id === terminalId) : undefined;
  const cwd = terminal ? terminal.cwd : (chat.thread?.cwd ?? null);
  const host = terminal ? terminal.host : (chat.thread?.host ?? null);
  const liveId = terminal ? terminal.live_session_id : (chat.thread?.sourceId ?? null);
  const session = liveId ? live.data?.find((item) => item.id === liveId) : undefined;
  const sameFolder = (item: Terminal) => terminalInFolder(item, cwd, host);
  return {
    terminal,
    cwd,
    host,
    session,
    gitTerminal:
      terminal?.status === "running" ? terminal : runningTerminalForFolder(terminals, cwd, host),
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

export function SessionHomeToggles({
  home,
  gestures = false,
}: {
  home: SessionHomeNav;
  /** Phone: explain the equivalent touch gesture beside each toggle. */
  gestures?: boolean;
}) {
  return (
    <>
      <ActionHelp
        label={home.drawer ? "Hide terminal" : "Show terminal"}
        description={gestures ? "Or pull down on the chat header" : undefined}
      >
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
      <ActionHelp
        label={home.inspector ? "Hide inspector" : "Show inspector"}
        description={
          gestures
            ? "Git, changes, pull requests and files. Or swipe right from the left edge"
            : undefined
        }
      >
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
  const { isLoading } = useTerminals();
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
      <TerminalViewport terminalId={terminal.id} />
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
  const shown: InspectorTab = tab !== "overview" && git ? tab : "overview";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <InspectorTabs
        git={!!git}
        shown={shown}
        onSelect={(next) => home.go({ inspector: next }, { replace: true })}
        className="px-3 pb-2"
      />
      {shown === "overview" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <InspectorOverview context={context} home={home} />
        </div>
      ) : (
        // Container host: the git and files panels follow the inspector width,
        // the same compact layout the phone page and preview panel use.
        <div className="inspector-host flex min-h-0 flex-1 flex-col">
          {shown === "diff" && git && (
            <GitPanelBody terminal={git} paneId={INSPECTOR_PANE_ID} persistDraft />
          )}
          {shown === "files" && git && (
            <FilePanel terminal={git} paneId={INSPECTOR_PANE_ID} active />
          )}
        </div>
      )}
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
