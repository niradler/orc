import type { Terminal } from "@/api/client";

// A link that resolves to whichever terminal is running a live session. Unlike
// /terminals/:id it still works after that terminal was closed and reopened.
export function sessionTerminalPath(liveSessionId: string): string {
  return `/terminals?session=${encodeURIComponent(liveSessionId)}`;
}

export function terminalPath(terminalId: string): string {
  return `/terminals/${terminalId}`;
}

export function runningTerminalForSession(
  terminals: readonly Terminal[],
  liveSessionId: string,
): Terminal | undefined {
  return terminals.find((t) => t.live_session_id === liveSessionId && t.status === "running");
}

// The link worth sharing for a terminal: by session when it resumed one, else by id.
export function shareablePath(terminal: Pick<Terminal, "id" | "live_session_id">): string {
  return terminal.live_session_id
    ? sessionTerminalPath(terminal.live_session_id)
    : terminalPath(terminal.id);
}

export function absoluteUrl(path: string, origin: string = window.location.origin): string {
  return `${origin}${path}`;
}
