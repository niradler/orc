import { SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { LiveSession } from "@/api/client";
import { resumeCommand } from "@/lib/live-sessions";
import { useTerminals } from "@/lib/terminals";

export function OpenTerminalResume({ session }: { session: LiveSession }) {
  const { openLiveSession } = useTerminals();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!resumeCommand(session)) return null;
  return (
    <button
      type="button"
      data-testid="open-terminal-resume"
      disabled={pending}
      title={error ?? "Resume in a terminal"}
      className={
        error
          ? "inline-flex items-center gap-1 font-label text-[11px] uppercase tracking-widest text-error"
          : "inline-flex items-center gap-1 font-label text-[11px] uppercase tracking-widest text-primary hover:text-on-surface disabled:opacity-50"
      }
      onClick={(e) => {
        e.stopPropagation();
        setPending(true);
        setError(null);
        openLiveSession(session)
          .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed"))
          .finally(() => setPending(false));
      }}
    >
      <SquareTerminal className="h-3 w-3" />
      {error ? "Failed" : pending ? "Opening" : "Terminal"}
    </button>
  );
}
