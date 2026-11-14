import { SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionContext } from "@/components/SessionHome";
import { terminalStatus } from "@/lib/terminal-presentation";
import { useTerminals } from "@/lib/terminals";

/**
 * One header for the chat's terminal drawer and the phone terminal page: the
 * terminal's name, live connection state and folder/host, with the caller's
 * own actions on the right.
 */
export function SessionTerminalHeader({
  context,
  children,
}: {
  context: SessionContext;
  children?: ReactNode;
}) {
  const { connectionOf } = useTerminals();
  // The drawer and the phone page render the folder's shell, while the chat view
  // itself may point at another terminal; name the one actually on screen.
  const terminal = context.shell ?? context.terminal;
  const status = terminal ? terminalStatus(terminal, connectionOf(terminal.id)) : null;
  const location = `${context.cwd ?? "No folder"}${context.host ? ` · ${context.host}` : ""}`;
  return (
    <header
      data-testid="session-terminal-header"
      data-chat-gesture-header
      className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-2"
    >
      <SquareTerminal size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2
            data-testid="session-terminal-title"
            className="truncate text-sm font-medium leading-tight"
          >
            {terminal?.name ?? "Terminal"}
          </h2>
          {status && (
            <span
              data-testid="session-terminal-status"
              className="shrink-0 text-xs leading-tight text-muted-foreground"
            >
              {status}
            </span>
          )}
        </div>
        <p
          data-testid="session-terminal-location"
          className="truncate text-xs leading-tight text-muted-foreground"
          title={location}
        >
          {location}
        </p>
      </div>
      {children}
    </header>
  );
}
