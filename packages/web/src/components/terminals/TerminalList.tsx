import { X } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import type { Terminal } from "@/api/client";
import { cwdTail, TERMINAL_KINDS } from "@/lib/terminal-kinds";
import { cn } from "@/lib/utils";

interface TerminalListProps {
  terminals: Terminal[];
  activeId: string | null;
  onClose: (terminal: Terminal) => void;
}

export function TerminalList({ terminals, activeId, onClose }: TerminalListProps) {
  const [params] = useSearchParams();
  return (
    <div data-testid="terminals-list" className="flex-1 min-h-0 overflow-y-auto">
      {terminals.map((terminal) => {
        const active = terminal.id === activeId;
        const { label, icon: Icon } = TERMINAL_KINDS[terminal.kind];
        const tail = cwdTail(terminal.cwd);
        const next = new URLSearchParams(params);
        next.delete("file");
        next.delete("session");
        if (next.has("view")) next.set("paneTerminal", terminal.id);
        return (
          <div
            key={terminal.id}
            data-testid="terminal-item"
            data-status={terminal.status}
            data-active={active}
            className={cn(
              "flex items-center gap-2 px-3 py-2 transition-colors",
              active ? "bg-surface-highest" : "hover:bg-surface",
            )}
          >
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                terminal.status === "running" ? "bg-secondary" : "bg-outline",
              )}
              title={terminal.status}
            />
            <Link
              to={{ pathname: `/terminals/${terminal.id}`, search: next.toString() }}
              className="flex-1 min-w-0"
            >
              <div
                className={cn(
                  "truncate font-body text-xs",
                  active ? "text-on-surface font-medium" : "text-on-surface",
                )}
              >
                {terminal.name}
              </div>
              <div className="flex items-center gap-1 font-label text-xs text-on-surface-variant min-w-0">
                <Icon size={10} className="shrink-0" />
                <span className="shrink-0">{label}</span>
                {terminal.host && (
                  <span
                    data-testid="terminal-item-host"
                    className="shrink-0 normal-case tracking-normal text-primary"
                  >
                    @{terminal.host}
                  </span>
                )}
                {tail && <span className="truncate normal-case tracking-normal">{tail}</span>}
              </div>
            </Link>
            <button
              type="button"
              aria-label={`Close ${terminal.name}`}
              title="Close"
              onClick={() => onClose(terminal)}
              className="shrink-0 min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center p-1 rounded-md text-on-surface-variant hover:text-error hover:bg-error/10"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
