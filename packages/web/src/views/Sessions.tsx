import { ArchivedSessions } from "@/components/ArchivedSessions";
import { LiveSessions } from "@/components/LiveSessions";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjectScope } from "@/hooks/useProjectScope";

export default function Sessions({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  return (
    <div>
      <ViewHeader title="Sessions" />
      <LiveSessions key={projectId} projectId={projectId} />
      <ArchivedSessions key={`archive-${projectId}`} projectId={projectId} />
    </div>
  );
}
