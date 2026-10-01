import { useSearchParams } from "react-router-dom";
import { LiveSessions } from "@/components/LiveSessions";
import { LoggedSessions } from "@/components/LoggedSessions";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjectScope } from "@/hooks/useProjectScope";

type SessionsTab = "agent" | "orc";

const TAB_TRIGGER = `font-label text-[11px] uppercase tracking-widest px-4 py-2 rounded-none
  data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
  text-outline hover:text-on-surface-variant`;

export default function Sessions({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: SessionsTab = searchParams.get("tab") === "orc" ? "orc" : "agent";

  function setTab(value: SessionsTab): void {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "agent") next.delete("tab");
        else next.set("tab", value);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <div>
      <ViewHeader title="Sessions" />

      <Tabs value={tab} onValueChange={(v) => setTab(v as SessionsTab)} className="mb-4">
        <TabsList className="bg-surface-highest border border-surface-highest gap-0 h-auto p-0">
          <TabsTrigger data-testid="sessions-agent-tab" value="agent" className={TAB_TRIGGER}>
            Agent sessions
          </TabsTrigger>
          <TabsTrigger data-testid="sessions-orc-tab" value="orc" className={TAB_TRIGGER}>
            ORC sessions
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "agent" ? (
        <LiveSessions key={projectId} projectId={projectId} />
      ) : (
        <LoggedSessions key={projectId} projectId={projectId} />
      )}
    </div>
  );
}
