import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ChatPanel } from "@/components/ChatPanel";
import { MobileChatFab } from "@/components/MobileChatFab";
import { MobileTopBar } from "@/components/MobileTopBar";
import { Sidebar } from "@/components/Sidebar";
import { BREAKPOINTS } from "@/hooks/useMediaQuery";
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

  // Default to collapsed rail on tablet (<lg), expanded on desktop (≥lg).
  // This is a one-shot initialization — after mount the user owns the toggle.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < BREAKPOINTS.lg;
  });

  const [chatOpen, setChatOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, projectId);
  }, [projectId]);

  return (
    <div className="h-dvh bg-background flex flex-col overflow-hidden">
      {/* Mobile top bar — only rendered under md; also gated by `md:hidden` in the
          component itself so the CSS-driven layout works even before JS hydration. */}
      <MobileTopBar onOpenNav={() => setMobileNavOpen(true)} />

      <div className="flex-1 min-h-0 flex">
        {/* Sidebar: visible on md+. On mobile we instead render a Dialog drawer below. */}
        <div className="hidden md:flex">
          <Sidebar
            projectId={projectId}
            onProjectChange={setProjectId}
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((v) => !v)}
          />
        </div>

        {/* Main content — the only element that owns vertical scroll for page content. */}
        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto">
          <div className="p-4 md:p-6 lg:p-8 min-h-full flex flex-col max-w-[1200px]">
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

        {/* Chat rail/panel: visible on md+. Mobile uses the FAB + sheet below. */}
        <div className="hidden md:flex">
          <ChatPanel open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
        </div>
      </div>

      {/* Mobile nav drawer (Radix Dialog, slides in from the left). */}
      <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="md:hidden fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content
            data-testid="mobile-nav-drawer"
            className="md:hidden fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] bg-background border-r border-surface-highest shadow-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
          >
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <Dialog.Description className="sr-only">
              Main navigation and project selector
            </Dialog.Description>
            <Sidebar
              projectId={projectId}
              onProjectChange={setProjectId}
              collapsed={false}
              onToggle={() => {}}
              embedded
              onNavigate={() => setMobileNavOpen(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Mobile chat sheet (full-screen on mobile). */}
      <Dialog.Root open={mobileChatOpen} onOpenChange={setMobileChatOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="md:hidden fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content
            data-testid="mobile-chat-sheet"
            className="md:hidden fixed inset-0 z-50 flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom"
          >
            <Dialog.Title className="sr-only">Chat</Dialog.Title>
            <Dialog.Description className="sr-only">
              Chat with your configured agent
            </Dialog.Description>
            <ChatPanel
              open
              onToggle={() => setMobileChatOpen(false)}
              embedded
              onClose={() => setMobileChatOpen(false)}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <MobileChatFab onClick={() => setMobileChatOpen(true)} />
    </div>
  );
}
