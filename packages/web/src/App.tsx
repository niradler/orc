import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
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

const STORAGE_KEY = "orc_selected_project";

export default function App() {
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
        projectId={projectId}
        onProjectChange={setProjectId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      <main
        className={`flex-1 overflow-y-auto transition-all duration-200 ${sidebarCollapsed ? "ml-14" : "ml-64"} ${chatOpen ? "mr-80" : "mr-12"}`}
      >
        <div className="p-8 max-w-[1200px]">
          <Routes>
            <Route path="/" element={<Navigate to="/tasks" replace />} />
            <Route path="/dashboard" element={<Dashboard projectId={projectId} />} />
            <Route path="/tasks" element={<Tasks projectId={projectId} />} />
            <Route path="/tasks/:taskId" element={<Tasks projectId={projectId} />} />
            <Route path="/jobs" element={<Jobs projectId={projectId} />} />
            <Route path="/jobs/:jobId" element={<Jobs projectId={projectId} />} />
            <Route path="/sessions" element={<Sessions projectId={projectId} />} />
            <Route path="/sessions/:sessionId" element={<Sessions projectId={projectId} />} />
            <Route path="/memories" element={<Memories projectId={projectId} />} />
            <Route path="/memories/:memoryId" element={<Memories projectId={projectId} />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<Projects />} />
            <Route path="/knowledge" element={<Knowledge projectId={projectId} />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/skills/:skillName" element={<Skills />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/tasks" replace />} />
          </Routes>
        </div>
      </main>
      <ChatPanel open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
    </div>
  );
}
