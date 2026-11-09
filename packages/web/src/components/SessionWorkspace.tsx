import { Maximize2, Menu, MessagesSquare, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { ChatPanel } from "@/components/ChatPanel";
import { TerminalWorkspaceGroup } from "@/components/terminals/TerminalWorkspaceGroup";
import { Button } from "@/components/ui/button";
import { ChatPaneProvider, useChat } from "@/hooks/useChat";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { SessionPaneNavigation } from "@/hooks/useSessionHome";
import { swapSessionPanes } from "@/lib/session-home";
import { useTerminals } from "@/lib/terminals";
import { cn } from "@/lib/utils";

export function SessionWorkspace({
  onToggle,
  onClose,
  onToggleFullscreen,
  onOpenNavigation,
}: {
  onToggle: () => void;
  onClose: () => void;
  onToggleFullscreen: () => void;
  onOpenNavigation: () => void;
}) {
  const chat = useChat();
  const { terminals } = useTerminals();
  const [params, setParams] = useSearchParams();
  const parallel = params.get("parallel") === "1";
  const [secondary, setSecondary] = useState<string | null>(() => params.get("parallelDraft"));
  const phonePane = params.get("sessionPane") === "secondary" ? 1 : 0;
  function setPhonePane(index: number): void {
    const next = new URLSearchParams(window.location.search);
    if (index === 1) next.set("sessionPane", "secondary");
    else next.delete("sessionPane");
    if (next.toString() !== new URLSearchParams(window.location.search).toString()) setParams(next);
  }
  const desktop = useBreakpoint("lg");
  const [error, setError] = useState("");
  const linked = params.get("parallelchatThread");
  const handledLink = useRef<string | null>(null);
  const expanding = useRef(false);
  const { openBackgroundThread } = chat;
  useEffect(() => {
    if (!parallel || expanding.current || !linked || handledLink.current === linked) return;
    let cancelled = false;
    void api.chat
      .get(linked)
      .then((thread) => {
        if (!cancelled) {
          handledLink.current = linked;
          setSecondary(openBackgroundThread(thread));
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Could not open parallel session.");
      });
    return () => {
      cancelled = true;
    };
  }, [parallel, linked, openBackgroundThread]);
  const secondaryTab = chat.tabs.find((tab) => tab.key === secondary);
  const previousPrimary = useRef(chat.activeKey);
  useEffect(() => {
    if (secondary === chat.activeKey && previousPrimary.current !== chat.activeKey)
      setSecondary(previousPrimary.current);
    previousPrimary.current = chat.activeKey;
  }, [secondary, chat.activeKey]);
  const selectPrimary = useCallback(
    (key: string) => {
      if (key === secondary) setSecondary(chat.activeKey);
      chat.selectTab(key);
    },
    [chat.activeKey, chat.selectTab, secondary],
  );
  const selectSecondary = useCallback(
    (key: string) => {
      if (key === chat.activeKey && secondary) chat.selectTab(secondary);
      setSecondary(key);
    },
    [chat.activeKey, chat.selectTab, secondary],
  );
  useEffect(() => {
    if (!parallel || (linked && !secondaryTab && !error)) return;
    if (!secondaryTab || secondaryTab.hidden) {
      const other = chat.tabs
        .filter(
          (tab) =>
            tab.key !== chat.activeKey &&
            !tab.hidden &&
            (tab.thread ||
              tab.draft.trim() ||
              tab.files.length ||
              tab.streaming ||
              tab.queued.length),
        )
        .sort(
          (left, right) =>
            (right.thread?.updatedAt ?? right.createdAt ?? 0) -
            (left.thread?.updatedAt ?? left.createdAt ?? 0),
        )[0];
      setSecondary(other?.key ?? chat.newTab({ activate: false, fresh: true }));
    }
  }, [parallel, secondaryTab, chat.tabs, chat.activeKey, chat.newTab, linked, error]);
  useEffect(() => {
    if (!parallel || expanding.current || !secondaryTab) return;
    const threadId = secondaryTab.thread?.id ?? null;
    if (linked === threadId && params.get("parallelDraft") === secondaryTab.key) return;
    handledLink.current = threadId;
    setParams(
      () => {
        const next = new URLSearchParams(window.location.search);
        next.set("parallelDraft", secondaryTab.key);
        if (threadId) next.set("parallelchatThread", threadId);
        else next.delete("parallelchatThread");
        return next;
      },
      { replace: true },
    );
  }, [parallel, secondaryTab, linked, setParams, params]);
  function toggle(): void {
    if (!parallel) expanding.current = false;
    if (parallel && !desktop && phonePane === 1 && secondaryTab) {
      expandSecondary();
      return;
    }
    setParams(() => {
      const next = new URLSearchParams(window.location.search);
      if (parallel) next.delete("parallel");
      else next.set("parallel", "1");
      next.delete("sessionPane");
      return next;
    });
  }
  function expandSecondary(): void {
    if (!secondaryTab) return;
    expanding.current = true;
    const oldPrimary = chat.activeKey;
    chat.selectTab(secondaryTab.key);
    setSecondary(oldPrimary);
    setParams(() => {
      const next = swapSessionPanes(new URLSearchParams(window.location.search));
      next.delete("parallel");
      next.delete("sessionPane");
      next.set("parallelDraft", oldPrimary);
      if (secondaryTab.thread) next.set("chatThread", secondaryTab.thread.id);
      else next.delete("chatThread");
      return next;
    });
  }
  const names = [
    terminals.find((terminal) => terminal.id === params.get("sessionTerminal"))?.name ??
      chat.thread?.title ??
      "New session",
    terminals.find((terminal) => terminal.id === params.get("parallelsessionTerminal"))?.name ??
      secondaryTab?.thread?.title ??
      "New session",
  ];
  const parallelButton = (
    <Button
      variant="ghost"
      size="icon"
      aria-label={parallel ? "Close parallel pane" : "Show parallel sessions"}
      data-testid="workspace-parallel"
      aria-pressed={parallel}
      onClick={toggle}
    >
      {parallel ? <X size={17} /> : <MessagesSquare size={17} />}
    </Button>
  );
  return (
    <div data-testid="unified-session-workspace" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {!desktop && (
        <div className="flex min-h-11 shrink-0 items-center justify-end gap-1 border-b border-border px-2">
          <Button
            variant="ghost"
            size="icon"
            className="mr-auto md:hidden"
            aria-label="Open navigation"
            onClick={onOpenNavigation}
          >
            <Menu size={17} />
          </Button>
          {parallel && (
            <nav
              aria-label="Parallel sessions"
              className="mr-auto flex min-w-0 overflow-x-auto lg:hidden"
            >
              {names.map((name, index) => (
                <Button
                  key={index === 0 ? "primary" : "secondary"}
                  variant="ghost"
                  aria-current={phonePane === index ? "page" : undefined}
                  onClick={() => setPhonePane(index)}
                  className="min-w-0 max-w-40 truncate"
                  data-testid={`parallel-tab-${index}`}
                >
                  <span className="truncate">{name}</span>
                </Button>
              ))}
            </nav>
          )}
          {parallel && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Expand selected session"
              className="lg:hidden"
              onClick={() => {
                if (phonePane === 1) expandSecondary();
                else toggle();
              }}
            >
              <Maximize2 size={17} />
            </Button>
          )}
          {parallelButton}
        </div>
      )}
      {error && (
        <p role="alert" className="px-4 text-sm text-error">
          {error}
        </p>
      )}
      <TerminalWorkspaceGroup>
        <div className="flex min-h-0 min-w-0 flex-1">
          <div
            data-testid="session-primary-pane"
            className={cn(
              "min-h-0 min-w-0 flex-1",
              parallel && phonePane === 1 ? "hidden lg:flex" : "flex",
            )}
          >
            <ChatPaneProvider
              tabKey={chat.activeKey}
              onSelect={selectPrimary}
              visible={!parallel || desktop || phonePane === 0}
            >
              <ChatPanel
                open
                embedded
                fullscreen
                compactPane={parallel}
                workspaceActions={desktop ? parallelButton : undefined}
                visible={!parallel || desktop || phonePane === 0}
                onToggle={onToggle}
                onClose={onClose}
                onToggleFullscreen={onToggleFullscreen}
              />
            </ChatPaneProvider>
          </div>
          {parallel && secondaryTab && (
            <div
              data-testid="session-secondary-pane"
              className={cn(
                "relative min-h-0 min-w-0 flex-1 border-l border-border",
                phonePane === 0 ? "hidden lg:flex" : "flex",
              )}
            >
              <SessionPaneNavigation prefix="parallel">
                <ChatPaneProvider
                  tabKey={secondaryTab.key}
                  onSelect={selectSecondary}
                  visible={desktop || phonePane === 1}
                >
                  <ChatPanel
                    open
                    embedded
                    fullscreen
                    compactPane
                    visible={desktop || phonePane === 1}
                    onToggle={toggle}
                    onClose={toggle}
                    onToggleFullscreen={expandSecondary}
                  />
                </ChatPaneProvider>
              </SessionPaneNavigation>
            </div>
          )}
        </div>
      </TerminalWorkspaceGroup>
    </div>
  );
}
