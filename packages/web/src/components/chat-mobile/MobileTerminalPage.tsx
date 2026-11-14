import { ChevronUp, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionContext } from "@/components/SessionHome";
import { TerminalViewport } from "@/components/terminals/TerminalViewport";
import { Button } from "@/components/ui/button";
import type { SessionHomeNav } from "@/hooks/useSessionHome";
import { useTerminals } from "@/lib/terminals";

/** The phone Terminal page: pulls down over the chat, keeps the PTY mounted
 *  while open, and closes with the button, Escape or an upward swipe. */
export function MobileTerminalPage({
  context,
  home,
}: {
  context: SessionContext;
  home: SessionHomeNav;
}) {
  const { create } = useTerminals();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLElement>(null);
  const close = () => home.go({ drawer: false });
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus and Escape bind once when the page opens
  useEffect(() => {
    root.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      // A terminal canvas consumes Escape for the PTY; only close when unhandled.
      if (event.key === "Escape" && !event.defaultPrevented) home.go({ drawer: false });
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.querySelector<HTMLElement>('[data-testid="session-drawer-toggle"]')?.focus();
    };
  }, []);
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
  const terminal = context.shell;
  return (
    <section
      ref={root}
      tabIndex={-1}
      data-testid="session-drawer"
      aria-label="Terminal"
      className="absolute inset-0 z-30 flex flex-col bg-background outline-none"
    >
      <header
        data-chat-gesture-header
        className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2"
      >
        <button
          type="button"
          aria-label="Close terminal"
          data-testid="session-drawer-close"
          onClick={close}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface hover:text-on-surface"
        >
          <ChevronUp size={20} />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate text-base font-medium leading-tight">
            {terminal?.name ?? "Terminal"}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {context.cwd ?? "No folder"}
            {context.host ? ` · ${context.host}` : ""}
          </p>
        </div>
        <SquareTerminal
          size={16}
          className="mr-2 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </header>
      {terminal ? (
        <div className="flex min-h-0 flex-1 flex-col" data-swipe-ignore>
          <TerminalViewport terminalId={terminal.id} />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
          <SquareTerminal size={24} aria-hidden="true" />
          <p>
            {context.cwd ? `No terminal open in ${context.cwd}.` : "No folder for this session."}
          </p>
          <Button
            variant="outline"
            data-testid="session-drawer-open"
            disabled={pending}
            onClick={() => void open()}
            className="min-h-11"
          >
            <SquareTerminal size={16} />
            {pending ? "Opening…" : "Open terminal"}
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
