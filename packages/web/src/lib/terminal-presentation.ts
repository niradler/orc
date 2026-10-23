import type { Terminal } from "@/api/client";
import type { ConnectionState } from "@/lib/terminal-runtime";

export function terminalStatus(terminal: Terminal, connection?: ConnectionState): string {
  if (terminal.status === "exited")
    return terminal.exit_code == null ? "Exited" : `Exited (${terminal.exit_code})`;
  if (connection === "connecting") return "Connecting";
  if (connection === "reconnecting") return "Reconnecting";
  if (connection === "closed") return "Disconnected";
  return "Running";
}

export function filterTerminals(terminals: Terminal[], query: string, status: string): Terminal[] {
  const search = query.trim().toLowerCase();
  return terminals.filter(
    (terminal) =>
      (status === "all" || terminal.status === status) &&
      [terminal.name, terminal.cwd, terminal.kind, terminal.host].some((value) =>
        value?.toLowerCase().includes(search),
      ),
  );
}
