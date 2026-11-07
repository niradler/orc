import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { AuditEvents } from "@/components/AuditEvents";
import { LoggedSessions } from "@/components/LoggedSessions";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjectScope } from "@/hooks/useProjectScope";

export default function Audit({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const location = useLocation();
  const legacyLink =
    location.pathname.startsWith("/audit/") ||
    location.hash === "#records" ||
    new URLSearchParams(location.search).has("agent") ||
    new URLSearchParams(location.search).has("order");
  const [historyOpen, setHistoryOpen] = useState(legacyLink);
  useEffect(() => {
    if (legacyLink) setHistoryOpen(true);
  }, [legacyLink]);
  return (
    <div>
      <ViewHeader
        title="Audit"
        help="Meaningful workspace changes, request and job outcomes, and notification history. Events remain until the configured audit retention expires."
      />
      <AuditEvents key={projectId} projectId={projectId} />
      <details
        open={historyOpen}
        onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
        data-testid="audit-session-history"
        className="mt-6 border-t border-border pt-3"
      >
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium md:min-h-8">
          Logged session history
        </summary>
        <LoggedSessions key={projectId} projectId={projectId} />
      </details>
    </div>
  );
}
