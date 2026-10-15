import * as Dialog from "@radix-ui/react-dialog";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ChatPanel } from "@/components/ChatPanel";
import { WorkspaceHeader } from "@/components/WorkspaceHeader";
import { WorkspaceSidebar as Sidebar } from "@/components/WorkspaceSidebar";
import { ChatProvider } from "@/hooks/useChat";
import { BREAKPOINTS } from "@/hooks/useMediaQuery";
import { useProjects } from "@/hooks/useProjects";
import { TerminalsProvider } from "@/lib/terminals";
import { cn } from "@/lib/utils";

const Packages = lazy(() => import("@/views/PackageCatalog"));

const Wiki = lazy(() => import("@/views/Wiki"));

const Agents = lazy(() => import("@/views/Agents"));

const Dashboard = lazy(() => import("@/views/Dashboard"));

const Jobs = lazy(() => import("@/views/Jobs"));

const Knowledge = lazy(() => import("@/views/Knowledge"));

const Projects = lazy(() => import("@/views/Projects"));

const Rules = lazy(() => import("@/views/Rules"));

const Sessions = lazy(() => import("@/views/Sessions"));
const Audit = lazy(() => import("@/views/Audit"));

const Settings = lazy(() => import("@/views/Settings"));

const Skills = lazy(() => import("@/views/Skills"));

const Tasks = lazy(() => import("@/views/Tasks"));

const Terminals = lazy(() => import("@/views/Terminals"));

function LegacyAgentsRedirect() {
  const { agentId } = useParams();
  const { search, hash } = useLocation();
  return (
    <Navigate
      replace
      to={{
        pathname: agentId ? `/packages/agents/${encodeURIComponent(agentId)}` : "/packages/agents",
        search,
        hash,
      }}
    />
  );
}

function LegacyActivityRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: "/activity", search, hash }} />;
}

function DefaultWorkspaceRedirect() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: "/activity", search, hash }} />;
}

const STORAGE_KEY = "orc_selected_project";

function LegacyMemoriesRedirect() {
  const { memoryId } = useParams();
  const { search, hash } = useLocation();
  const query = new URLSearchParams(search);
  query.delete("tab");
  const path = memoryId
    ? `/knowledge/memories/${encodeURIComponent(memoryId)}`
    : "/knowledge/memories";
  return <Navigate replace to={{ pathname: path, search: query.toString(), hash }} />;
}

function LegacyKnowledgeRedirect() {
  const { pathname, search, hash } = useLocation();
  const query = new URLSearchParams(search);
  const tab = query.get("tab");
  let path = "/knowledge/wiki";
  if (
    pathname === "/wiki" ||
    query.has("page") ||
    tab === "pages" ||
    tab === "changes" ||
    tab === "audit"
  ) {
    if (tab === "changes" || tab === "audit") {
      query.set("history", "1");
      if (query.has("page")) query.set("historyPage", query.get("page") as string);
      if (tab === "audit") query.set("audit", "1");
    }
  } else if (tab === "memories") path = "/knowledge/memories";
  else if (
    tab === "documents" ||
    tab === "search" ||
    tab === "collections" ||
    query.has("document") ||
    query.has("documentQuery") ||
    query.has("collection")
  ) {
    path = "/knowledge/base";
    if (tab === "collections") query.set("view", "collections");
  }
  query.delete("tab");
  return <Navigate replace to={{ pathname: path, search: query.toString(), hash }} />;
}

export default function App() {
  const [savedProjectId, setSavedProjectId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const projectId = searchParams.get("project") ?? savedProjectId;
  const chatRequested = searchParams.get("chat") === "open";
  function setChatVisible(open: boolean): void {
    const next = new URLSearchParams(window.location.search);
    if (open) next.set("chat", "open");
    else next.delete("chat");
    if (next.toString() === new URLSearchParams(window.location.search).toString()) return;
    navigate({ search: next.toString(), hash: window.location.hash });
  }
  function setProjectId(nextProjectId: string): void {
    setSavedProjectId(nextProjectId);
    const next = new URLSearchParams(window.location.search);
    next.set("project", nextProjectId);
    if (next.toString() === new URLSearchParams(window.location.search).toString()) return;
    navigate({ search: next.toString(), hash: window.location.hash });
  }

  // Default to collapsed rail on tablet (<lg), expanded on desktop (≥lg).
  // This is a one-shot initialization - after mount the user owns the toggle.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < BREAKPOINTS.lg;
  });

  const [chatOpen, setChatOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const navButtonRef = useRef<HTMLButtonElement>(null);
  const chatButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const desktop = window.matchMedia(`(min-width: ${BREAKPOINTS.md}px)`);
    const syncResponsiveChat = () => {
      if (desktop.matches) setMobileNavOpen(false);
      setMobileChatOpen(chatRequested && !desktop.matches);
      setChatOpen(chatRequested && desktop.matches);
    };
    syncResponsiveChat();
    desktop.addEventListener("change", syncResponsiveChat);
    return () => desktop.removeEventListener("change", syncResponsiveChat);
  }, [chatRequested]);

  const { pathname } = useLocation();
  const fullBleed = pathname === "/terminals" || pathname.startsWith("/terminals/");

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, savedProjectId);
    } catch {
      /* Project scope remains usable when storage is unavailable. */
    }
  }, [savedProjectId]);

  const { data: selectableProjects } = useProjects({ status: "active" });
  useEffect(() => {
    if (!selectableProjects) return;
    if (savedProjectId === "all" || savedProjectId === "unassigned") return;
    if (selectableProjects.some((p) => p.id === savedProjectId)) return;
    setSavedProjectId("all");
  }, [selectableProjects, savedProjectId]);

  useEffect(() => {
    if (searchParams.has("project") || !selectableProjects) return;
    if (
      savedProjectId !== "all" &&
      savedProjectId !== "unassigned" &&
      !selectableProjects.some((project) => project.id === savedProjectId)
    )
      return;
    const next = new URLSearchParams(window.location.search);
    if (next.has("project")) return;
    next.set("project", savedProjectId);
    navigate(
      { pathname: window.location.pathname, search: next.toString(), hash: window.location.hash },
      { replace: true },
    );
  }, [searchParams, selectableProjects, savedProjectId, navigate]);

  return (
    <TerminalsProvider>
      <ChatProvider>
        <div className="h-dvh bg-background flex flex-col overflow-hidden">
          {/* Mobile top bar - only rendered under md; also gated by `md:hidden` in the
          component itself so the CSS-driven layout works even before JS hydration. */}
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

            {/* Main content - the only element that owns vertical scroll for page content. */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <WorkspaceHeader
                onShowChat={() => setChatVisible(true)}
                onProjectChange={setProjectId}
                navButtonRef={navButtonRef}
                chatButtonRef={chatButtonRef}
                projectId={projectId}
                onOpenNav={() => setMobileNavOpen(true)}
                onOpenChat={() => setChatVisible(!chatRequested)}
              />
              <main
                className={cn(
                  "relative flex-1 min-w-0 min-h-0",
                  fullBleed ? "overflow-hidden" : "overflow-y-auto",
                )}
              >
                <div
                  className={cn(
                    fullBleed
                      ? "absolute inset-0 flex"
                      : "p-4 md:p-6 lg:p-8 min-h-full flex flex-col",
                  )}
                >
                  <Suspense
                    fallback={
                      <div role="status" className="p-6 text-sm text-outline">
                        Loading workspace…
                      </div>
                    }
                  >
                    <Routes>
                      <Route path="/" element={<DefaultWorkspaceRedirect />} />
                      <Route path="/activity" element={<Dashboard projectId={projectId} />} />
                      <Route path="/overview" element={<LegacyActivityRedirect />} />
                      <Route path="/dashboard" element={<LegacyActivityRedirect />} />
                      <Route path="/tasks" element={<Tasks projectId={projectId} />} />
                      <Route path="/tasks/:taskId" element={<Tasks projectId={projectId} />} />
                      <Route path="/terminals" element={<Terminals />} />
                      <Route path="/terminals/:terminalId" element={<Terminals />} />
                      <Route path="/jobs" element={<Jobs projectId={projectId} />} />
                      <Route path="/jobs/:jobId" element={<Jobs projectId={projectId} />} />
                      <Route path="/sessions" element={<Sessions projectId={projectId} />} />
                      <Route path="/audit" element={<Audit projectId={projectId} />} />
                      <Route path="/audit/:sessionId" element={<Audit projectId={projectId} />} />
                      <Route path="/memories" element={<LegacyMemoriesRedirect />} />
                      <Route path="/memories/:memoryId" element={<LegacyMemoriesRedirect />} />
                      <Route path="/projects" element={<Projects />} />
                      <Route path="/projects/:projectId" element={<Projects />} />
                      <Route path="/wiki" element={<LegacyKnowledgeRedirect />} />
                      <Route path="/knowledge" element={<LegacyKnowledgeRedirect />} />
                      <Route path="/knowledge/wiki" element={<Wiki projectId={projectId} />} />
                      <Route path="/knowledge/base" element={<Knowledge projectId={projectId} />} />
                      <Route
                        path="/knowledge/memories"
                        element={<Knowledge projectId={projectId} />}
                      />
                      <Route
                        path="/knowledge/memories/:memoryId"
                        element={<Knowledge projectId={projectId} />}
                      />
                      <Route path="/skills" element={<Skills projectId={projectId} />} />
                      <Route path="/skills/:skillName" element={<Skills projectId={projectId} />} />
                      <Route path="/agents" element={<LegacyAgentsRedirect />} />
                      <Route path="/agents/:agentId" element={<LegacyAgentsRedirect />} />
                      <Route path="/packages" element={<Packages />} />
                      <Route path="/packages/item" element={<Packages />} />
                      <Route path="/packages/item/:packageName" element={<Packages />} />
                      <Route path="/packages/agents" element={<Agents />} />
                      <Route path="/packages/agents/:agentId" element={<Agents />} />
                      <Route path="/settings" element={<Settings />} />
                      <Route path="/rules" element={<Rules />} />
                      <Route path="*" element={<Navigate to="/activity" replace />} />
                    </Routes>
                  </Suspense>
                </div>
              </main>
            </div>

            {/* Chat rail/panel: visible on md+. Mobile uses the FAB + sheet below. */}
            <div className={cn("hidden md:flex", !chatOpen && "md:hidden")}>
              <ChatPanel open={chatOpen} onToggle={() => setChatVisible(false)} />
            </div>
          </div>

          {/* Mobile nav drawer (Radix Dialog, slides in from the left). */}
          <Dialog.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="md:hidden fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
              <Dialog.Content
                data-testid="mobile-nav-drawer"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (window.innerWidth < BREAKPOINTS.md) navButtonRef.current?.focus();
                  else chatButtonRef.current?.focus();
                }}
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
          <Dialog.Root open={mobileChatOpen} onOpenChange={setChatVisible}>
            <Dialog.Portal>
              <Dialog.Overlay className="md:hidden fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
              <Dialog.Content
                data-testid="mobile-chat-sheet"
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (!chatRequested) chatButtonRef.current?.focus();
                }}
                className="md:hidden fixed inset-0 z-50 flex flex-col data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom"
              >
                <Dialog.Title className="sr-only">Chat</Dialog.Title>
                <Dialog.Description className="sr-only">
                  Chat with your configured agent
                </Dialog.Description>
                <ChatPanel
                  open
                  onToggle={() => setChatVisible(false)}
                  embedded
                  onClose={() => setChatVisible(false)}
                />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </ChatProvider>
    </TerminalsProvider>
  );
}
