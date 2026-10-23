import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api, type Terminal } from "@/api/client";

export function TerminalCheckout({ terminal, paneId }: { terminal: Terminal; paneId?: string }) {
  const [, setParams] = useSearchParams();
  const status = useQuery({
    queryKey: ["git", terminal.id, "status"],
    queryFn: () => api.git.status(terminal.id),
  });
  if (status.error)
    return (
      <button
        type="button"
        onClick={() => void status.refetch()}
        className="min-h-8 text-xs text-warning"
        title={status.error.message}
      >
        Git unavailable · Retry
      </button>
    );
  if (!status.data?.root) return null;
  return (
    <button
      type="button"
      data-testid={paneId ? "pane-checkout" : "terminal-checkout"}
      title="Review checkout changes"
      onClick={() =>
        setParams((current) => {
          const next = new URLSearchParams(current);
          next.set("view", "git");
          if (paneId) next.set("pane", paneId);
          next.set("paneTerminal", terminal.id);
          next.delete("file");
          return next;
        })
      }
      className="flex items-center gap-2 min-h-6 sm:min-h-8 min-w-0 max-w-full text-xs text-on-surface-variant hover:text-on-surface"
    >
      <GitBranch size={13} className="shrink-0" />
      <span className="truncate">{status.data.branch ?? "Detached HEAD"}</span>
      <span className="shrink-0">
        {status.data.files.length ? `${status.data.files.length} changed` : "Clean"}
      </span>
    </button>
  );
}
