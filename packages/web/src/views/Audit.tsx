import { LoggedSessions } from "@/components/LoggedSessions";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjectScope } from "@/hooks/useProjectScope";

export default function Audit({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  return (
    <div>
      <ViewHeader title="Audit" />
      <p className="mb-4 text-sm text-outline">
        Recorded summaries and events. Open Sessions to read conversations or resume a coding agent.
      </p>
      <LoggedSessions key={projectId} projectId={projectId} />
    </div>
  );
}
