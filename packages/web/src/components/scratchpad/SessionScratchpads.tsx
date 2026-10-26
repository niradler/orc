import { Link, useSearchParams } from "react-router-dom";
import type { LiveSession } from "@/api/client";
import { useScratchpads } from "@/hooks/useScratchpads";
import { scopedSessionPath } from "@/lib/live-sessions";
import { KIND_META } from "@/lib/scratchpad-kinds";
import { scratchpadPath } from "@/lib/scratchpad-routes";

/** Pads an agent linked to this session, as quick links in the session header. */
export function SessionScratchpads({ session }: { session: LiveSession }) {
  const [params] = useSearchParams();
  const { data } = useScratchpads(
    { session_id: session.session_id ?? undefined, limit: 20 },
    { enabled: Boolean(session.session_id) },
  );
  const pads = data?.scratchpads ?? [];
  if (pads.length === 0) return null;
  const scope = params.get("project") ?? session.project_id;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="session-scratchpads"
    >
      <span className="text-on-surface-variant">scratchpads</span>
      {pads.map((pad) => {
        const Icon = KIND_META[pad.kind].icon;
        return (
          <Link
            key={pad.id}
            to={scopedSessionPath(scratchpadPath(pad.id), scope)}
            data-testid="session-scratchpad-link"
            className="inline-flex max-w-56 items-center gap-1 text-primary hover:underline"
            title={pad.title}
          >
            <Icon size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{pad.title}</span>
          </Link>
        );
      })}
    </div>
  );
}
