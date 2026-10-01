import { X } from "lucide-react";
import { Link } from "react-router-dom";
import type { Terminal } from "@/api/client";
import { cwdTail, TERMINAL_KINDS } from "@/lib/terminal-kinds";
import { cn } from "@/lib/utils";

interface TerminalListProps {
  terminals: Terminal[];
  activeId: string | null;
  onClose: (terminal: Terminal) => void;
}

export function TerminalList({ terminals, activeId, onClose }: TerminalListProps) {
  return (
    <div data-testid="terminals-list" className="flex-1 min-h-0 overflow-y-auto">
      {terminals.map((terminal) => {
        const active = terminal.id === activeId;
        const { label, icon: Icon } = TERMINAL_KINDS[terminal.kind];
        const tail = cwdTail(terminal.cwd);
        return (
          <div
            key={terminal.id}
            data-testid="terminal-item"
            data-status={terminal.status}
            data-active={active}
            className={cn(
              "flex items-center gap-2 px-3 py-2 transition-colors",
              active
                ? "bg-surface-highest border-r-2 border-primary"
                : "hover:bg-surface-highest/50",
            )}
          >
            <span
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                terminal.status === "running" ? "bg-secondary" : "bg-outline",
              )}
              title={terminal.status}
            />
            <Link to={`/terminals/${terminal.id}`} className="flex-1 min-w-0">
              <div
                className={cn(
                  "truncate font-body text-xs",
                  active ? "text-primary font-semibold" : "text-on-surface",
                )}
              >
                {terminal.name}
              </div>
              <div className="flex items-center gap-1 font-label text-[10px] uppercase tracking-widest text-outline min-w-0">
                <Icon size={10} className="shrink-0" />
                <span className="shrink-0">{label}</span>
                {tail && <span className="truncate normal-case tracking-normal">{tail}</span>}
              </div>
            </Link>
            <button
              type="button"
              aria-label={`Close ${terminal.name}`}
              title="Close"
              onClick={() => onClose(terminal)}
              className="shrink-0 p-1 rounded-sm text-outline hover:text-error hover:bg-error/10"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
