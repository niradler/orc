import { useEffect, useState } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { Sidebar } from "@/components/Sidebar";
import Dashboard from "@/views/Dashboard";
import Jobs from "@/views/Jobs";
import Knowledge from "@/views/Knowledge";
import Memories from "@/views/Memories";
import Projects from "@/views/Projects";
import Sessions from "@/views/Sessions";
import Settings from "@/views/Settings";
import Skills from "@/views/Skills";
import Tasks from "@/views/Tasks";

export type View =
  | "dashboard"
  | "tasks"
  | "jobs"
  | "memories"
  | "projects"
  | "sessions"
  | "knowledge"
  | "skills"
  | "settings";

const STORAGE_KEY = "orc_selected_project";

export default function App() {
  const [view, setView] = useState<View>("tasks");
  const [projectId, setProjectId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? "all",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, projectId);
  }, [projectId]);

  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar
        active={view}
        onNavigate={setView}
        projectId={projectId}
        onProjectChange={setProjectId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      <main
        className={`flex-1 overflow-y-auto transition-all duration-200 ${sidebarCollapsed ? "ml-14" : "ml-64"} ${chatOpen ? "mr-80" : "mr-12"}`}
      >
        <div className="p-8 max-w-[1200px]">
          {view === "dashboard" && <Dashboard onNavigate={setView} projectId={projectId} />}
          {view === "tasks" && <Tasks projectId={projectId} />}
          {view === "jobs" && <Jobs projectId={projectId} />}
          {view === "memories" && <Memories projectId={projectId} />}
          {view === "projects" && <Projects />}
          {view === "sessions" && <Sessions projectId={projectId} />}
          {view === "knowledge" && <Knowledge projectId={projectId} />}
          {view === "skills" && <Skills />}
          {view === "settings" && <Settings />}
        </div>
      </main>
      <ChatPanel open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
    </div>
  );
}
