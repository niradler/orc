import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import Dashboard from "@/views/Dashboard";
import Jobs from "@/views/Jobs";
import Knowledge from "@/views/Knowledge";
import Memories from "@/views/Memories";
import Projects from "@/views/Projects";
import Sessions from "@/views/Sessions";
import Settings from "@/views/Settings";
import Tasks from "@/views/Tasks";

export type View =
  | "dashboard"
  | "tasks"
  | "jobs"
  | "memories"
  | "projects"
  | "sessions"
  | "knowledge"
  | "settings";

export default function App() {
  const [view, setView] = useState<View>("tasks");

  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar active={view} onNavigate={setView} />
      <main className="ml-64 flex-1 overflow-y-auto">
        <div className="p-8 max-w-[1200px]">
          {view === "dashboard" && <Dashboard onNavigate={setView} />}
          {view === "tasks" && <Tasks />}
          {view === "jobs" && <Jobs />}
          {view === "memories" && <Memories />}
          {view === "projects" && <Projects />}
          {view === "sessions" && <Sessions />}
          {view === "knowledge" && <Knowledge />}
          {view === "settings" && <Settings />}
        </div>
      </main>
    </div>
  );
}
