import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Terminal } from "@/api/client";
import { cwdTail, TERMINAL_KINDS } from "@/lib/terminal-kinds";
import { filterTerminals, terminalStatus } from "@/lib/terminal-presentation";
import type { ConnectionState } from "@/lib/terminal-runtime";
import { cn } from "@/lib/utils";
import { TerminalActions } from "./TerminalActions";

interface TerminalListProps {
  terminals: Terminal[];
  activeId: string | null;
  onClose: (terminal: Terminal) => void;
  connectionOf: (id: string) => ConnectionState | undefined;
  onRename: (terminal: Terminal) => void;
  onDuplicate: (terminal: Terminal) => void;
  canDuplicate: (terminal: Terminal) => boolean;
  pending: boolean;
}

export function TerminalList({
  terminals,
  activeId,
  onClose,
  connectionOf,
  onRename,
  onDuplicate,
  canDuplicate,
  pending,
}: TerminalListProps) {
  const [params] = useSearchParams();
  const [status, setStatus] = useState("all");
  const [menuId, setMenuId] = useState<string | null>(null);
  const shown = filterTerminals(terminals, "", status);
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="space-y-2 px-3 pb-3 border-b border-outline-variant">
        <fieldset className="flex items-center gap-1" aria-label="Filter terminals">
          {(["all", "running", "exited"] as const).map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`terminal-filter-${value}`}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
              className={cn(
                "flex-1 min-h-11 sm:min-h-8 rounded px-1 text-xs",
                status === value
                  ? "bg-surface-highest text-on-surface"
                  : "text-on-surface-variant hover:bg-surface",
              )}
            >
              {value === "all" ? "All" : value === "running" ? "Running" : "Exited"}{" "}
              <span className="tabular-nums">
                {value === "all"
                  ? terminals.length
                  : terminals.filter((item) => item.status === value).length}
              </span>
            </button>
          ))}
        </fieldset>
      </div>
      <div data-testid="terminals-list" className="flex-1 min-h-0 overflow-y-auto py-1">
        {shown.length === 0 && (
          <p data-testid="terminal-search-empty" className="p-4 text-sm text-on-surface-variant">
            No sessions in this filter.
          </p>
        )}
        {shown.map((terminal) => {
          const active = terminal.id === activeId;
          const { label, icon: Icon } = TERMINAL_KINDS[terminal.kind];
          const tail = cwdTail(terminal.cwd);
          const state = terminalStatus(terminal, connectionOf(terminal.id));
          const disconnected = state === "Disconnected" || state === "Reconnecting";
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
                  disconnected
                    ? "bg-warning"
                    : terminal.status === "running"
                      ? "bg-secondary"
                      : "bg-outline",
                )}
                title={state}
              />
              <Link
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenuId(terminal.id);
                }}
                to={{ pathname: `/terminals/${terminal.id}`, search: next.toString() }}
                title={`${terminal.name}\n${terminal.cwd ?? ""}\n${state}`}
                aria-current={active ? "page" : undefined}
                className="flex-1 min-w-0"
                onKeyDown={(event) => {
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    setMenuId(terminal.id);
                  }
                }}
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
                  <span
                    data-testid="terminal-item-state"
                    className={cn(
                      "ml-auto truncate",
                      disconnected ? "text-warning" : "text-on-surface-variant",
                    )}
                  >
                    {state}
                  </span>
                  {terminal.host && (
                    <span
                      data-testid="terminal-item-host"
                      className="shrink-0 normal-case tracking-normal text-primary"
                    >
                      @{terminal.host}
                    </span>
                  )}
                </div>
                {tail && (
                  <div
                    className="truncate text-xs text-on-surface-variant"
                    title={terminal.cwd ?? undefined}
                  >
                    {tail}
                  </div>
                )}
              </Link>
              <TerminalActions
                terminal={terminal}
                open={menuId === terminal.id}
                onOpenChange={(open) => setMenuId(open ? terminal.id : null)}
                onRename={onRename}
                onDuplicate={onDuplicate}
                onClose={onClose}
                canDuplicate={canDuplicate(terminal)}
                pending={pending}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
