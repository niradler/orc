import { Eye, EyeOff, Pencil } from "lucide-react";
import { useState } from "react";
import type { LiveSession } from "@/api/client";
import { RenameSession } from "@/components/RenameSession";
import { SessionTaskLink } from "@/components/SessionTaskLink";
import { SessionScratchpads } from "@/components/scratchpad/SessionScratchpads";
import { useUpdateLiveSession } from "@/hooks/useSessions";

const ACTION =
  "inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2 py-1 text-xs text-primary hover:bg-surface-highest disabled:opacity-50";

export function SessionActions({ session }: { session: LiveSession }) {
  const [renaming, setRenaming] = useState(false);
  const update = useUpdateLiveSession();
  return (
    <>
      <SessionTaskLink session={session} linkTestId="detail-open-task" />
      <button
        type="button"
        data-testid="rename-session"
        disabled={update.isPending}
        onClick={() => setRenaming(true)}
        className={ACTION}
      >
        <Pencil size={13} aria-hidden />
        Rename
      </button>
      <button
        type="button"
        data-testid={session.hidden ? "unhide-session" : "hide-session"}
        disabled={update.isPending}
        title={
          session.hidden
            ? "Show this session in the list again"
            : "Keep this session but leave it out of the list"
        }
        onClick={() => update.mutate({ id: session.id, hidden: !session.hidden })}
        className={ACTION}
      >
        {session.hidden ? <Eye size={13} aria-hidden /> : <EyeOff size={13} aria-hidden />}
        {session.hidden ? "Show in list" : "Hide from list"}
      </button>
      {session.hidden && (
        <span data-testid="detail-session-hidden" className="text-outline">
          Hidden from list
        </span>
      )}
      <SessionScratchpads session={session} />
      <RenameSession session={session} open={renaming} onClose={() => setRenaming(false)} />
    </>
  );
}
