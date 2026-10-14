import { useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { LiveSessions } from "@/components/LiveSessions";
import { LoggedSessions } from "@/components/LoggedSessions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjectScope } from "@/hooks/useProjectScope";

type SessionsTab = "agent" | "orc";

const TAB_TRIGGER = `font-label text-xs font-medium px-4 py-3 rounded-md
  data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none
  text-outline hover:text-on-surface-variant`;

export default function Sessions({ projectId: savedProjectId }: { projectId: string }) {
  const projectId = useProjectScope(savedProjectId);
  const [searchParams, setSearchParams] = useSearchParams();
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const tab: SessionsTab = searchParams.get("tab") === "orc" || sessionId ? "orc" : "agent";
  const pendingTab = useRef(tab);
  pendingTab.current = tab;

  function setTab(value: SessionsTab): void {
    if (pendingTab.current === value) return;
    pendingTab.current = value;
    if (sessionId && value === "agent") {
      const next = new URLSearchParams(searchParams);
      next.delete("tab");
      navigate({ pathname: "/sessions", search: next.toString() });
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "agent") next.delete("tab");
        else next.set("tab", value);
        return next;
      },
      { replace: false },
    );
  }

  return (
    <div>
      <ViewHeader title="Sessions" />

      <Tabs value={tab} onValueChange={(v) => setTab(v as SessionsTab)} className="mb-4">
        <TabsList className="bg-surface-highest border border-surface-highest gap-1 h-auto p-1 flex-wrap">
          <TabsTrigger data-testid="sessions-agent-tab" value="agent" className={TAB_TRIGGER}>
            Agent sessions
          </TabsTrigger>
          <TabsTrigger data-testid="sessions-orc-tab" value="orc" className={TAB_TRIGGER}>
            ORC sessions
          </TabsTrigger>
        </TabsList>
        <TabsContent value={tab}>
          {tab === "agent" ? (
            <LiveSessions key={projectId} projectId={projectId} />
          ) : (
            <LoggedSessions key={projectId} projectId={projectId} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
