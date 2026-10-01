import { Square, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import type { Terminal, TerminalKind } from "@/api/client";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorState } from "@/components/ErrorState";
import { NewTerminalMenu } from "@/components/terminals/NewTerminalMenu";
import { TerminalList } from "@/components/terminals/TerminalList";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { TERMINAL_KINDS } from "@/lib/terminal-kinds";
import type { ConnectionState } from "@/lib/terminal-runtime";
import { useTerminals } from "@/lib/terminals";
import { cn } from "@/lib/utils";

const gitPanel: ReactNode = null;

function describeStatus(terminal: Terminal, connection: ConnectionState | undefined): string {
  if (terminal.status === "exited") {
    return terminal.exit_code == null ? "exited" : `exited (code ${terminal.exit_code})`;
  }
  if (connection === "connecting") return "connecting";
  if (connection === "reconnecting") return "reconnecting";
  if (connection === "closed") return "disconnected";
  return "running";
}

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
    <div
      ref={ref}
      data-testid="terminal-viewport"
      className="relative flex-1 min-h-0 min-w-0 bg-background"
    >
      {engineError && (
        <p
          role="alert"
          className="absolute inset-0 flex items-center justify-center p-4 text-error font-label text-xs uppercase tracking-widest text-center"
        >
          Terminal renderer failed to load: {engineError}
        </p>
      )}
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex-1 min-h-0 flex items-center justify-center p-6">{children}</div>;
}

export default function Terminals() {
  const { terminalId } = useParams();
  const navigate = useNavigate();
  const {
    terminals,
    info,
    isLoading,
    error,
    refetch,
    lastActiveId,
    connectionOf,
    create,
    stop,
    remove,
  } = useTerminals();
  const isDesktop = useBreakpoint("md");

  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [closing, setClosing] = useState<Terminal | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCreate = useCallback(
    async (kind: TerminalKind, cwd: string) => {
      setCreating(true);
      setCreateError(null);
      try {
        const terminal = await create({ kind, ...(cwd ? { cwd } : {}) });
        setMenuOpen(false);
        navigate(`/terminals/${terminal.id}`);
      } catch (e) {
        setCreateError(e instanceof Error ? e.message : String(e));
      } finally {
        setCreating(false);
      }
    },
    [create, navigate],
  );

  const closeTerminal = useCallback(
    async (terminal: Terminal) => {
      setActionError(null);
      try {
        await remove(terminal.id);
        setClosing(null);
        if (terminal.id === terminalId) {
          const next = terminals.find((t) => t.id !== terminal.id);
          navigate(next ? `/terminals/${next.id}` : "/terminals", { replace: true });
        }
      } catch (e) {
        setClosing(null);
        setActionError(e instanceof Error ? e.message : String(e));
      }
    },
    [remove, terminalId, terminals, navigate],
  );

  const requestClose = useCallback(
    (terminal: Terminal) => {
      if (terminal.status === "running") setClosing(terminal);
      else void closeTerminal(terminal);
    },
    [closeTerminal],
  );

  if (error && !info) {
    return (
      <Centered>
        <ErrorState message={error.message} onRetry={refetch} />
      </Centered>
    );
  }

  if (isLoading || !info) {
    return (
      <Centered>
        <Skeleton className="h-40 w-full max-w-md" />
      </Centered>
    );
  }

  if (!info.ready) {
    return (
      <Centered>
        <div className="max-w-md space-y-3 text-center">
          <h2 className="font-headline text-sm uppercase tracking-widest text-on-surface">
            Terminals are not available
          </h2>
          <p className="font-body text-sm text-on-surface-variant">
            {info.reason ?? "The API has not enabled terminals."}
          </p>
          <p className="font-body text-xs text-outline">
            Enable with <code className="text-primary">ORC_TERMINALS_ENABLED=1</code> (or{" "}
            <code className="text-primary">terminals.enabled</code> in the config) and set an API
            secret, then restart the API.
          </p>
        </div>
      </Centered>
    );
  }

  if (!terminalId && terminals.length > 0) {
    const preferred = terminals.find((t) => t.id === lastActiveId) ?? terminals[0];
    return <Navigate to={`/terminals/${preferred.id}`} replace />;
  }

  const selected = terminalId ? terminals.find((t) => t.id === terminalId) : undefined;
  const newMenu = (
    <NewTerminalMenu
      open={menuOpen}
      onOpenChange={setMenuOpen}
      launchers={info.launchers}
      pending={creating}
      error={createError}
      onCreate={handleCreate}
    />
  );

  return (
    <div className="flex h-full w-full min-h-0">
      {isDesktop && (
        <aside className="w-60 shrink-0 flex flex-col min-h-0 border-r border-surface-highest bg-background">
          <div className="shrink-0 p-3">{newMenu}</div>
          <TerminalList
            terminals={terminals}
            activeId={terminalId ?? null}
            onClose={requestClose}
          />
        </aside>
      )}

      <section className="flex-1 min-w-0 min-h-0 flex flex-col">
        {!isDesktop && (
          <div className="shrink-0 flex items-center gap-2 p-2 border-b border-surface-highest">
            <select
              aria-label="Terminal"
              value={selected?.id ?? ""}
              onChange={(e) => navigate(`/terminals/${e.target.value}`)}
              disabled={terminals.length === 0}
              className="flex-1 min-w-0 bg-surface-highest/50 border border-surface-highest text-on-surface font-label text-[11px] px-2 py-2 rounded-sm"
            >
              {terminals.length === 0 && <option value="">No terminals</option>}
              {terminals.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <div className="shrink-0 w-36">{newMenu}</div>
          </div>
        )}

        {selected ? (
          <>
            <header className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-surface-highest min-w-0">
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  selected.status === "running" ? "bg-secondary" : "bg-outline",
                )}
              />
              <div className="flex-1 min-w-0">
                <div className="truncate font-body text-sm text-on-surface">{selected.name}</div>
                <div className="truncate font-label text-[10px] uppercase tracking-widest text-outline">
                  {TERMINAL_KINDS[selected.kind].label}
                  {selected.cwd && (
                    <span className="normal-case tracking-normal"> · {selected.cwd}</span>
                  )}
                  <span> · {describeStatus(selected, connectionOf(selected.id))}</span>
                </div>
              </div>
              {actionError && (
                <span
                  role="alert"
                  className="hidden sm:block truncate max-w-xs font-body text-xs text-error"
                >
                  {actionError}
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="terminal-stop"
                disabled={selected.status !== "running"}
                onClick={() => stop(selected.id)}
                className="h-8 gap-1 font-label text-xs uppercase text-tertiary hover:text-tertiary"
              >
                <Square size={12} />
                Stop
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="terminal-close"
                onClick={() => requestClose(selected)}
                className="h-8 gap-1 font-label text-xs uppercase text-outline hover:text-error"
              >
                <X size={12} />
                Close
              </Button>
            </header>
            <TerminalViewport terminalId={selected.id} />
          </>
        ) : (
          <Centered>
            <div className="text-center space-y-3">
              <p className="font-label text-xs uppercase tracking-widest text-outline">
                {terminalId ? "Terminal not found" : "No terminals yet"}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => (terminalId ? navigate("/terminals") : setMenuOpen(true))}
                className="font-label text-xs uppercase"
              >
                {terminalId ? "Back to terminals" : "Start a terminal"}
              </Button>
            </div>
          </Centered>
        )}
      </section>

      {gitPanel}

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
